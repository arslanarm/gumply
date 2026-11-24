#!/usr/bin/env node
/**
 * Create Gumply's two update-signing key pairs (D44, update signing). For the
 * OWNER to run ON THEIR OWN COMPUTER, once:
 *
 *   node scripts/gen-update-keys.mjs [<folder>]      (default: the current folder)
 *
 * It writes two PRIVATE keys into <folder> (only you can read them):
 *   gumply-update-primary.pem   → goes into GitHub as the `release` environment
 *                                 secret GUMPLY_SIGNING_KEY (CI signs with it)
 *   gumply-update-backup.pem    → keep OFFLINE (USB stick, password manager,
 *                                 paper); used only if the primary is lost
 *
 * and prints only the two PUBLIC keys, as the lines to paste into
 * apps/desktop/src/update-keys.ts. Public keys are safe to share.
 *
 * Node's built-in crypto only: no install, no network. It refuses to overwrite
 * a key file, and refuses to write into a git checkout (so a private key can't
 * be committed by accident).
 */
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const KEY_FILES = { primary: "gumply-update-primary.pem", backup: "gumply-update-backup.pem" };

/** The git checkout `dir` is inside, if any. */
export function gitRootOf(dir) {
  for (let current = resolve(dir); ; current = dirname(current)) {
    if (existsSync(join(current, ".git"))) return current;
    if (dirname(current) === current) return null;
  }
}

/** One key pair: the private key PEM, and the public entry for update-keys.ts. */
export function makePair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  return {
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }),
    entry: { id: createHash("sha256").update(spki).digest("hex").slice(0, 16), spki: spki.toString("base64") },
  };
}

/**
 * Create both pairs in `folder`. Returns the public entries; throws (writing
 * nothing) if the folder is inside a git checkout or a key file exists.
 */
export function generateKeys(folder) {
  const dir = resolve(folder);
  const repo = gitRootOf(dir);
  if (repo) throw new Error(`${dir} is inside a git checkout (${repo}). Pick a folder outside any repository, e.g. your home folder.`);
  for (const name of Object.values(KEY_FILES)) {
    if (existsSync(join(dir, name))) throw new Error(`${join(dir, name)} already exists; not overwriting a key. Move it away first.`);
  }
  mkdirSync(dir, { recursive: true });
  const pairs = { primary: makePair(), backup: makePair() };
  for (const [role, name] of Object.entries(KEY_FILES)) {
    // "wx": never overwrite; 0600: only you can read it (on Windows, your user folder's rights apply).
    writeFileSync(join(dir, name), pairs[role].privatePem, { flag: "wx", mode: 0o600 });
  }
  return { dir, primary: pairs.primary.entry, backup: pairs.backup.entry };
}

function main(argv) {
  if (argv.length > 1 || argv[0] === "--help" || argv[0] === "-h") {
    console.log("usage: node scripts/gen-update-keys.mjs [<folder outside any git checkout>]");
    return argv.length > 1 ? 2 : 0;
  }
  let result;
  try {
    result = generateKeys(argv[0] ?? process.cwd());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const { dir, primary, backup } = result;
  console.log(`Created two PRIVATE keys in ${dir}:
  ${KEY_FILES.primary}   (primary: for GitHub)
  ${KEY_FILES.backup}    (backup: keep offline)
Never send these files or their contents to anyone, including the team.

PUBLIC keys: paste these lines in the chat (safe to share):

  { id: "${primary.id}", spki: "${primary.spki}" }, // primary (CI)
  { id: "${backup.id}", spki: "${backup.spki}" }, // backup (offline)

Next:
  1. GitHub → the repository → Settings → Environments → "release" →
     Add environment secret: name GUMPLY_SIGNING_KEY, value: the whole
     contents of ${KEY_FILES.primary} (from -----BEGIN to END-----).
  2. Copy ${KEY_FILES.backup} somewhere offline that only you can reach.
  3. Then delete both files from this computer (the GitHub secret and your
     offline copy are the only copies needed).`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exit(main(process.argv.slice(2)));
