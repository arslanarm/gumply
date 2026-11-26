#!/usr/bin/env node
/**
 * Release guards for update signing (D44).
 *
 *   node scripts/check-update-keys.mjs --require
 *       The tag guard: apps/desktop/src/update-keys.ts holds exactly two
 *       public keys (primary, then backup), each a valid ed25519 SPKI whose id
 *       matches it. An empty list means a release that silently doesn't check
 *       signatures, so it fails.
 *
 *   node scripts/check-update-keys.mjs --verify <dir>/SHA256SUMS.txt
 *       The release job's check: the `.sig` next to the sums verifies with a
 *       built-in key, exactly as the app checks it. Prints which key signed.
 *
 * (--keys-file <path> reads another update-keys.ts; tests use it.)
 *
 * Node built-ins only, and update-keys.ts is read as text (no build step):
 * entries must be written as `{ id: "<16 hex>", spki: "<base64>" }`.
 */
import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_KEYS_FILE = fileURLToPath(new URL("../apps/desktop/src/update-keys.ts", import.meta.url));
const ROLES = ["primary", "backup"];

/** The entries of UPDATE_PUBLIC_KEYS, from the file's text. */
export function readKeys(text) {
  const match = /export const UPDATE_PUBLIC_KEYS\b[^=]*=\s*\[([\s\S]*?)\];/.exec(text);
  if (!match) throw new Error("UPDATE_PUBLIC_KEYS not found in update-keys.ts");
  // Comments are dropped only outside strings (#kziv42ti): a base64 key can contain "//".
  const body = match[1].replace(/"(?:[^"\\\n]|\\.)*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (token) => (token.startsWith('"') ? token : ""));
  const keys = [...body.matchAll(/\{\s*id:\s*"([^"]*)",\s*spki:\s*"([^"]*)",?\s*\}/g)].map((entry) => ({ id: entry[1], spki: entry[2] }));
  // Anything else between the brackets (a key written another way) is an error, not ignored.
  const rest = body.replace(/\{\s*id:\s*"([^"]*)",\s*spki:\s*"([^"]*)",?\s*\}/g, "").replace(/[\s,]/g, "");
  if (rest) throw new Error(`UPDATE_PUBLIC_KEYS has entries not written as { id: "…", spki: "…" }: ${rest.slice(0, 60)}`);
  return keys;
}

const idOf = (der) => createHash("sha256").update(der).digest("hex").slice(0, 16);

/** Problems with the keys for a release (empty = fine). */
export function keyProblems(keys) {
  if (keys.length === 0) return ["UPDATE_PUBLIC_KEYS is empty: this release wouldn't check update signatures (D44). Add the owner's two public keys first."];
  const problems = [];
  if (keys.length !== 2) problems.push(`UPDATE_PUBLIC_KEYS has ${keys.length} key(s); expected exactly 2 (primary, backup).`);
  keys.forEach((key, index) => {
    const role = ROLES[index] ?? `key ${index + 1}`;
    let der;
    try {
      der = Buffer.from(key.spki, "base64");
      const object = createPublicKey({ key: der, format: "der", type: "spki" });
      if (object.asymmetricKeyType !== "ed25519") problems.push(`${role}: not an ed25519 key (${object.asymmetricKeyType}).`);
    } catch {
      problems.push(`${role}: spki isn't a valid public key.`);
      return;
    }
    if (idOf(der) !== key.id) problems.push(`${role}: id ${key.id} doesn't match its key (${idOf(der)}).`);
  });
  if (new Set(keys.map((key) => key.id)).size !== keys.length) problems.push("UPDATE_PUBLIC_KEYS has the same key twice.");
  return problems;
}

/** Check `<sums>.sig` against the keys; returns the signing key's role, or throws. */
export function verifySigned(sumsPath, keys) {
  const sigPath = `${sumsPath}.sig`;
  if (!existsSync(sigPath)) throw new Error(`${sigPath} is missing.`);
  // The app's rule (update-signature.ts verifySums): 1 to 8 well-formed lines;
  // unknown key ids skipped; every trusted key's line must verify; at least one does.
  const body = readFileSync(sigPath, "utf8").replace(/\r?\n$/, "");
  const lines = body === "" ? [] : body.split(/\r?\n/);
  if (lines.length === 0 || lines.length > 8) throw new Error(`${sigPath} must have 1 to 8 lines (has ${lines.length}).`);
  const sums = readFileSync(sumsPath);
  let first = null;
  for (const line of lines) {
    const match = /^gumply-sig v1 key=([0-9a-f]{16}) sig=([A-Za-z0-9+/]+={0,2})$/.exec(line);
    if (!match || Buffer.from(match[2], "base64").length !== 64) throw new Error(`${sigPath} has a line that isn't a gumply-sig v1 line.`);
    const index = keys.findIndex((key) => key.id === match[1]);
    if (index < 0) continue;
    const publicKey = createPublicKey({ key: Buffer.from(keys[index].spki, "base64"), format: "der", type: "spki" });
    if (!verify(null, sums, publicKey, Buffer.from(match[2], "base64"))) throw new Error(`${sigPath}: the line for key ${match[1]} doesn't verify over ${sumsPath}.`);
    first ??= { role: ROLES[index] ?? `key ${index + 1}`, id: keys[index].id };
  }
  if (!first) throw new Error(`${sigPath} is signed only by keys that aren't built into the app.`);
  return first;
}

function main(argv) {
  const args = [...argv];
  let keysFile = DEFAULT_KEYS_FILE;
  const at = args.indexOf("--keys-file");
  if (at >= 0) {
    keysFile = resolve(args[at + 1] ?? "");
    args.splice(at, 2);
  }
  try {
    const keys = readKeys(readFileSync(keysFile, "utf8"));
    if (args[0] === "--require" && args.length === 1) {
      const problems = keyProblems(keys);
      if (problems.length) {
        for (const problem of problems) console.error(`::error::${problem}`);
        return 1;
      }
      console.log(`Update keys built in: primary ${keys[0].id}, backup ${keys[1].id}.`);
      return 0;
    }
    if (args[0] === "--verify" && args.length === 2) {
      const problems = keyProblems(keys);
      if (problems.length) throw new Error(problems.join(" "));
      const { role, id } = verifySigned(resolve(args[1]), keys);
      console.log(`${args[1]}.sig verifies with the built-in ${role} key (${id}).`);
      return 0;
    }
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  console.error("usage: node scripts/check-update-keys.mjs --require | --verify <SHA256SUMS.txt> [--keys-file <update-keys.ts>]");
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exit(main(process.argv.slice(2)));
