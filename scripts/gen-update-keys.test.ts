import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { verifySums } from "../apps/desktop/src/update-signature.js";
// @ts-expect-error -- plain .mjs script without types
import { generateKeys, KEY_FILES } from "./gen-update-keys.mjs";
// @ts-expect-error -- plain .mjs script without types
import { signSums } from "./sign-sums.mjs";

/**
 * scripts/gen-update-keys.mjs (D44): the owner's one-time key creation. Every
 * key here is a throwaway made in a temp folder and deleted after the test.
 */
const script = join(dirname(fileURLToPath(import.meta.url)), "gen-update-keys.mjs");
const sums = Buffer.from(`${"0".repeat(64)}  Gumply-0.9.0-x86_64.AppImage\n`);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "gumply-keys-"));
  dirs.push(dir);
  return dir;
}

type Entry = { id: string; spki: string };

describe("scripts/gen-update-keys.mjs", () => {
  it("writes two private keys only the user can read; the public entries verify their signatures", () => {
    const dir = scratch();
    const { primary, backup } = generateKeys(dir) as { primary: Entry; backup: Entry };
    expect(primary.id).not.toBe(backup.id);
    for (const [role, entry] of [["primary", primary], ["backup", backup]] as const) {
      const file = join(dir, (KEY_FILES as Record<string, string>)[role]!);
      if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
      const pem = readFileSync(file, "utf8");
      expect(pem).toMatch(/^-----BEGIN PRIVATE KEY-----/);
      const { line } = signSums(sums, pem) as { line: string };
      // Each key's signature verifies with both entries built in (the app's view).
      expect(verifySums(sums, line, [primary, backup])).toMatchObject({ ok: true, keyId: entry.id });
    }
  });

  it("never overwrites a key, and writes nothing then", () => {
    const dir = scratch();
    writeFileSync(join(dir, (KEY_FILES as Record<string, string>).backup!), "an existing key");
    expect(() => generateKeys(dir)).toThrow(/already exists/);
    expect(existsSync(join(dir, (KEY_FILES as Record<string, string>).primary!))).toBe(false);
    expect(readFileSync(join(dir, (KEY_FILES as Record<string, string>).backup!), "utf8")).toBe("an existing key");
  });

  it("refuses a folder inside a git checkout", () => {
    const dir = scratch();
    mkdirSync(join(dir, ".git"));
    mkdirSync(join(dir, "sub"));
    expect(() => generateKeys(join(dir, "sub"))).toThrow(/inside a git checkout/);
    expect(existsSync(join(dir, "sub", (KEY_FILES as Record<string, string>).primary!))).toBe(false);
  });

  it("the CLI prints the two public entries and the steps, and no private key material", () => {
    const dir = scratch();
    const run = spawnSync(process.execPath, [script, dir], { encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    const lines = run.stdout.split("\n").filter((line) => /^\s*\{ id: "[0-9a-f]{16}", spki: "[A-Za-z0-9+/]+={0,2}" \}, \/\/ (primary|backup)/.test(line));
    expect(lines).toHaveLength(2);
    expect(run.stdout).toContain("GUMPLY_SIGNING_KEY");
    for (const name of Object.values(KEY_FILES as Record<string, string>)) {
      const body = readFileSync(join(dir, name), "utf8").split("\n")[1]!;
      expect(run.stdout + run.stderr).not.toContain(body);
    }
    expect(run.stdout + run.stderr).not.toContain("BEGIN PRIVATE KEY");
  });
});
