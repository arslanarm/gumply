import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { publicKeyEntry } from "../apps/desktop/src/update-signature.js";
// @ts-expect-error -- plain .mjs script without types
import { keyProblems, readKeys } from "./check-update-keys.mjs";
// @ts-expect-error -- plain .mjs script without types
import { signSums } from "./sign-sums.mjs";

/** scripts/check-update-keys.mjs (D44): the release guards. Throwaway TEST keys only. */
const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "check-update-keys.mjs");
const realKeysFile = join(here, "../apps/desktop/src/update-keys.ts");

function pair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    pem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    entry: publicKeyEntry((publicKey.export({ type: "spki", format: "der" }) as Buffer).toString("base64")),
  };
}
const primary = pair();
const backup = pair();
const stranger = pair();

/** update-keys.ts with these keys (the real file's text, its list replaced; the owner's keys are in the real one). */
function keysFileText(entries: Array<{ id: string; spki: string }>): string {
  const lines = entries.map((entry, index) => `  { id: "${entry.id}", spki: "${entry.spki}" }, // ${index === 0 ? "primary (CI)" : "backup (offline)"}`);
  const list = /export const UPDATE_PUBLIC_KEYS: readonly UpdatePublicKey\[\] = \[[\s\S]*?\];/;
  const text = readFileSync(realKeysFile, "utf8");
  if (!list.test(text)) throw new Error("UPDATE_PUBLIC_KEYS not found in update-keys.ts");
  return text.replace(list, `export const UPDATE_PUBLIC_KEYS: readonly UpdatePublicKey[] = [${lines.length ? `\n${lines.join("\n")}\n` : ""}];`);
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "gumply-check-keys-"));
  dirs.push(dir);
  return dir;
}
const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });

describe("scripts/check-update-keys.mjs --require (the tag guard)", () => {
  it("reads today's file: the owner's two keys, so a tag passes", () => {
    expect(readKeys(readFileSync(realKeysFile, "utf8")).map((key: { id: string }) => key.id)).toEqual(["7d231848158a2a02", "3806c70f4944286f"]);
    const result = run("--require");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("primary 7d231848158a2a02, backup 3806c70f4944286f");
  });

  it('reads a key whose base64 contains "//", with comments after the entries and in between (#kziv42ti)', () => {
    // A fixed ed25519 SPKI whose 32 key bytes are 0xff: its base64 has "////" (random test keys hit "//" a few % per run).
    const slashes = publicKeyEntry(Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.alloc(32, 0xff)]).toString("base64"));
    expect(slashes.spki).toContain("//");
    expect(readKeys(keysFileText([slashes, primary.entry]))).toEqual([slashes, primary.entry]);
    const commented = keysFileText([primary.entry, slashes]).replace("// backup (offline)", "// backup (offline) // still a comment\n  /* a block comment: { id: \"x\", spki: \"y\" } */");
    expect(readKeys(commented)).toEqual([primary.entry, slashes]);
  });

  it("an empty list fails the tag", () => {
    const dir = scratch();
    writeFileSync(join(dir, "update-keys.ts"), keysFileText([]));
    const result = run("--require", "--keys-file", join(dir, "update-keys.ts"));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/::error::UPDATE_PUBLIC_KEYS is empty/);
  });

  it("passes with the primary and backup written as the key script prints them", () => {
    const dir = scratch();
    writeFileSync(join(dir, "update-keys.ts"), keysFileText([primary.entry, backup.entry]));
    expect(readKeys(readFileSync(join(dir, "update-keys.ts"), "utf8"))).toEqual([primary.entry, backup.entry]);
    const result = run("--require", "--keys-file", join(dir, "update-keys.ts"));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`primary ${primary.entry.id}, backup ${backup.entry.id}`);
  });

  it("refuses one key, three, a duplicate, a wrong id, a non-ed25519 key, or an entry written another way", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "der" }) as Buffer;
    expect(keyProblems([primary.entry]).join()).toMatch(/expected exactly 2/);
    expect(keyProblems([primary.entry, backup.entry, stranger.entry]).join()).toMatch(/expected exactly 2/);
    expect(keyProblems([primary.entry, primary.entry]).join()).toMatch(/same key twice/);
    expect(keyProblems([primary.entry, { id: primary.entry.id, spki: backup.entry.spki }]).join()).toMatch(/backup: id .* doesn't match/);
    expect(keyProblems([primary.entry, publicKeyEntry(rsa.toString("base64"))]).join()).toMatch(/backup: not an ed25519 key/);
    expect(keyProblems([primary.entry, { id: "0".repeat(16), spki: "not base64!" }]).join()).toMatch(/backup: spki isn't a valid public key/);
    expect(() => readKeys(keysFileText([primary.entry]).replace("// primary (CI)", "// primary (CI)\n  SOME_OTHER_KEY,"))).toThrow(/not written as/);
  });
});

