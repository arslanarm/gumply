import { describe, expect, it } from "vitest";
import { LinkFileIndex, isLinkableFile, obsidianFileLinks, resolveLinkedFile } from "../src/link-files.js";
import { maskCode } from "../src/links.js";

/** @opus-hunter's vault, measured in Obsidian 1.14.4 (#8k4ssrkb). */
const FILES = ["x.png", "a/x.png", "a/b/x.png", "c/y.png", "zz/deep/er/y.png", "a/z.png", "zz/deep/er/z.png"];
const NOTES = { root: "root.md", a: "a/na.md", b: "a/b/nb.md", c: "c/nc.md", zz: "zz/nz.md" };

describe("resolving Obsidian file links like Obsidian 1.14.4", () => {
  const index = new LinkFileIndex(FILES);

  it.each([
    // link, from root / a / a/b / c, from zz
    ["x.png", "x.png", "x.png"],
    ["y.png", "c/y.png", "zz/deep/er/y.png"],
    ["z.png", "a/z.png", "zz/deep/er/z.png"],
    ["b/x.png", "a/b/x.png", "a/b/x.png"],
    ["er/y.png", "zz/deep/er/y.png", "zz/deep/er/y.png"],
    ["a/x.png", "a/x.png", "a/x.png"],
  ])("[[%s]]", (link, elsewhere, fromZz) => {
    for (const from of [NOTES.root, NOTES.a, NOTES.c]) expect(index.resolve(link, from), `${link} from ${from}`).toBe(elsewhere);
    expect(index.resolve(link, NOTES.zz)).toBe(fromZz);
  });

  it("an exact vault path wins over a same-named file next to the note", () => {
    // From a/b/nb.md, a/b/x.png sits next to the note; the root x.png is an exact path.
    expect(index.resolve("x.png", NOTES.b)).toBe("x.png");
  });

  it("shortest is string length, not folder depth; ties are a case-insensitive locale compare", () => {
    expect(resolveLinkedFile("w.png", "root.md", ["abcdefghij/w.png", "ab/cd/w.png"])).toBe("ab/cd/w.png");
    expect(resolveLinkedFile("v.png", "root.md", ["b/aaaa/v.png", "zz/v.png"])).toBe("zz/v.png");
    expect(resolveLinkedFile("q.png", "root.md", ["r/q.png", "p/q.png", "m/q.png"])).toBe("m/q.png");
    expect(resolveLinkedFile("t.png", "root.md", ["B/t.png", "a/t.png"])).toBe("a/t.png");
  });

  it("matches case-insensitively and returns the real path", () => {
    const files = ["photo.png", "Att/Pic.PNG", "sub/only.png"];
    for (const link of ["PHOTO.png", "Photo.PNG"]) expect(resolveLinkedFile(link, "root.md", files)).toBe("photo.png");
    for (const link of ["pic.png", "att/pic.png", "ATT/Pic.PNG"]) expect(resolveLinkedFile(link, "root.md", files)).toBe("Att/Pic.PNG");
    for (const link of ["only.PNG", "SUB/ONLY.png"]) expect(resolveLinkedFile(link, "root.md", files)).toBe("sub/only.png");
  });

  it("resolves from the note that holds the link (two notes, same-named images)", () => {
    const files = ["Work/cover.png", "Home/cover.png"];
    expect(resolveLinkedFile("cover.png", "Work/Plan.md", files)).toBe("Work/cover.png");
    expect(resolveLinkedFile("cover.png", "Home/Plan.md", files)).toBe("Home/cover.png");
    // Unknown source: as from the vault root.
    expect(resolveLinkedFile("cover.png", null, files)).toBe("Home/cover.png");
  });

  it("a file added after the scan resolves at once, ranked like the others (#zawz963a)", () => {
    const grown = new LinkFileIndex(["a/x.png"]);
    expect(grown.resolve("new.png", null)).toBeNull();
    grown.add("attachments/new.png");
    grown.add("attachments/new.png");
    grown.add(".trash/old.png");
    expect(grown.size).toBe(2);
    expect(grown.resolve("new.png", null)).toBe("attachments/new.png");
    grown.add("x.png");
    expect(grown.resolve("x.png", "a/na.md")).toBe("x.png");
    expect(grown.resolve("x.png", "c/nc.md")).toBe("x.png");
  });

  it("only attachment files outside dot folders take part", () => {
    expect(isLinkableFile("att/a.png")).toBe(true);
    expect(isLinkableFile("notes/a.md")).toBe(false);
    expect(isLinkableFile("Map.canvas")).toBe(false);
    expect(isLinkableFile("Tasks.base")).toBe(false);
    expect(isLinkableFile(".trash/x/a.png")).toBe(false);
    expect(isLinkableFile(".obsidian/a.png")).toBe(false);
    const files = [".trash/abc/secret.png", ".gumply/conflicts/secret.png", "notes/page.md"];
    expect(resolveLinkedFile("secret.png", "root.md", files)).toBeNull();
    expect(resolveLinkedFile("page.md", "root.md", files)).toBeNull();
    expect(resolveLinkedFile("missing.png", "root.md", FILES)).toBeNull();
  });

  it("tells whether two indexes hold the same files (#jxww67d9)", () => {
    const index = new LinkFileIndex(["a.png", "att/b.pdf"]);
    expect(index.sameFiles(new LinkFileIndex(["att/b.pdf", "a.png", "Note.md"]))).toBe(true);
    expect(index.sameFiles(new LinkFileIndex(["a.png"]))).toBe(false);
    expect(index.sameFiles(new LinkFileIndex(["a.png", "att/b.pdf", "c.png"]))).toBe(false);
    expect(index.sameFiles(new LinkFileIndex(["A.png", "att/b.pdf"]))).toBe(false);
    expect(index.add("c.png")).toBe(true);
    expect(index.add("C.PNG")).toBe(false);
    expect(index.add(".trash/d.png")).toBe(false);
  });

  it("finds the links in a body, as written, outside code", () => {
    const body = "![[photo.png]] and ![[att/pic.png|100]] and [[report.pdf#page=2]] and [[Page]]\n`![[code.png]]`\n";
    expect(obsidianFileLinks(body, maskCode)).toEqual(["photo.png", "att/pic.png", "report.pdf"]);
  });

  it("resolves among 10,000 files in well under a millisecond each", () => {
    const files: string[] = [];
    for (let i = 0; i < 10_000; i += 1) files.push(`folder${i % 97}/sub${i % 13}/image-${i % 1500}.png`);
    // Best of three builds: the suite runs in parallel workers, so one build can be preempted.
    let built = Infinity;
    let big = new LinkFileIndex([]);
    for (let run = 0; run < 3; run += 1) {
      const started = performance.now();
      big = new LinkFileIndex(files);
      built = Math.min(built, performance.now() - started);
    }
    const links = Array.from({ length: 1000 }, (_, i) => `image-${i}.png`);
    const t0 = performance.now();
    for (const link of links) expect(big.resolve(link, "folder3/sub4/note.md")).not.toBeNull();
    const perResolve = (performance.now() - t0) / links.length;
    expect(perResolve).toBeLessThan(1);
    // Rebuilding the index on a rescan (after every save) stays cheap: ~5 ms quiet.
    expect(built).toBeLessThan(50);
  });
});
