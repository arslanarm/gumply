import { generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { publicKeyEntry, verifySums } from "../apps/desktop/src/update-signature.js";
// @ts-expect-error -- plain .mjs script without types
import { signSums } from "./sign-sums.mjs";

/**
 * scripts/sign-sums.mjs writes the `.sig` the app checks (update signing,
 * option B). Throwaway TEST keys only, generated per run.
 */
const script = join(dirname(fileURLToPath(import.meta.url)), "sign-sums.mjs");
const sums = Buffer.from(`${"0".repeat(64)}  Gumply-0.9.1-x86_64.AppImage\n${"1".repeat(64)}  Gumply-Setup-0.9.1.exe\n`);

function testPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    pem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    entry: publicKeyEntry((publicKey.export({ type: "spki", format: "der" }) as Buffer).toString("base64")),
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("scripts/sign-sums.mjs", () => {
  it("signs what the app verifies, with the same key id", () => {
    const pair = testPair();
    const { keyId, line } = signSums(sums, pair.pem) as { keyId: string; line: string };
    expect(keyId).toBe(pair.entry.id);
    expect(verifySums(sums, line, [pair.entry])).toMatchObject({ ok: true, keyId: pair.entry.id });
  });

  it("refuses a key that isn't ed25519, without echoing it", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    expect(() => signSums(sums, rsa)).toThrow(/not ed25519/);
    let message = "";
    try {
      signSums(sums, "-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----\n");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/isn't a valid private key/);
    expect(message).not.toContain("not-a-key");
  });

  it("the CLI writes <sums>.sig, prints only the key id, and never the key", () => {
    const pair = testPair();
    const dir = mkdtempSync(join(tmpdir(), "gumply-sign-"));
    dirs.push(dir);
    const file = join(dir, "SHA256SUMS.txt");
    writeFileSync(file, sums);
    const run = spawnSync(process.execPath, [script, file], { env: { ...process.env, GUMPLY_SIGNING_KEY: pair.pem }, encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain(pair.entry.id);
    const body = pair.pem.split("\n")[1]!;
    expect(run.stdout + run.stderr).not.toContain(body);
    expect(verifySums(sums, readFileSync(`${file}.sig`, "utf8"), [pair.entry])).toMatchObject({ ok: true });
  });

  it("the CLI without a key: an error, and no .sig", () => {
    const dir = mkdtempSync(join(tmpdir(), "gumply-sign-"));
    dirs.push(dir);
    const file = join(dir, "SHA256SUMS.txt");
    writeFileSync(file, sums);
    const env = { ...process.env };
    delete env.GUMPLY_SIGNING_KEY;
    const run = spawnSync(process.execPath, [script, file], { env, encoding: "utf8" });
    expect(run.status).toBe(2);
    expect(existsSync(`${file}.sig`)).toBe(false);
  });
});
