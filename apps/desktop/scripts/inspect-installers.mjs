// Inspect the shipped installers after packaging (#sj44x5ph): what the v0.5.0
// release gate checked by hand, now on every desktop build, so a gate doesn't
// have to download ~700 MB of installers.
//
//   node scripts/inspect-installers.mjs --release release --version 0.5.0-rc.3 [--platform linux|win|mac]
//
// Per installer it checks the file name, the app/executable name, the version
// (tag) everywhere it is stamped, Windows FileDescription, the .deb control
// fields and md5sums, the Electron fuses of the binary *inside* the installer,
// app.asar (no node_modules, no source maps or sourceMappingURL, no secrets),
// and on macOS the code signature. It writes SHA256SUMS-<platform>.txt (the
// release job checks the downloaded files against it) and a table to
// $GITHUB_STEP_SUMMARY. Exits 1 on any failed check.
//
// Runs with Node 24 (type stripping) because the checks live in
// ../src/inspect-installers.ts, which is unit-tested.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectRuntime } from "./appimage-runtime.mjs";
import {
  debianVersion,
  expectedInstallers,
  inspectAsar,
  parseDebControl,
  parseDesktopEntry,
  peVersionString,
  readAr,
  readAsar,
  summaryMarkdown,
} from "../src/inspect-installers.ts";

const here = dirname(fileURLToPath(import.meta.url));

/* ---------------------------------------------------------------- args --- */
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);
const release = resolve(opt("release", "release"));
const version = opt("version");
const platform = opt("platform", { linux: "linux", win32: "win", darwin: "mac" }[process.platform]);
if (!version || !["linux", "win", "mac"].includes(platform)) {
  console.error("usage: node scripts/inspect-installers.mjs --release <dir> --version <x.y.z[-pre]> [--platform linux|win|mac] [--no-summary] [--no-sums] [--self-test]");
  process.exit(2);
}

// --self-test: prove the inspector fails a broken installer. Copy one real
// installer under the file name of a version it wasn't built for, inspect only
// that file, and pass only if a check of the version stamped *inside* it fails
// (.deb Version, FileVersion, CFBundleShortVersionString, app.asar…).
if (flag("self-test")) {
  const fake = "0.0.0-selftest";
  const real = expectedInstallers(platform, version).find((n) => existsSync(join(release, n)));
  if (!real) {
    console.error(`self-test: no ${platform} installer for ${version} in ${release}`);
    process.exit(1);
  }
  const dir = mkdtempSync(join(tmpdir(), "gumply-selftest-"));
  const renamed = real.replace(version, fake);
  copyFileSync(join(release, real), join(dir, renamed));
  const r = run(process.execPath, [fileURLToPath(import.meta.url), "--release", dir, "--version", fake, "--platform", platform, "--only-present", "--no-summary", "--no-sums"]);
  rmSync(dir, { recursive: true, force: true });
  const caught = r.out.split("\n").filter((l) => /^FAIL .*(?:Version|version|FileVersion)/.test(l));
  const ok = r.status === 1 && caught.length > 0;
  console.log(`${ok ? "ok  " : "FAIL"} self-test: ${real} renamed to ${renamed} ${ok ? "was rejected" : "was NOT rejected"}`);
  for (const line of caught) console.log(`     ${line}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${ok ? "✅" : "❌"} **Self-test:** \`${renamed}\` (really ${version}) ${ok ? `was rejected by ${caught.length} version check(s)` : "was NOT rejected"}.\n`);
  }
  process.exit(ok ? 0 : 1);
}

