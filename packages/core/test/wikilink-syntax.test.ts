import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractWikilinks, isWikilinkInner, WIKILINK_INNER, WIKILINK_PART, WIKILINK_TARGET } from "../src/index";

/** #wf4hhfj7: one definition of the inside of `[[…]]`, used everywhere. */

const root = fileURLToPath(new URL("../../..", import.meta.url));
const SOURCES = ["packages/core/src", "packages/core/test", "apps/web/src", "apps/server/src", "apps/desktop/src"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("the shared wikilink syntax", () => {
  it("never matches a line break or a bracket, in any part", () => {
    for (const fragment of [WIKILINK_INNER, WIKILINK_TARGET, WIKILINK_PART]) {
      const one = new RegExp(`^${fragment}$`);
      for (const bad of ["\n", "\r", "[", "]"]) expect(one.test(bad), `${fragment} vs ${JSON.stringify(bad)}`).toBe(false);
      expect(one.test("a")).toBe(true);
    }
    expect(new RegExp(`^${WIKILINK_TARGET}$`).test("|")).toBe(false);
    expect(new RegExp(`^${WIKILINK_TARGET}$`).test("#")).toBe(false);
    expect(new RegExp(`^${WIKILINK_PART}$`).test("#")).toBe(true);
    expect(isWikilinkInner("Page#Head|alias")).toBe(true);
    for (const bad of ["a\nb", "a\r\nb", "a]b", "a[b"]) expect(isWikilinkInner(bad)).toBe(false);
    expect(extractWikilinks("[[A|b\nc]] [[B]]").map((link) => link.targetTitle)).toEqual(["B"]);
  });

  it("no source file writes its own `[[…]]` character class (they drifted once: #pvrx7t6r)", () => {
    // A RegExp literal with `\[\[` followed later by a `[^…]` class is a hand-written
    // copy; build it from WIKILINK_INNER / WIKILINK_TARGET / WIKILINK_PART instead.
    const copy = /\/[^/\n]*\\\[\\\[[^/\n]*\[\^[^/\n]*\/[dgimsuy]*/;
    const offenders: string[] = [];
    for (const dir of SOURCES) {
      for (const file of sourceFiles(join(root, dir))) {
        if (file.endsWith("wikilink-syntax.test.ts")) continue;
        readFileSync(file, "utf8")
          .split("\n")
          .forEach((line, index) => {
            if (!line.trimStart().startsWith("//") && !line.trimStart().startsWith("*") && copy.test(line)) {
              offenders.push(`${relative(root, file)}:${index + 1}: ${line.trim()}`);
            }
          });
      }
    }
    expect(offenders).toEqual([]);
  });
});
