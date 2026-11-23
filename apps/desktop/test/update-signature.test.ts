import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UPDATE_PUBLIC_KEYS } from "../src/update-keys.js";
import {
  formatSigLine,
  keyIdOf,
  makeVerifier,
  parseSigLine,
  parseSums,
  publicKeyEntry,
  sha256File,
  sha256FileSync,
  verifyDownload,
  verifySums,
  type UpdatePublicKey,
} from "../src/update-signature.js";

/**
 * Update signing, option B (decisions/pending-update-signing). Every key here
 * is a throwaway TEST key generated for this run; none is ever written to
 * the repo.
 */
function testKey(): { privateKey: KeyObject; entry: UpdatePublicKey } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, entry: publicKeyEntry((publicKey.export({ type: "spki", format: "der" }) as Buffer).toString("base64")) };
}

const primary = testKey();
const backup = testKey();
const stranger = testKey();
const keys = [primary.entry, backup.entry];

const installer = Buffer.from("pretend this is Gumply-0.9.1-x86_64.AppImage");
const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const sumsText = `${sha(Buffer.from("the exe"))}  Gumply-Setup-0.9.1.exe\n${sha(installer)}  Gumply-0.9.1-x86_64.AppImage\n`;
const sums = Buffer.from(sumsText);
const signWith = (key: KeyObject, data: Buffer, id: string) => formatSigLine(id, sign(null, data, key));

describe("the .sig line", () => {
  it("round-trips, with or without the final newline", () => {
    const line = signWith(primary.privateKey, sums, primary.entry.id);
    expect(line).toMatch(/^gumply-sig v1 key=[0-9a-f]{16} sig=[A-Za-z0-9+/]+={0,2}\n$/);
    expect(parseSigLine(line)?.keyId).toBe(primary.entry.id);
    expect(parseSigLine(line.trimEnd())?.signature).toHaveLength(64);
  });

  it("rejects anything else", () => {
    const good = signWith(primary.privateKey, sums, primary.entry.id).trimEnd();
    for (const bad of ["", "gumply-sig v2 " + good.slice(14), good.replace("key=", "key= "), good + "\nextra", good.replace(/sig=\S+/, "sig=AAAA"), good.toUpperCase()]) {
      expect(parseSigLine(bad), bad).toBeNull();
    }
  });

  it("the key id is sha256(SPKI DER), first 8 bytes", () => {
    const der = Buffer.from(primary.entry.spki, "base64");
    expect(primary.entry.id).toBe(createHash("sha256").update(der).digest("hex").slice(0, 16));
    expect(keyIdOf(der)).toBe(primary.entry.id);
  });
});

describe("parseSums", () => {
  it("reads sha256sum output, text and binary mode, LF or CRLF", () => {
    const parsed = parseSums(sumsText.replace(/\n/g, "\r\n") + `${"A".repeat(64)} *Gumply-0.9.1.dmg\n`)!;
    expect(parsed.get("Gumply-0.9.1-x86_64.AppImage")).toBe(sha(installer));
    expect(parsed.get("Gumply-0.9.1.dmg")).toBe("a".repeat(64));
    expect(parsed.size).toBe(3);
  });

  it("a malformed line or a name twice: null", () => {
    expect(parseSums(`${sumsText}not a sum line\n`)).toBeNull();
    expect(parseSums(`${sumsText}${sha(installer)}  Gumply-0.9.1-x86_64.AppImage\n`)).toBeNull();
    expect(parseSums("abc  file\n")).toBeNull();
  });
});

