import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  evaluateExpression,
  extractWikilinks,
  findInlineTags,
  headingKey,
  isWikilinkInner,
  markdownLinks,
  obsidianFileLinks,
  parseEmbeds,
  plainText,
  WIKILINK_INNER,
  WIKILINK_PART,
  WIKILINK_TARGET,
  type FileInfo,
} from "../src/index";

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
    // A tripwire for RegExp *literals* only: one with `\[\[` followed later by a
    // `[^…]` class on the same line is a hand-written copy; build it from
    // WIKILINK_INNER / WIKILINK_TARGET / WIKILINK_PART instead. It doesn't see
    // `new RegExp("…")` strings, lazy `(.*?)` patterns or literals split by an
    // earlier `/`; the per-call-site table above pins the sites that exist.
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

/**
 * Each former hand-written copy (#wf4hhfj7, plus the four main grew before the
 * merge) pinned to the shared rule: a link split across lines, or with a `[`
 * inside, is plain text everywhere; `![[x#^b|c]]` keeps its target, part and alias.
 */
describe("every core call site follows the shared syntax", () => {
  const SPLIT = "[[A|b\nc]]";
  const BRACKET = "[[a[b]]";
  const BLOCK = "![[x#^b|c]]";

  it("links.ts extractWikilinks", () => {
    expect(extractWikilinks(SPLIT)).toEqual([]);
    expect(extractWikilinks(BRACKET)).toEqual([]);
    expect(extractWikilinks(BLOCK).map((link) => [link.targetTitle, link.embed])).toEqual([["x", true]]);
  });

  it("embeds.ts parseEmbeds", () => {
    expect(parseEmbeds("![[pic\r.png]]")).toEqual([]);
    expect(parseEmbeds("![[a[b.png]]")).toEqual([]);
    expect(parseEmbeds("![[ok.png|20]]").map((embed) => embed.raw)).toEqual(["![[ok.png|20]]"]);
  });

  it("page-embeds.ts headingKey", () => {
    expect(headingKey(SPLIT)).toBe("[[a|b c]]");
    expect(headingKey(BRACKET)).toBe("[[a[b]]");
    expect(headingKey("[[Good#H|Alias]]")).toBe("alias");
  });

  it("plain-text.ts plainText and markdownLinks", () => {
    expect(plainText(SPLIT)).toBe("[[A|b c]]");
    expect(plainText(BRACKET)).toBe("[[a[b]]");
    expect(plainText(BLOCK)).toBe("x#^b");
    expect(markdownLinks(SPLIT)).toEqual([]);
    expect(markdownLinks(BRACKET)).toEqual([]);
    expect(markdownLinks(BLOCK)).toEqual([{ target: "x#^b", text: "c" }]);
  });

  it("tags.ts findInlineTags (a split link doesn't hide a tag)", () => {
    expect(findInlineTags("[[x\r#t]]").map((tag) => tag.tag)).toEqual(["t"]);
    expect(findInlineTags("[[x#t]]")).toEqual([]);
  });

  it("link-files.ts obsidianFileLinks", () => {
    expect(obsidianFileLinks("![[pic\r.png]] ![[a[b.png]] ![[ok.png|20]]", (text) => text)).toEqual(["ok.png"]);
  });

  it("bases/expr.ts linkKey (file.hasLink)", () => {
    const info = { path: "P.md", title: "P", ctime: 0, mtime: 0, tags: [], links: ["a[b.md", "Good.md"], properties: {} } as unknown as FileInfo;
    const run = (source: string) => evaluateExpression(source, { file: info, now: 0 });
    expect(run('file.hasLink("[[Good|x]]")')).toBe(true);
    expect(run('file.hasLink("[[a[b]]")')).toBe(false);
    expect(run('file.hasLink("[[Good\\nx]]")')).toBe(false);
  });
});
