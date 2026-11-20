/**
 * "Save to vault" for a remote image (#w6i6e6u7): download an http(s) image
 * into `attachments/` (D18).
 *
 * The URL comes from note content, so this is a server-side fetch of an
 * untrusted address. Guards:
 * - **Schemes:** only http and https, on every redirect hop.
 * - **SSRF:** the host must resolve only to public addresses. The check runs
 *   inside the socket's own DNS lookup, so the address that was checked is
 *   the one connected to (no DNS-rebinding window). IP literals in any form
 *   (`2130706433`, `0x7f.1`, `[::ffff:127.0.0.1]`) are normalised by the URL
 *   parser and checked too. Redirects are followed by hand (max 5), each hop
 *   checked again.
 * - **Content:** `Content-Type` must be `image/*` **and** the bytes must sniff
 *   as a raster image (PNG, JPEG, GIF, WebP, AVIF, BMP, ICO). SVG is refused:
 *   it can carry script. No `Accept-Encoding`, nothing is decompressed (no
 *   gzip bombs; a compressed body fails the sniff).
 * - **Size:** 25 MB (D18), enforced while streaming.
 * - **Time:** 10 s for the whole download, redirects included.
 */
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import type { Attachment } from "@gumply/core";
import { MAX_ATTACHMENT_BYTES, saveAttachment, sanitizeAttachmentName } from "./attachments.js";
import { VaultError, badRequest, payloadTooLarge, unprocessable } from "./errors.js";

export const IMPORT_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;

export interface ImportOptions {
  timeoutMs?: number;
  maxBytes?: number;
  /**
   * `host:port` pairs exempt from the private-address check. Tests only (the
   * e2e stub server on localhost); set from `GUMPLY_IMPORT_ALLOW`.
   */
  allow?: ReadonlySet<string>;
  /** DNS lookup, injectable for tests. */
  lookup?: typeof dnsLookup;
}

// ---------- Address classification ----------

const BLOCKED = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
] as const) {
  BLOCKED.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128],
  ["64:ff9b::", 96], // NAT64 (embeds IPv4)
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const) {
  BLOCKED.addSubnet(network, prefix, "ipv6");
}