describe("verifySums", () => {
  it("a good signature from the primary or the backup key passes", () => {
    for (const key of [primary, backup]) {
      const result = verifySums(sums, signWith(key.privateKey, sums, key.entry.id), keys);
      expect(result).toMatchObject({ ok: true, keyId: key.entry.id });
    }
  });

  it("a flipped byte in the sums or in the signature fails", () => {
    const line = signWith(primary.privateKey, sums, primary.entry.id);
    const changed = Buffer.from(sums);
    changed[3] = changed[3]! ^ 1;
    expect(verifySums(changed, line, keys)).toEqual({ ok: false, reason: "bad signature" });
    const parsed = parseSigLine(line)!;
    parsed.signature[10] = parsed.signature[10]! ^ 1;
    expect(verifySums(sums, formatSigLine(parsed.keyId, parsed.signature), keys)).toEqual({ ok: false, reason: "bad signature" });
  });

  it("an unknown key fails, and so does another key's signature under a trusted id", () => {
    expect(verifySums(sums, signWith(stranger.privateKey, sums, stranger.entry.id), keys)).toMatchObject({ ok: false, reason: expect.stringMatching(/unknown key/) });
    expect(verifySums(sums, signWith(stranger.privateKey, sums, primary.entry.id), keys)).toEqual({ ok: false, reason: "bad signature" });
  });

  it("a mislabelled built-in key isn't trusted", () => {
    const mislabelled = [{ id: primary.entry.id, spki: stranger.entry.spki }];
    expect(verifySums(sums, signWith(stranger.privateKey, sums, primary.entry.id), mislabelled)).toMatchObject({ ok: false, reason: expect.stringMatching(/wrong id/) });
  });

  it("a malformed .sig or sums file fails", () => {
    expect(verifySums(sums, "garbage", keys)).toEqual({ ok: false, reason: "malformed signature file" });
    const badSums = Buffer.from("not sums\n");
    expect(verifySums(badSums, signWith(primary.privateKey, badSums, primary.entry.id), keys)).toEqual({ ok: false, reason: "malformed SHA256SUMS.txt" });
  });

  it("no keys: nothing verifies", () => {
    expect(verifySums(sums, signWith(primary.privateKey, sums, primary.entry.id), [])).toMatchObject({ ok: false });
  });
});

describe("verifyDownload and the file hash", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  function file(data: Buffer, name = "Gumply-0.9.1-x86_64.AppImage") {
    const dir = mkdtempSync(join(tmpdir(), "gumply-sig-"));
    dirs.push(dir);
    writeFileSync(join(dir, name), data);
    return { path: join(dir, name), name };
  }
  const line = signWith(primary.privateKey, sums, primary.entry.id);

  it("hashes a file, async and sync, across read chunks", async () => {
    const big = Buffer.alloc((1 << 20) * 2 + 7, 7);
    const target = file(big, "big.bin");
    expect(await sha256File(target.path)).toBe(sha(big));
    expect(sha256FileSync(target.path)).toBe(sha(big));
  });

  it("passes with the installer's sha256; the verified hash comes back", async () => {
    expect(await verifyDownload(file(installer), sums, line, keys)).toEqual({ ok: true, sha256: sha(installer), keyId: primary.entry.id });
  });

  it("fails when the installer isn't in the sums, or its sha256 differs", async () => {
    expect(await verifyDownload(file(installer, "Gumply-0.9.2-x86_64.AppImage"), sums, line, keys)).toMatchObject({ ok: false, reason: expect.stringMatching(/not in SHA256SUMS/) });
    expect(await verifyDownload(file(Buffer.from("tampered")), sums, line, keys)).toMatchObject({ ok: false, reason: expect.stringMatching(/sha256 mismatch/) });
  });

  it("never hashes the file when the signature is bad", async () => {
    const hash = vi.fn(async () => sha(installer));
    expect(await verifyDownload(file(installer), sums, "garbage", keys, hash)).toMatchObject({ ok: false });
    expect(hash).not.toHaveBeenCalled();
  });
});

describe("makeVerifier (what main.ts gives the controller)", () => {
  it("no keys: no verifier, so no check and no extra requests (today's behaviour)", () => {
    expect(UPDATE_PUBLIC_KEYS).toEqual([]);
    expect(makeVerifier({ keys: UPDATE_PUBLIC_KEYS, baseUrl: () => "x/", get: async () => Buffer.alloc(0) })).toBeNull();
  });

  it("fetches exactly the sums and the .sig from the release, then checks the cached file by its name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gumply-sig-"));
    try {
      const downloadedFile = join(dir, "Gumply-0.9.1-x86_64.AppImage");
      writeFileSync(downloadedFile, installer);
      const served: Record<string, Buffer> = {
        "https://example.test/v0.9.1/SHA256SUMS.txt": sums,
        "https://example.test/v0.9.1/SHA256SUMS.txt.sig": Buffer.from(signWith(backup.privateKey, sums, backup.entry.id)),
      };
      const get = vi.fn(async (url: string) => {
        const body = served[url];
        if (!body) throw new Error(`404 for ${url}`);
        return body;
      });
      const verify = makeVerifier({ keys, baseUrl: (version) => `https://example.test/v${version}/`, get })!;
      expect(await verify({ version: "0.9.1", downloadedFile })).toEqual({ ok: true, sha256: sha(installer) });
      expect(get.mock.calls.map(([url]) => url).sort()).toEqual(Object.keys(served).sort());

      // A missing .sig: not verified.
      delete served["https://example.test/v0.9.1/SHA256SUMS.txt.sig"];
      expect(await verify({ version: "0.9.1", downloadedFile })).toMatchObject({ ok: false, reason: expect.stringMatching(/couldn't fetch/) });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
