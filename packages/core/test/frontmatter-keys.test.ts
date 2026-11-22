import { describe, expect, it } from "vitest";
import { frontmatterKey, frontmatterValue, inferPropertyType, isAliasesKey, isTagsKey, parseFrontmatter, tagsValueIssue } from "../src/index.js";
import { editFrontmatterYaml } from "../src/note-template.js";

/** #ippqkgus: `tags` / `aliases` in any case, plural only, the first spelling in file order (Obsidian 1.14.4). */
describe("tags and aliases keys in any case (#ippqkgus)", () => {
  it("recognises the plural in any case, never the singular", () => {
    for (const key of ["tags", "Tags", "TAGS", "tAgS"]) expect(isTagsKey(key)).toBe(true);
    for (const key of ["tag", "Tag", "tags2", "my tags"]) expect(isTagsKey(key)).toBe(false);
    for (const key of ["aliases", "Aliases", "ALIASES"]) expect(isAliasesKey(key)).toBe(true);
    for (const key of ["alias", "Alias"]) expect(isAliasesKey(key)).toBe(false);
  });

  it("the note's own key is the first one in file order", () => {
    expect(frontmatterKey(["title", "Tags", "tags"], "tags")).toBe("Tags");
    expect(frontmatterKey(["tags", "Tags"], "tags")).toBe("tags");
    expect(frontmatterKey(["tag"], "tags")).toBeUndefined();
  });

  it("parses `Tags:` / `TAGS:` as tags, kept under their own key; the first spelling is the one read", () => {
    const caps = parseFrontmatter("---\nTags: [#One, two]\n---\nBody\n").frontmatter;
    expect(caps.Tags).toEqual(["One", "two"]);
    expect(frontmatterValue(caps, "tags")).toEqual(["One", "two"]);
    const block = parseFrontmatter("---\nTAGS:\n  - a\n  - '#b'\n---\n").frontmatter;
    expect(frontmatterValue(block, "tags")).toEqual(["a", "b"]);
    const both = parseFrontmatter("---\ntags: [lower]\nTags: [upper]\n---\n").frontmatter;
    expect(frontmatterValue(both, "tags")).toEqual(["lower"]);
    expect(frontmatterValue(parseFrontmatter("---\ntag: [x]\n---\n").frontmatter, "tags")).toBeUndefined();
  });

  it("writes into the note's own key in place, keeping its spelling and style; never a second key", () => {
    expect(editFrontmatterYaml("Tags: [a] # mine\nstatus: x\n", { tags: ["a", "b"] })).toBe("Tags: [a, b] # mine\nstatus: x\n");
    expect(editFrontmatterYaml("TAGS:\n  - a\nstatus: x\n", { tags: ["c"] })).toBe("TAGS:\n  - c\nstatus: x\n");
    // Two spellings: only the first is written; the second stays byte-exact.
    expect(editFrontmatterYaml("tags: [lower]\nTags: [upper]\n", { tags: ["new"] })).toBe("tags: [new]\nTags: [upper]\n");
    expect(editFrontmatterYaml("Tags: [upper]\ntags: [lower]\n", { tags: ["new"] })).toBe("Tags: [new]\ntags: [lower]\n");
    // A change under either spelling lands on the same key (the later one wins), never two edits.
    expect(editFrontmatterYaml("Tags: [a]\n", { Tags: ["x"], tags: ["y"] })).toBe("Tags: [y]\n");
    // Removal removes the note's own key.
    expect(editFrontmatterYaml("Tags: [a]\nstatus: x\n", { tags: null })).toBe("status: x\n");
    // No tags key yet: lowercase `tags:` is added.
    expect(editFrontmatterYaml("status: x\n", { tags: ["a"] })).toBe("status: x\ntags:\n  - a\n");
    // `Aliases:` the same way.
    expect(editFrontmatterYaml("Aliases: [A]\n", { aliases: ["A", "B"] })).toBe("Aliases: [A, B]\n");
  });

  it("tags values Obsidian 1.14 won't read (#6imze6ux, @opus-hunter's vault-tagstr table)", () => {
    // Read by Obsidian as Gumply does: no issue.
    for (const raw of ["one", "#four", ["seven", "eight"], ["nine", "#ten"], ["2027a", "y2028"], null, []]) {
      expect(tagsValueIssue(raw), JSON.stringify(raw)).toBeNull();
    }
    // A string with spaces or commas: Obsidian reads nothing; the fix is the list Gumply shows.
    expect(tagsValueIssue("two three")).toEqual({ kind: "tags-string", tags: ["two", "three"] });
    expect(tagsValueIssue("five, six")).toEqual({ kind: "tags-string", tags: ["five", "six"] });
    // All-digit tags, in any form.
    expect(tagsValueIssue(2024)).toEqual({ kind: "tags-digits", tags: ["2024"] });
    expect(tagsValueIssue("2029")).toEqual({ kind: "tags-digits", tags: ["2029"] });
    expect(tagsValueIssue(["2024", "ok", "#2025"])).toEqual({ kind: "tags-digits", tags: ["2024", "2025"] });
  });

  it("property types: `Tags` → tags, `Aliases` → aliases; `tag` / `alias` aren't special", () => {
    expect(inferPropertyType("Tags", [["a"]])).toBe("tags");
    expect(inferPropertyType("ALIASES", [["a"]])).toBe("aliases");
    expect(inferPropertyType("tag", [["a"]])).toBe("multitext");
    expect(inferPropertyType("alias", ["a"])).toBe("text");
  });
});
