/**
 * Update signing, option B (decisions/pending-update-signing): a release's
 * `SHA256SUMS.txt` carries an ed25519 signature in `SHA256SUMS.txt.sig`, and
 * a downloaded update is only installed when that signature verifies against
 * a public key built into the app and the installer's sha256 is in the sums.
 *
 * The `.sig` file is one line:
 *
 *   gumply-sig v1 key=<key id> sig=<base64 signature>
 *
 * signed over the exact bytes of `SHA256SUMS.txt`. A key id is the first 8
 * bytes of sha256(the public key's SPKI DER), in hex, so the app can pick the
 * key (primary or backup) without trying each one.
 *
 * Node's built-in `crypto` only: no new dependency.
 */
import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import { closeSync, createReadStream, openSync, readSync } from "node:fs";

/** A public key the app trusts: its id and its SPKI DER, base64. */
export interface UpdatePublicKey {
  id: string;
  /** SPKI DER, base64 (`publicKey.export({ type: "spki", format: "der" })`). */
  spki: string;
}

export interface SigLine {
  keyId: string;
  signature: Buffer;
}

const SIG_LINE = /^gumply-sig v1 key=([0-9a-f]{16}) sig=([A-Za-z0-9+/]+={0,2})$/;

/** The key id: sha256 of the SPKI DER, first 8 bytes, hex. */
export function keyIdOf(spkiDer: Buffer): string {
  return createHash("sha256").update(spkiDer).digest("hex").slice(0, 16);
}

/** Parse a `.sig` file (one line, an optional final newline). Null if malformed. */
export function parseSigLine(text: string): SigLine | null {
  const match = SIG_LINE.exec(text.replace(/\r?\n$/, ""));
  if (!match) return null;
  const signature = Buffer.from(match[2]!, "base64");
  // ed25519 signatures are 64 bytes.
  if (signature.length !== 64) return null;
  return { keyId: match[1]!, signature };
}

/** The line `scripts/sign-sums.mjs` writes. */
export function formatSigLine(keyId: string, signature: Buffer): string {
  return `gumply-sig v1 key=${keyId} sig=${signature.toString("base64")}\n`;
}

/**
 * `sha256sum` output: `<64 hex>  <name>` or `<64 hex> *<name>` per line.
 * Returns name -> lowercase hex, or null if any non-empty line is malformed
 * or a name appears twice.
 */
export function parseSums(text: string): Map<string, string> | null {
  const sums = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line === "") continue;
    const match = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line);
    if (!match) return null;
    const name = match[2]!;
    if (sums.has(name)) return null;
    sums.set(name, match[1]!.toLowerCase());
  }
  return sums;
}

function publicKeyOf(key: UpdatePublicKey): KeyObject | null {
  try {
    const object = createPublicKey({ key: Buffer.from(key.spki, "base64"), format: "der", type: "spki" });
    return object.asymmetricKeyType === "ed25519" ? object : null;
  } catch {
    return null;
  }
}

export type VerifyResult =
  | { ok: true; keyId: string; sums: Map<string, string> }
  | { ok: false; reason: string };

/**
 * Check `sigText` over the exact bytes of `sumsBytes` against `keys`. On
 * success, the parsed sums.
 */
export function verifySums(sumsBytes: Buffer, sigText: string, keys: readonly UpdatePublicKey[]): VerifyResult {
  const sig = parseSigLine(sigText);
  if (!sig) return { ok: false, reason: "malformed signature file" };
  const key = keys.find((candidate) => candidate.id === sig.keyId);
  if (!key) return { ok: false, reason: `signed by an unknown key (${sig.keyId})` };
  const publicKey = publicKeyOf(key);
  if (!publicKey) return { ok: false, reason: `built-in key ${key.id} is not an ed25519 public key` };
  // The id must match the key itself, so a mislabelled key can't stand in for another.
  if (keyIdOf(Buffer.from(key.spki, "base64")) !== key.id) return { ok: false, reason: `built-in key ${key.id} has the wrong id` };
  let good = false;
  try {
    good = verify(null, sumsBytes, publicKey, sig.signature);
  } catch {
    good = false;
  }
  if (!good) return { ok: false, reason: "bad signature" };
  const sums = parseSums(sumsBytes.toString("utf8"));
  if (!sums) return { ok: false, reason: "malformed SHA256SUMS.txt" };
  return { ok: true, keyId: key.id, sums };
}