/** IPv4 inside an IPv4-mapped/compatible IPv6 address (`::ffff:7f00:1`). */
function embeddedIPv4(address: string): string | null {
  const lower = address.toLowerCase();
  const dotted = /^(?:::ffff:|::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (dotted) return dotted[1]!;
  const hex = /^(?:::ffff:|::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (!hex) return null;
  const high = parseInt(hex[1]!, 16);
  const low = parseInt(hex[2]!, 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

/** True for loopback, private, link-local and other non-public addresses. */
export function isPrivateAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "");
  const family = isIP(bare);
  if (family === 0) return true; // Not an IP: never "safe".
  if (family === 6) {
    const v4 = embeddedIPv4(bare);
    if (v4) return isPrivateAddress(v4);
    return BLOCKED.check(bare, "ipv6");
  }
  return BLOCKED.check(bare, "ipv4");
}

// ---------- Errors (all shown to the user as-is) ----------

const refused = (message: string) => badRequest(message);
const failed = (message: string) => unprocessable(message);

// ---------- Content sniffing ----------

const SNIFFERS: Array<{ ext: string; test: (b: Uint8Array) => boolean }> = [
  { ext: "png", test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { ext: "jpg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: "gif", test: (b) => ascii(b, 0, 4) === "GIF8" },
  { ext: "webp", test: (b) => ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP" },
  {
    ext: "avif",
    test: (b) => ascii(b, 4, 8) === "ftyp" && ["avif", "avis"].includes(ascii(b, 8, 12)),
  },
  { ext: "bmp", test: (b) => b[0] === 0x42 && b[1] === 0x4d },
  { ext: "ico", test: (b) => b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0 },
];

function ascii(bytes: Uint8Array, from: number, to: number): string {
  return String.fromCharCode(...bytes.subarray(from, to));
}

/** Extension of a raster image by its magic bytes, or null. */
export function sniffImage(bytes: Uint8Array): string | null {
  return SNIFFERS.find((sniffer) => bytes.length >= 12 && sniffer.test(bytes))?.ext ?? null;
}

// ---------- Naming ----------

/** A file name from the URL's last path segment, with the sniffed extension. */
export function nameFromUrl(url: URL, ext: string): string {
  const last = url.pathname.split("/").filter(Boolean).pop() ?? "";
  let decoded = last;
  try {
    decoded = decodeURIComponent(last);
  } catch {
    // Keep the raw segment.
  }
  // Decoding may reveal slashes (`..%2f..%2fx.png`): keep the final part only.
  decoded = decoded.split(/[\\/]/).pop() ?? "";
  const stem = decoded.replace(/\.[^.]*$/, "");
  const safe = sanitizeAttachmentName(`${stem || "image"}.${ext}`);
  return safe.startsWith("file.") ? `image.${ext}` : safe;
}

// ---------- Download ----------

function parseHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw refused("That isn't a valid image address.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw refused("Only http and https images can be saved.");
  }
  if (url.username || url.password) throw refused("Image addresses with a password can't be saved.");
  return url;
}

function hostKey(url: URL): string {
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return `${url.hostname.replace(/^\[|\]$/g, "")}:${port}`;
}

const PRIVATE_MESSAGE = "That address is on a private or local network, so it can't be saved.";

interface Fetched {
  bytes: Uint8Array;
  contentType: string;
  url: URL;
}

function requestOnce(url: URL, options: Required<Pick<ImportOptions, "maxBytes">> & ImportOptions, signal: AbortSignal): Promise<
  { redirect: string } | Fetched
> {
  const allowed = options.allow?.has(hostKey(url)) ?? false;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!allowed && isIP(host) !== 0 && isPrivateAddress(host)) {
    return Promise.reject(refused(PRIVATE_MESSAGE));
  }
  const resolve = options.lookup ?? dnsLookup;

  return new Promise((done, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const request = client.request(
      url,
      {
        method: "GET",
        signal,
        headers: { Accept: "image/*", "User-Agent": "Gumply (save image to vault)" },
        // Check the resolved address inside the connect: what we check is
        // what we connect to.
        lookup: (hostname, lookupOptions, callback) => {
          resolve(hostname, { ...lookupOptions, all: true }, (error, addresses) => {
            if (error) return callback(error, "", 0);
            const list = addresses as unknown as LookupAddress[];
            if (!allowed && (list.length === 0 || list.some((entry) => isPrivateAddress(entry.address)))) {
              return callback(Object.assign(new Error(PRIVATE_MESSAGE), { code: "GUMPLY_PRIVATE" }), "", 0);
            }
            if ((lookupOptions as { all?: boolean }).all) {
              return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
            }
            callback(null, list[0]!.address, list[0]!.family);
          });
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          done({ redirect: response.headers.location });
          return;
        }
        if (status !== 200) {
          response.resume();
          reject(failed(`Couldn't download the image (HTTP ${status}).`));
          return;
        }
        const contentType = String(response.headers["content-type"] ?? "").toLowerCase();
        if (!contentType.startsWith("image/") || contentType.startsWith("image/svg")) {
          response.resume();
          reject(failed("That address doesn't point to an image (PNG, JPEG, GIF, WebP, AVIF)."));
          return;
        }
        const declared = Number(response.headers["content-length"] ?? NaN);
        if (Number.isFinite(declared) && declared > options.maxBytes) {
          response.destroy();
          reject(payloadTooLarge("Image is too large (max 25 MB)."));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > options.maxBytes) {
            response.destroy();
            reject(payloadTooLarge("Image is too large (max 25 MB)."));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          if (total > options.maxBytes) return;
          done({ bytes: new Uint8Array(Buffer.concat(chunks)), contentType, url });
        });
        response.on("error", (error) => reject(error));
      },
    );
    request.on("error", (error: Error & { code?: string }) => {
      if (error.code === "GUMPLY_PRIVATE") reject(refused(PRIVATE_MESSAGE));
      else reject(error);
    });
    request.end();
  });
}

/** Download `rawUrl` with every guard; returns the bytes and final URL. */
export async function fetchRemoteImage(rawUrl: string, options: ImportOptions = {}): Promise<Fetched & { ext: string }> {
  const maxBytes = options.maxBytes ?? MAX_ATTACHMENT_BYTES;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? IMPORT_TIMEOUT_MS);
  try {
    let url = parseHttpUrl(rawUrl);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const result = await requestOnce(url, { ...options, maxBytes }, controller.signal);
      if ("redirect" in result) {
        if (hop === MAX_REDIRECTS) throw failed("Too many redirects.");
        url = parseHttpUrl(new URL(result.redirect, url).toString());
        continue;
      }
      const ext = sniffImage(result.bytes);
      if (!ext) throw failed("That address doesn't point to an image (PNG, JPEG, GIF, WebP, AVIF).");
      return { ...result, ext };
    }
    throw failed("Too many redirects.");
  } catch (error) {
    if (error instanceof VaultError) throw error;
    if (controller.signal.aborted) throw failed("The download took too long (10 s).");
    const code = (error as { code?: string }).code;
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") throw failed("Couldn't find that image's server.");
    throw failed("Couldn't download the image.");
  } finally {
    clearTimeout(timer);
  }
}

/** Download and save into `attachments/`. */
export async function importRemoteImage(
  vaultRoot: string,
  rawUrl: string,
  options: ImportOptions = {},
): Promise<Attachment> {
  const fetched = await fetchRemoteImage(rawUrl, options);
  return saveAttachment(vaultRoot, { name: nameFromUrl(fetched.url, fetched.ext), data: fetched.bytes });
}

/** `GUMPLY_IMPORT_ALLOW=127.0.0.1:9999,localhost:1234` → set (tests only). */
export function importAllowList(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => /^[^\s:]+:\d+$/.test(entry)),
  );
}
