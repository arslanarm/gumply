// Verify the Electron fuses of a built app (#mm59n2yq): the hardening must be
// in the shipped binary, not just in the config. Exits non-zero on any
// mismatch. Used by CI on every platform's artifact.
//   node scripts/check-fuses.mjs <electron executable or .app>
//   node scripts/check-fuses.mjs --release release   (every unpacked app in it:
//     linux-unpacked/<exe>, win-unpacked/<exe>.exe, mac*/<name>.app)
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { FuseV1Options, getCurrentFuseWire } from "@electron/fuses";

/** The packaged apps electron-builder leaves in a release folder. */
function appsIn(release) {
  const found = [];
  for (const dir of readdirSync(release)) {
    const path = join(release, dir);
    if (!statSync(path).isDirectory()) continue;
    if (dir === "linux-unpacked" || dir === "win-unpacked") {
      for (const name of readdirSync(path)) {
        const file = join(path, name);
        const isApp = dir === "win-unpacked" ? /^(gumply|Gumply)\.exe$/.test(name) : name === "gumply";
        if (isApp && statSync(file).isFile()) found.push(file);
      }
    } else if (dir === "mac" || dir.startsWith("mac-")) {
      for (const name of readdirSync(path)) if (name.endsWith(".app")) found.push(join(path, name));
    }
  }
  return found;
}

const args = process.argv.slice(2);
const targets = args[0] === "--release" ? appsIn(args[1] ?? "release") : args;
if (targets.length === 0 || targets.some((target) => !existsSync(target))) {
  console.error("usage: node scripts/check-fuses.mjs <electron executable or .app> | --release <dir>  (nothing found)");
  process.exit(2);
}

// FuseState: 0x30 "0" = disabled, 0x31 "1" = enabled, 0x72 "r" = removed.
const ENABLE = 0x31;
const DISABLE = 0x30;
const expected = {
  RunAsNode: DISABLE,
  EnableCookieEncryption: ENABLE,
  EnableNodeOptionsEnvironmentVariable: DISABLE,
  EnableNodeCliInspectArguments: DISABLE,
  EnableEmbeddedAsarIntegrityValidation: ENABLE,
  OnlyLoadAppFromAsar: ENABLE,
  GrantFileProtocolExtraPrivileges: DISABLE,
};

let failed = false;
for (const target of targets) {
  const wire = await getCurrentFuseWire(target);
  for (const [name, want] of Object.entries(expected)) {
    const got = wire[FuseV1Options[name]];
    const ok = got === want;
    if (!ok) failed = true;
    const label = (state) => (state === ENABLE ? "on" : state === DISABLE ? "off" : `state ${state}`);
    console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${label(got)}${ok ? "" : ` (want ${label(want)})`}`);
  }
  console.log(`${target}\n`);
}
if (failed) {
  console.error("Electron fuses are not hardened (see FAIL above).");
  process.exit(1);
}
console.log(`Electron fuses OK in ${targets.length} app(s).`);
