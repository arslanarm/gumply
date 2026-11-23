#!/usr/bin/env node
/**
 * Sign a release's SHA256SUMS.txt (update signing, option B;
 * decisions/pending-update-signing).
 *
 *   GUMPLY_SIGNING_KEY="$(cat key.pem)" node scripts/sign-sums.mjs <dir>/SHA256SUMS.txt
 *
 * Writes `<sums>.sig`, one line: `gumply-sig v1 key=<key id> sig=<base64>`,
 * an ed25519 signature over the exact bytes of the sums file. The key id is
 * the first 8 bytes of sha256(the public key's SPKI DER), in hex: the app
 * picks its built-in key (primary or backup) by it.
 *
 * The private key comes from the environment only (an ed25519 PKCS#8 PEM).
 * It is never printed, logged or written anywhere; the output is the `.sig`
 * file and the key id. The signature is checked against the public key before
 * the file is written.
 *
 * Not used by any workflow yet: the release job wires it in once the owner
 * adopts option B and the public keys are in apps/desktop/src/update-keys.ts.
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The key id of a public key (KeyObject). */
export function keyIdOf(publicKey) {
  const der = publicKey.export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex").slice(0, 16);
}

/** The `.sig` line for `sumsBytes`, signed with `privateKeyPem`. */
export function signSums(sumsBytes, privateKeyPem) {
  let privateKey;
  try {
    privateKey = createPrivateKey(privateKeyPem);
  } catch {
    // Never echo the key material back.
    throw new Error("The signing key isn't a valid private key (an ed25519 PKCS#8 PEM is expected).");
  }
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error(`The signing key is ${privateKey.asymmetricKeyType}, not ed25519.`);
  const publicKey = createPublicKey(privateKey);
  const signature = sign(null, sumsBytes, privateKey);
  if (!verify(null, sumsBytes, publicKey, signature)) throw new Error("The signature didn't verify; nothing written.");
  const keyId = keyIdOf(publicKey);
  return { keyId, line: `gumply-sig v1 key=${keyId} sig=${signature.toString("base64")}\n` };
}

function main(argv, env) {
  const sumsPath = argv[0];
  if (!sumsPath || argv.length !== 1) {
    console.error("usage: GUMPLY_SIGNING_KEY=<ed25519 PKCS#8 PEM> node scripts/sign-sums.mjs <SHA256SUMS.txt>");
    return 2;
  }
  const pem = env.GUMPLY_SIGNING_KEY ?? "";
  if (!pem) {
    console.error("GUMPLY_SIGNING_KEY is not set.");
    return 2;
  }
  try {
    const sums = readFileSync(sumsPath);
    if (sums.length === 0) throw new Error(`${sumsPath} is empty.`);
    const { keyId, line } = signSums(sums, pem);
    writeFileSync(`${sumsPath}.sig`, line);
    console.log(`Signed ${sumsPath} with key ${keyId}: ${sumsPath}.sig`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2), process.env));
