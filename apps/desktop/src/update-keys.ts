import type { UpdatePublicKey } from "./update-signature.js";

/**
 * The public keys a downloaded update's `SHA256SUMS.txt.sig` must verify
 * against (update signing, option B; decisions/pending-update-signing).
 *
 * EMPTY on purpose: with no keys, updates are not signature-checked (today's
 * behaviour, the checksums from electron-updater's own metadata only). Signing
 * goes live in the build that adds keys here, and from then on every release
 * must carry a valid `SHA256SUMS.txt.sig`.
 *
 * The plan: two ed25519 keys, generated with the owner.
 * - primary: signs releases in CI (its private key in a protected
 *   "release" environment);
 * - backup: kept offline, used only if the primary is lost or leaked. A
 *   release signed with the backup is accepted by every app that has both
 *   keys, and the next release can ship a new pair (rotation).
 *
 * Public keys only, `{ id: keyIdOf(spkiDer), spki: spkiDer.toString("base64") }`.
 * Never put a private key, or a test key, in this file.
 */
export const UPDATE_PUBLIC_KEYS: readonly UpdatePublicKey[] = [];