/** sha256 of a file, lowercase hex. */
export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/** The same, synchronously, in 1 MiB reads (the re-hash at quit can't wait for a promise). */
export function sha256FileSync(path: string): string {
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(1 << 20);
  const fd = openSync(path, "r");
  try {
    for (let read = readSync(fd, buffer); read > 0; read = readSync(fd, buffer)) hash.update(buffer.subarray(0, read));
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

/**
 * The installer's exact release file name for `version` (apps/desktop/package.json
 * `artifactName`s; electron-builder calls x64 "x86_64" for the AppImage). Null
 * for formats Gumply doesn't install itself.
 */
export function installerName(kind: string, version: string, arch: string): string | null {
  if (kind === "appimage") return `Gumply-${version}-${arch === "x64" ? "x86_64" : arch}.AppImage`;
  if (kind === "nsis") return `Gumply-Setup-${version}-${arch}.exe`;
  return null;
}

/**
 * The whole check for one downloaded file: the signature, then the signed
 * entry for `file.name` (the installer's exact name FOR THE VERSION BEING
 * INSTALLED, not the downloaded file's name), then the downloaded file's
 * sha256 against that entry. So an older, validly signed installer offered
 * under a newer version fails: its signed entry carries the older name.
 * On success, the verified sha256 (the re-hash at quit compares against it).
 */
export async function verifyDownload(
  file: { path: string; name: string },
  sumsBytes: Buffer,
  sigText: string,
  keys: readonly UpdatePublicKey[],
  hash: (path: string) => Promise<string> = sha256File,
): Promise<{ ok: true; sha256: string; keyId: string } | { ok: false; reason: string }> {
  const result = verifySums(sumsBytes, sigText, keys);
  if (!result.ok) return result;
  const expected = result.sums.get(file.name);
  if (!expected) return { ok: false, reason: `${file.name} is not in SHA256SUMS.txt` };
  const actual = await hash(file.path);
  if (actual !== expected) return { ok: false, reason: `${file.name}: sha256 mismatch` };
  return { ok: true, sha256: actual, keyId: result.keyId };
}

/** The most a sums or `.sig` body may be (the real ones are a few hundred bytes). */
export const MAX_SIGNED_FILE_BYTES = 256 * 1024;
/** How long each of the two GETs may take. */
export const SIGNED_FILE_TIMEOUT_MS = 30_000;

/** Read a response body, refusing more than `max` bytes. */
export async function readCapped(body: ReadableStream<Uint8Array> | null, max = MAX_SIGNED_FILE_BYTES): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`more than ${max} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** The two files next to a release's installers. */
export const SUMS_FILE = "SHA256SUMS.txt";
export const SIG_FILE = "SHA256SUMS.txt.sig";

export interface VerifierDeps {
  keys: readonly UpdatePublicKey[];
  /** Where a version's release files live, ending in "/" (GitHub: `…/releases/download/v<version>/`). */
  baseUrl(version: string): string;
  /** A GET: the body, or a rejection (a non-2xx status rejects with an `HttpStatusError`). */
  get(url: string): Promise<Buffer>;
  /** The installer's exact release file name for a version (see `installerName`). */
  installerName(version: string): string | null;
  hash?(path: string): Promise<string>;
}

/**
 * The controller's `verify` for main.ts, or null when no key is configured
 * (no keys: no signature check, so no extra requests). It fetches the sums
 * and the `.sig` (2 GETs, after a download only) and checks the file. A fetch
 * that fails is never a pass: a 4xx fails verification, anything else
 * (network, timeout, 5xx) is `retry`.
 */
/** A GET answered with a non-2xx status. */
export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    what: string,
  ) {
    super(`${status} for ${what}`);
  }
}

/**
 * What the controller gets back. `retry`: the signed files couldn't be fetched
 * for a passing reason (network, timeout, a 5xx): not installed either, but
 * tried again at the next check instead of being marked as failing
 * verification. A 4xx (e.g. a release without a `.sig`) is a real failure.
 */
export type VerifyOutcome = { ok: true; sha256: string } | { ok: false; reason: string; retry?: boolean };

export function makeVerifier(deps: VerifierDeps): ((download: { version: string; downloadedFile: string }) => Promise<VerifyOutcome>) | null {
  if (deps.keys.length === 0) return null;
  return async ({ version, downloadedFile }) => {
    const base = deps.baseUrl(version);
    let sums: Buffer;
    let sig: Buffer;
    try {
      [sums, sig] = await Promise.all([deps.get(`${base}${SUMS_FILE}`), deps.get(`${base}${SIG_FILE}`)]);
    } catch (error) {
      const missing = error instanceof HttpStatusError && error.status >= 400 && error.status < 500;
      return { ok: false, ...(missing ? {} : { retry: true }), reason: `couldn't fetch the signed checksums: ${error instanceof Error ? error.message : String(error)}` };
    }
    const name = deps.installerName(version);
    if (!name) return { ok: false, reason: "no installer name for this kind of install" };
    // electron-updater caches the asset under its release file name: it must be
    // the one for the version offered (an old installer keeps its old name).
    const downloadedName = downloadedFile.split(/[\\/]/).pop() ?? "";
    if (downloadedName !== name) return { ok: false, reason: `downloaded ${downloadedName}, expected ${name} for ${version}` };
    const result = await verifyDownload({ path: downloadedFile, name }, sums, sig.toString("utf8"), deps.keys, deps.hash).catch(
      (error: unknown) => ({ ok: false as const, reason: error instanceof Error ? error.message : String(error) }),
    );
    return result.ok ? { ok: true, sha256: result.sha256 } : result;
  };
}

/** A public key as `update-keys.ts` lists it, from SPKI DER in base64 (test builds pass one in). */
export function publicKeyEntry(spkiBase64: string): UpdatePublicKey {
  return { id: keyIdOf(Buffer.from(spkiBase64, "base64")), spki: spkiBase64 };
}