/* ------------------------------------------------------------- helpers --- */
const results = [];
const check = (target, name, ok, detail = "", warn = false) => {
  results.push({ target, check: name, ok: Boolean(ok), detail: String(detail), ...(warn ? { warn } : {}) });
};
function run(cmd, cmdArgs, options = {}) {
  const r = spawnSync(cmd, cmdArgs, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
  return { status: r.error ? -1 : r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim(), error: r.error };
}
const sha256 = (file) =>
  new Promise((done, fail) => {
    const hash = createHash("sha256");
    createReadStream(file).on("data", (d) => hash.update(d)).on("end", () => done(hash.digest("hex"))).on("error", fail);
  });
const md5 = (file) => createHash("md5").update(readFileSync(file)).digest("hex");
const work = mkdtempSync(join(tmpdir(), "gumply-inspect-"));
const scratch = (name) => {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const fuses = (target, binary) => {
  const r = run(process.execPath, [join(here, "check-fuses.mjs"), binary]);
  const bad = r.out.split("\n").filter((l) => l.startsWith("FAIL")).join("; ");
  check(target, "Electron fuses (shipped binary)", r.status === 0, r.status === 0 ? "all 7 hardened" : bad || r.out.slice(-200));
};
const asar = (target, file) => {
  // #mbim529b: the third-party notices ship next to app.asar (extraResources).
  const notices = join(dirname(file), "THIRD_PARTY_NOTICES.txt");
  const noticesOk = existsSync(notices) && readFileSync(notices, "utf8").startsWith("# Third-party notices");
  check(target, "THIRD_PARTY_NOTICES.txt in resources", noticesOk, noticesOk ? "present" : notices);
  if (!existsSync(file)) return check(target, "app.asar present", false, file);
  for (const r of inspectAsar(readAsar(readFileSync(file)), version, target)) results.push(r);
};

/* ----------------------------------------------------------- installers --- */
const expected = expectedInstallers(platform, version);
const present = existsSync(release) ? readdirSync(release) : [];
const installerExt = { linux: /\.(AppImage|deb)$/, win: /\.exe$/, mac: /\.(dmg|zip)$/ }[platform];
// --only-present (self-test): inspect what's there without requiring the full set.
for (const name of expected.filter((n) => !flag("only-present") || present.includes(n))) {
  check(name, "installer file name", present.includes(name), present.includes(name) ? "present" : "missing");
}
for (const name of present.filter((n) => installerExt.test(n) && !expected.includes(n) && !/^__uninstaller/.test(n))) {
  check(name, "no unexpected installer", false, `not one of ${expected.join(", ")}`);
}

/* ---------------------------------------------------------------- Linux --- */
function inspectDeb(name) {
  const file = join(release, name);
  let members;
  try {
    members = readAr(readFileSync(file));
  } catch (error) {
    return check(name, ".deb is an ar archive", false, error.message);
  }
  const unpack = (prefix, into) => {
    const member = [...members.keys()].find((k) => k.startsWith(prefix));
    if (!member) return false;
    const archive = join(work, `${name}-${member}`);
    writeFileSync(archive, members.get(member));
    return run("tar", ["-xf", archive, "-C", into]).status === 0;
  };
  const ctl = scratch(`${name}-control`);
  const data = scratch(`${name}-data`);
  if (!unpack("control.tar", ctl) || !unpack("data.tar", data)) return check(name, ".deb unpacks", false, [...members.keys()].join(", "));
  const control = parseDebControl(readFileSync(join(ctl, "control"), "utf8"));
  check(name, ".deb Package", control.Package === "gumply", control.Package ?? "(missing)");
  check(name, ".deb Version", control.Version === debianVersion(version), `${control.Version ?? "(missing)"} (want ${debianVersion(version)})`);
  check(name, ".deb License", Boolean(control.License) && control.License.toLowerCase() !== "unknown", control.License ?? "(missing)");
  const sums = existsSync(join(ctl, "md5sums")) ? readFileSync(join(ctl, "md5sums"), "utf8").trim().split("\n") : [];
  const badSums = sums.filter((line) => {
    const [sum, ...rest] = line.split(/\s+/);
    const path = join(data, rest.join(" "));
    return !existsSync(path) || md5(path) !== sum;
  });
  check(name, ".deb md5sums", sums.length > 0 && badSums.length === 0, badSums.length ? badSums.slice(0, 3).join("; ") : `${sums.length} files OK`);
  const binary = join(data, "opt/Gumply/gumply");
  check(name, "Linux binary /opt/Gumply/gumply", existsSync(binary), existsSync(binary) ? "present" : "missing");
  const desktopFile = join(data, "usr/share/applications/gumply.desktop");
  const entry = existsSync(desktopFile) ? parseDesktopEntry(readFileSync(desktopFile, "utf8")) : {};
  check(name, ".desktop Exec", (entry.Exec ?? "").startsWith("/opt/Gumply/gumply"), entry.Exec ?? "(no gumply.desktop)");
  if (existsSync(binary)) fuses(name, binary);
  asar(name, join(data, "opt/Gumply/resources/app.asar"));
}

function inspectAppImage(name) {
  const file = join(release, name);
  chmodSync(file, 0o755);
  // #4ckqijua: the runtime must not need libfuse.so.2 (Ubuntu 22.04+ doesn't ship it).
  const head = Buffer.alloc(4 * 1024 * 1024);
  const fd = openSync(file, "r");
  const read = readSync(fd, head, 0, head.length, 0);
  closeSync(fd);
  const runtime = inspectRuntime(head.subarray(0, read));
  check(name, "AppImage runtime: static type-2, no libfuse2", runtime.ok, runtime.detail);
  const dir = scratch(`${name}-x`);
  // The AppImage runtime unpacks itself; the app is not started.
  const r = run(file, ["--appimage-extract"], { cwd: dir });
  const root = join(dir, "squashfs-root");
  if (r.status !== 0 || !existsSync(root)) return check(name, "AppImage extracts", false, r.out.slice(-200));
  const binary = join(root, "gumply");
  check(name, "Linux binary gumply", existsSync(binary), existsSync(binary) ? "present" : readdirSync(root).join(", "));
  const desktopFile = join(root, "gumply.desktop");
  const entry = existsSync(desktopFile) ? parseDesktopEntry(readFileSync(desktopFile, "utf8")) : {};
  check(name, "AppImage version", entry["X-AppImage-Version"] === version, entry["X-AppImage-Version"] ?? "(missing)");
  if (existsSync(binary)) fuses(name, binary);
  asar(name, join(root, "resources/app.asar"));
}

/* -------------------------------------------------------------- Windows --- */
function sevenZip() {
  for (const candidate of ["7z", "C:\\Program Files\\7-Zip\\7z.exe"]) if (run(candidate, ["i"]).status === 0) return candidate;
  return null;
}

function checkPe(target, buf, what) {
  const description = peVersionString(buf, "FileDescription");
  const fileVersion = peVersionString(buf, "FileVersion");
  const product = peVersionString(buf, "ProductName");
  check(target, `${what} FileDescription`, description === "Gumply", description ?? "(missing)");
  check(target, `${what} FileVersion`, fileVersion === version, fileVersion ?? "(missing)");
  check(target, `${what} ProductName`, product === "Gumply", product ?? "(missing)");
}

function inspectExe(name) {
  const file = join(release, name);
  checkPe(name, readFileSync(file), "installer");
  const z = sevenZip();
  if (!z) return check(name, "7-Zip available", false, "7z not found");
  const nsis = scratch(`${name}-nsis`);
  run(z, ["x", "-y", `-o${nsis}`, file]);
  const plugins = join(nsis, "$PLUGINSDIR");
  const payload = existsSync(plugins) ? readdirSync(plugins).find((n) => /^app-64\.7z$/i.test(n)) : undefined;
  if (!payload) return check(name, "installer payload app-64.7z", false, existsSync(plugins) ? readdirSync(plugins).join(", ") : "no $PLUGINSDIR");
  const app = scratch(`${name}-app`);
  run(z, ["x", "-y", `-o${app}`, join(plugins, payload)]);
  const exes = readdirSync(app).filter((n) => n.toLowerCase().endsWith(".exe"));
  check(name, "app executable Gumply.exe", exes.includes("Gumply.exe"), exes.join(", ") || "none");
  const exe = join(app, "Gumply.exe");
  if (existsSync(exe)) {
    checkPe(name, readFileSync(exe), "Gumply.exe");
    fuses(name, exe);
  }
  asar(name, join(app, "resources/app.asar"));
}

/* ---------------------------------------------------------------- macOS --- */
function plist(app, key) {
  const r = run("plutil", ["-extract", key, "raw", "-o", "-", join(app, "Contents/Info.plist")]);
  return r.status === 0 ? r.out : null;
}

function inspectApp(name, app, arch) {
  check(name, "app bundle Gumply.app", basename(app) === "Gumply.app", basename(app));
  const exe = join(app, "Contents/MacOS/Gumply");
  check(name, "executable Contents/MacOS/Gumply", existsSync(exe), existsSync(exe) ? "present" : readdirSync(join(app, "Contents/MacOS")).join(", "));
  for (const [key, want] of [
    ["CFBundleExecutable", "Gumply"],
    ["CFBundleName", "Gumply"],
    ["CFBundleIdentifier", "app.gumply.desktop"],
    ["CFBundleShortVersionString", version],
    ["CFBundleVersion", version],
  ]) {
    const got = plist(app, key);
    check(name, key, got === want, got ?? "(missing)");
  }
  fuses(name, app);
  // Apple silicon refuses to run code whose signature doesn't match it, so the
  // arm64 ad-hoc signature must survive the fuse flip. Intel builds carry a few
  // unsigned upstream libraries (ShipIt, ffmpeg, swiftshader): reported only.
  const sig = run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
  const last = sig.out.split("\n").filter(Boolean).slice(-2).join(" / ");
  check(name, "codesign --verify --deep --strict", sig.status === 0, last || `exit ${sig.status}`, arch !== "arm64" && sig.status !== 0);
  asar(name, join(app, "Contents/Resources/app.asar"));
}

function findApp(dir) {
  return readdirSync(dir).filter((n) => n.endsWith(".app")).map((n) => join(dir, n))[0];
}

function inspectDmg(name) {
  const mount = scratch(`${name}-mnt`);
  const attach = run("hdiutil", ["attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mount, join(release, name)]);
  if (attach.status !== 0) return check(name, "dmg mounts", false, attach.out.slice(-200));
  try {
    const app = findApp(mount);
    if (!app) return check(name, "dmg holds an .app", false, readdirSync(mount).join(", "));
    inspectApp(name, app, name.includes("-arm64.") ? "arm64" : "x64");
  } finally {
    run("hdiutil", ["detach", mount, "-force"]);
  }
}

function inspectZip(name) {
  const dir = scratch(`${name}-x`);
  const r = run("ditto", ["-x", "-k", join(release, name), dir]);
  if (r.status !== 0) return check(name, "zip extracts", false, r.out.slice(-200));
  const app = findApp(dir);
  if (!app) return check(name, "zip holds an .app", false, readdirSync(dir).join(", "));
  inspectApp(name, app, name.includes("-arm64.") ? "arm64" : "x64");
}

/* ------------------------------------------------------------------ run --- */
const sums = [];
try {
  for (const name of expected.filter((n) => present.includes(n))) {
    if (name.endsWith(".deb")) inspectDeb(name);
    else if (name.endsWith(".AppImage")) inspectAppImage(name);
    else if (name.endsWith(".exe")) inspectExe(name);
    else if (name.endsWith(".dmg")) inspectDmg(name);
    else if (name.endsWith(".zip")) inspectZip(name);
    sums.push(`${await sha256(join(release, name))}  ${name}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (!flag("no-sums") && sums.length) {
  // The release job verifies the downloaded artifacts against these lines.
  writeFileSync(join(release, `SHA256SUMS-${platform}.txt`), `${sums.join("\n")}\n`);
}

const title = `Installer inspection (${platform}, ${version})`;
for (const r of results) console.log(`${r.ok ? "ok  " : r.warn ? "WARN" : "FAIL"} ${r.target}: ${r.check}: ${r.detail}`);
const failed = results.filter((r) => !r.ok && !r.warn);
console.log(`\n${title}: ${results.length} checks, ${failed.length} failed`);
if (!flag("no-summary") && process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryMarkdown(title, results, sums));
process.exit(failed.length === 0 && results.length > 0 ? 0 : 1);
