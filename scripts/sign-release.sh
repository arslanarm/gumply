#!/usr/bin/env bash
# Sign a release's SHA256SUMS.txt and check the .sig as the app will (D44).
# The one code path for desktop.yml's release job and its signing dry run.
#
#   GUMPLY_SIGNING_KEY=<PEM> bash scripts/sign-release.sh <dist dir> [--keys-file <update-keys.ts>]
#
# Without --keys-file the .sig must verify with the keys built into this
# release (apps/desktop/src/update-keys.ts). The key is read from the
# environment by sign-sums.mjs and never printed.
set -euo pipefail
dist=${1:?usage: sign-release.sh <dist dir> [--keys-file <update-keys.ts>]}
shift
if [[ -z "${GUMPLY_SIGNING_KEY:-}" ]]; then
  echo "::error::GUMPLY_SIGNING_KEY isn't set: add it to the 'release' environment (see the wiki page dev/owner-update-signing-keys)."
  exit 1
fi
node scripts/sign-sums.mjs "$dist/SHA256SUMS.txt"
verified=$(node scripts/check-update-keys.mjs --verify "$dist/SHA256SUMS.txt" "$@")
echo "$verified"
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then echo "$verified" >> "$GITHUB_STEP_SUMMARY"; fi
