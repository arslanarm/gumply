#!/usr/bin/env node
/**
 * Set (or check) the release version everywhere in one step (#quax5vwn).
 *
 *   node scripts/set-version.mjs 0.9.0-rc.1          # set it, print what changed
 *   node scripts/set-version.mjs --check 0.9.0-rc.1  # exit 1 if any place differs
 *   (--root <dir> for another checkout; tests use it)
 *
 * The places: the root and every workspace `package.json` (from the root's
 * `workspaces` globs), `package-lock.json`'s own version and its root (`""`)
 * and workspace entries, and `CORE_VERSION` in packages/core/src/index.ts.
 *
 * Only the version value on those lines changes: nothing is re-serialised, so
 * every other byte (spacing, key order, line endings, the final newline)
 * stays. Lockfile entries for dependencies (`node_modules/…`) are never
 * touched, even at the same version. Everything is found and checked before
 * anything is written: a place found 0 or several times is an error.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Lines with their own endings (CRLF or LF, and no newline at the end) kept. */
const linesOf = (text) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

/** Replace the quoted value on one line, keeping everything around it. */
const withValue = (line, version) => line.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);

/** The workspace folders (relative, "/"-separated), from the root package.json globs (`dir/*` or a plain dir). */
export function workspacesOf(root) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const globs = Array.isArray(pkg.workspaces) ? pkg.workspaces : (pkg.workspaces?.packages ?? []);
  const found = [];
  for (const glob of globs) {
    if (glob.endsWith("/*")) {
      const dir = glob.slice(0, -2);
      if (!existsSync(join(root, dir))) continue;
      for (const name of readdirSync(join(root, dir)).sort()) {
        if (existsSync(join(root, dir, name, "package.json"))) found.push(`${dir}/${name}`);
      }
    } else if (existsSync(join(root, glob, "package.json"))) {
      found.push(glob);
    }
  }
  return found.sort();
}

/**
 * Every version place: `{ file, line (0-based), current }`, grouped per file.
 * Throws when a place is missing or ambiguous.
 */
export function findPlaces(root) {
  const workspaces = workspacesOf(root);
  const places = [];
  const read = (file) => linesOf(readFileSync(join(root, file), "utf8"));

  // package.json files: the single top-level "version" line (two-space indent).
  for (const dir of ["", ...workspaces]) {
    const file = dir ? `${dir}/package.json` : "package.json";
    const hits = [];
    read(file).forEach((line, index) => {
      const match = /^ {2}"version"\s*:\s*"([^"]*)"/.exec(line);
      if (match) hits.push({ file, line: index, current: match[1] });
    });
    if (hits.length !== 1) throw new Error(`${file}: expected one top-level "version", found ${hits.length}`);
    places.push(hits[0]);
  }

  // package-lock.json: its own version, then the root ("") and workspace entries only.
  const lockFile = "package-lock.json";
  const wanted = new Set(["", ...workspaces]);
  const lockHits = new Map(); // key ("<top>" or entry path) -> hits
  let inPackages = false;
  let entry = null;
  read(lockFile).forEach((line, index) => {
    if (/^ {2}"packages"\s*:\s*\{/.test(line)) inPackages = true;
    const top = !inPackages && /^ {2}"version"\s*:\s*"([^"]*)"/.exec(line);
    if (top) (lockHits.get("<top>") ?? lockHits.set("<top>", []).get("<top>")).push({ file: lockFile, line: index, current: top[1] });
    const key = inPackages && /^ {4}"([^"]*)"\s*:\s*\{/.exec(line);
    if (key) entry = key[1];
    const inner = inPackages && entry !== null && wanted.has(entry) && /^ {6}"version"\s*:\s*"([^"]*)"/.exec(line);
    if (inner) (lockHits.get(entry) ?? lockHits.set(entry, []).get(entry)).push({ file: lockFile, line: index, current: inner[1] });
  });
  for (const key of ["<top>", ...wanted]) {
    const hits = lockHits.get(key) ?? [];
    const name = key === "<top>" ? "its own version" : key === "" ? 'the root entry ("")' : `the "${key}" entry`;
    if (hits.length !== 1) throw new Error(`${lockFile}: expected one "version" for ${name}, found ${hits.length}`);
    places.push(hits[0]);
  }

  // CORE_VERSION.
  const coreFile = "packages/core/src/index.ts";
  const coreHits = [];
  read(coreFile).forEach((line, index) => {
    const match = /^export const CORE_VERSION = "([^"]*)";/.exec(line);
    if (match) coreHits.push({ file: coreFile, line: index, current: match[1], core: true });
  });
  if (coreHits.length !== 1) throw new Error(`${coreFile}: expected one CORE_VERSION, found ${coreHits.length}`);
  places.push(coreHits[0]);
  return places;
}

/** Set `version` everywhere. Returns the files changed (relative paths). */
export function setVersion(root, version) {
  if (!SEMVER.test(version)) throw new Error(`Not a version: "${version}" (e.g. 0.9.0 or 0.9.0-rc.1)`);
  const places = findPlaces(root); // all found and checked before any write
  const byFile = new Map();
  for (const place of places) (byFile.get(place.file) ?? byFile.set(place.file, []).get(place.file)).push(place);
  const changed = [];
  for (const [file, filePlaces] of byFile) {
    if (filePlaces.every((place) => place.current === version)) continue;
    const lines = linesOf(readFileSync(join(root, file), "utf8"));
    for (const place of filePlaces) {
      lines[place.line] = place.core
        ? lines[place.line].replace(/(CORE_VERSION = ")[^"]*(")/, `$1${version}$2`)
        : withValue(lines[place.line], version);
    }
    writeFileSync(join(root, file), lines.join(""));
    changed.push(file);
  }
  return changed;
}

/** The places whose version isn't `version`. */
export function checkVersion(root, version) {
  return findPlaces(root).filter((place) => place.current !== version);
}

function main(argv) {
  const args = [...argv];
  let root = fileURLToPath(new URL("..", import.meta.url));
  const rootAt = args.indexOf("--root");
  if (rootAt >= 0) {
    root = args[rootAt + 1];
    args.splice(rootAt, 2);
  }
  const check = args[0] === "--check";
  const version = check ? args[1] : args[0];
  if (!version) {
    console.error("usage: node scripts/set-version.mjs [--check] <version> [--root <dir>]");
    return 2;
  }
  try {
    if (check) {
      const wrong = checkVersion(root, version);
      if (wrong.length === 0) {
        console.log(`Every version place is ${version}.`);
        return 0;
      }
      for (const place of wrong) console.error(`${place.file}:${place.line + 1}: ${place.current} (expected ${version})`);
      return 1;
    }
    const changed = setVersion(root, version);
    if (changed.length === 0) console.log(`Already ${version}; nothing changed.`);
    else for (const file of changed) console.log(`${relative(process.cwd(), join(root, file)) || file}: ${version}`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)));
