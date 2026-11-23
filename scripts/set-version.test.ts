import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error -- plain .mjs script without types
import { checkVersion, findPlaces, setVersion, workspacesOf } from "./set-version.mjs";

/**
 * #quax5vwn: the release version is set in exactly its places and nowhere
 * else. A fixture copy of the repo's real files, so the test follows the
 * real layout.
 */
const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILES = [
  "package.json",
  "package-lock.json",
  "apps/desktop/package.json",
  "apps/mcp/package.json",
  "apps/server/package.json",
  "apps/web/package.json",
  "packages/core/package.json",
  "packages/core/src/index.ts",
];

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "gumply-set-version-"));
  dirs.push(root);
  for (const file of FILES) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    copyFileSync(join(repo, file), join(root, file));
  }
  return root;
}

const read = (root: string, file: string) => readFileSync(join(root, file), "utf8");
const current = (root: string) => (findPlaces(root) as Array<{ current: string }>)[0]!.current;

/** Lines that differ between two texts (same line count expected). */
function changedLines(before: string, after: string): Array<[number, string, string]> {
  const a = before.split("\n");
  const b = after.split("\n");
  expect(b.length).toBe(a.length);
  return a.flatMap((line, index) => (line === b[index] ? [] : [[index, line, b[index]!] as [number, string, string]]));
}

describe("scripts/set-version.mjs (#quax5vwn)", () => {
  it("finds the workspaces and all 14 places", () => {
    const root = fixture();
    expect(workspacesOf(root)).toEqual(["apps/desktop", "apps/mcp", "apps/server", "apps/web", "packages/core"]);
    const places = findPlaces(root) as Array<{ file: string }>;
    expect(places).toHaveLength(14); // 6 package.json + 7 in the lockfile + CORE_VERSION
    expect(places.filter((place) => place.file === "package-lock.json")).toHaveLength(7);
  });

  it("changes exactly the version values, and no other byte", () => {
    const root = fixture();
    const from = current(root);
    const before = Object.fromEntries(FILES.map((file) => [file, read(root, file)]));
    const changed = setVersion(root, "9.8.7-rc.1") as string[];
    expect(changed.sort()).toEqual([...FILES].sort());
    for (const file of FILES) {
      const diff = changedLines(before[file]!, read(root, file));
      const expected = file === "package-lock.json" ? 7 : 1;
      expect(diff, file).toHaveLength(expected);
      for (const [, was, now] of diff) {
        // The same line with only the version swapped.
        expect(now, file).toBe(was.replace(`"${from}"`, '"9.8.7-rc.1"'));
      }
      // The file's ending is kept.
      expect(read(root, file).endsWith("\n"), file).toBe(before[file]!.endsWith("\n"));
    }
    expect(checkVersion(root, "9.8.7-rc.1")).toEqual([]);
  });

  it("never touches a dependency that happens to have the same version", () => {
    const root = fixture();
    const from = current(root);
    // A dependency entry at the current version, planted in the lockfile.
    const lock = read(root, "package-lock.json").replace(
      '    "node_modules/@gumply/core": {',
      `    "node_modules/some-dep": {\n      "version": "${from}",\n      "license": "MIT"\n    },\n    "node_modules/@gumply/core": {`,
    );
    writeFileSync(join(root, "package-lock.json"), lock);
    setVersion(root, "9.8.7");
    const after = read(root, "package-lock.json");
    expect(after).toContain(`    "node_modules/some-dep": {\n      "version": "${from}",`);
    expect(changedLines(lock, after)).toHaveLength(7);
  });

  it("keeps CRLF line endings", () => {
    const root = fixture();
    const file = "apps/mcp/package.json";
    const crlf = read(root, file).replace(/\n/g, "\r\n");
    writeFileSync(join(root, file), crlf);
    setVersion(root, "9.8.7");
    const after = read(root, file);
    expect(after.split("\r\n").length).toBe(crlf.split("\r\n").length);
    expect(after).toContain('  "version": "9.8.7",\r\n');
  });

  it("--check reports every place that differs", () => {
    const root = fixture();
    const from = current(root);
    expect(checkVersion(root, from)).toEqual([]);
    expect(checkVersion(root, "9.8.7")).toHaveLength(14);
    setVersion(root, "9.8.7");
    writeFileSync(join(root, "apps/web/package.json"), read(root, "apps/web/package.json").replace('"9.8.7"', `"${from}"`));
    expect((checkVersion(root, "9.8.7") as Array<{ file: string }>).map((place) => place.file)).toEqual(["apps/web/package.json"]);
  });

  it("writes nothing for a bad version, or when a place is missing", () => {
    const root = fixture();
    const before = Object.fromEntries(FILES.map((file) => [file, read(root, file)]));
    expect(() => setVersion(root, "v1.0")).toThrow(/Not a version/);
    // A missing CORE_VERSION: an error, and not even the package.json files are written.
    writeFileSync(join(root, "packages/core/src/index.ts"), "export const OTHER = 1;\n");
    expect(() => setVersion(root, "9.8.7")).toThrow(/CORE_VERSION/);
    for (const file of FILES.filter((name) => name !== "packages/core/src/index.ts")) expect(read(root, file), file).toBe(before[file]);
  });

  it("is a no-op at the same version", () => {
    const root = fixture();
    expect(setVersion(root, current(root))).toEqual([]);
  });
});