describe("scripts/check-update-keys.mjs --verify (the release job)", () => {
  function release(signer: { pem: string } | null) {
    const dir = scratch();
    writeFileSync(join(dir, "update-keys.ts"), keysFileText([primary.entry, backup.entry]));
    const sums = Buffer.from(`${"a".repeat(64)}  Gumply-0.9.0-x86_64.AppImage\n${"b".repeat(64)}  Gumply-Setup-0.9.0-x64.exe\n`);
    writeFileSync(join(dir, "SHA256SUMS.txt"), sums);
    if (signer) writeFileSync(join(dir, "SHA256SUMS.txt.sig"), (signSums(sums, signer.pem) as { line: string }).line);
    return { dir, verify: () => run("--verify", join(dir, "SHA256SUMS.txt"), "--keys-file", join(dir, "update-keys.ts")) };
  }

  it("a .sig by the primary or the backup verifies, and says which", () => {
    for (const [signer, role] of [[primary, "primary"], [backup, "backup"]] as const) {
      const result = release(signer).verify();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`built-in ${role} key (${signer.entry.id})`);
    }
  });

  it("fails on a missing .sig, another key, or sums changed after signing", () => {
    expect(release(null).verify().stderr).toMatch(/\.sig is missing/);
    expect(release(stranger).verify().stderr).toMatch(/aren't built into the app/);
    const changed = release(primary);
    writeFileSync(join(changed.dir, "SHA256SUMS.txt"), "c".repeat(64) + "  Gumply-0.9.0-x86_64.AppImage\n");
    const result = changed.verify();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/doesn't verify/);
  });

  it("the app's multi-line rule: an unknown key's line is skipped; a malformed or failing trusted line fails; at most 8", () => {
    const { dir, verify } = release(primary);
    const sums = readFileSync(join(dir, "SHA256SUMS.txt"));
    const lineBy = (signer: { pem: string }) => (signSums(sums, signer.pem) as { line: string }).line;
    const write = (text: string) => writeFileSync(join(dir, "SHA256SUMS.txt.sig"), text);
    write(lineBy(stranger) + lineBy(backup));
    expect(verify().stdout).toContain("built-in backup key");
    write(lineBy(primary) + "gumply-sig v1 garbage\n");
    expect(verify().stderr).toMatch(/isn't a gumply-sig v1 line/);
    // A trusted id over a bad signature (a stranger's, relabelled), next to a good line.
    write(lineBy(stranger).replace(stranger.entry.id, backup.entry.id) + lineBy(primary));
    expect(verify().stderr).toMatch(/the line for key .* doesn't verify/);
    write(lineBy(primary).repeat(9));
    expect(verify().stderr).toMatch(/1 to 8 lines \(has 9\)/);
    write(lineBy(primary).repeat(8));
    expect(verify().status).toBe(0);
  });

  it("fails with no keys built in, even with a good-looking .sig", () => {
    const { dir } = release(primary);
    writeFileSync(join(dir, "empty-keys.ts"), keysFileText([]));
    const result = run("--verify", join(dir, "SHA256SUMS.txt"), "--keys-file", join(dir, "empty-keys.ts"));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/empty/);
  });

  it("against the real built-in keys, a test key's .sig is refused (only the owner's keys sign releases)", () => {
    const { dir } = release(primary);
    const result = run("--verify", join(dir, "SHA256SUMS.txt"));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/aren't built into the app/);
  });
});
