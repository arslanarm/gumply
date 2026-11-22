import { describe, expect, it } from "vitest";
import { LinkFileIndex, isLinkableFile, obsidianFileLinks, resolveLinkedFile, shortestLinkText } from "../src/link-files.js";
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

  // A work counter, not a clock (#9j9cd5x4): timing tripped at load ~8 even
  // after #wc6ryfte's interleaving, and a count can't change with machine load.
  it("builds in linear work and resolves with work independent of the vault's size", () => {
    /**
     * The work `run` does: one unit per Map get/set/has, plus every element an
     * array search or callback method passes over (`filter`, `some`, `find`,
     * `includes`, `indexOf`, `forEach`, `map`…). The index's own work goes
     * through these; a full scan or a quadratic build would show up here.
     */
    const work = (run: () => void): number => {
      let units = 0;
      const patches: Array<[object, string, unknown]> = [];
      const patch = (proto: object, name: string, cost: (self: unknown) => number) => {
        const original = (proto as Record<string, (...args: unknown[]) => unknown>)[name]!;
        patches.push([proto, name, original]);
        (proto as Record<string, unknown>)[name] = function (this: unknown, ...args: unknown[]) {
          units += cost(this);
          return original.apply(this, args);
        };
      };
      for (const name of ["get", "set", "has"]) patch(Map.prototype, name, () => 1);
      for (const name of ["filter", "some", "every", "find", "findIndex", "includes", "indexOf", "forEach", "map", "reduce"]) {
        patch(Array.prototype, name, (self) => (self as unknown[]).length);
      }
      try {
        run();
      } finally {
        for (const [proto, name, original] of patches.reverse()) (proto as Record<string, unknown>)[name] = original;
      }
      return units;
    };
    // `n` files where every name is shared by exactly 7 paths, at any size:
    // a resolve looks at 7 candidates whether the vault is small or large.
    const vault = (n: number) =>
      Array.from({ length: n }, (_, i) => `folder${i % 7}/sub${Math.floor(i / 7) % 13}/image-${Math.floor(i / 7)}.png`);
    const small = vault(1_000);
    const large = vault(8_000);

    // Build: 8x the files is 8x the work (an O(n²) build would be ~64x), and a few units per file
    // (measured: 6,143 and 49,143 units, ~6 per file: the path check plus the map writes).
    const buildSmall = work(() => void new LinkFileIndex(small));
    const buildLarge = work(() => void new LinkFileIndex(large));
    expect(buildSmall).toBeGreaterThan(0);
    expect(buildLarge).toBeLessThanOrEqual(8 * buildSmall + 8);
    expect(buildLarge / large.length).toBeLessThanOrEqual(10);

    // Resolve: the same links in both vaults cost the same work (only files of
    // that name are looked at); a scan of the vault would be ~8x. Measured: 9 per link
    // (7 candidates plus 2 lookups) in both.
    const resolveWork = (files: string[]) => {
      const index = new LinkFileIndex(files);
      const links = Array.from({ length: 100 }, (_, i) => `image-${(i * 37) % 142}.png`);
      return work(() => {
        for (const link of links) if (index.resolve(link, "folder3/sub4/note.md") === null) throw new Error(link);
      });
    };
    const resolveSmall = resolveWork(small);
    const resolveLarge = resolveWork(large);
    expect(resolveSmall).toBeGreaterThan(0);
    expect(resolveLarge).toBe(resolveSmall);
  });
});

describe("shortestLinkText: the link Obsidian writes, shortest path when possible (#4usgpjh8)", () => {
  const index = new LinkFileIndex([
    "att/mountain.png",
    "Plan.png",
    "Projects/pic.png",
    "Archive/old/pic.png",
    "Notes/img/pic.png",
    "report.pdf",
    "Files/report.pdf",
  ]);
  const link = (path: string, from: string | null = null) => shortestLinkText(path, index, from);

  it("is the bare name when the name is unique", () => {
    expect(link("att/mountain.png")).toBe("mountain.png");
    // A page `Plan.md` doesn't compete: attachment links keep their extension.
    expect(link("Plan.png", "Plan.md")).toBe("Plan.png");
  });

  it("is the bare name when that name resolves to this file anyway, else the full path", () => {
    // Three pic.png: from the root, the bare name goes to the shortest path.
    expect(link("Projects/pic.png")).toBe("pic.png");
    expect(link("Notes/img/pic.png")).toBe("Notes/img/pic.png");
    // From a note in Notes/, its own folder's copy wins the bare name.
    expect(link("Notes/img/pic.png", "Notes/Day.md")).toBe("pic.png");
    expect(link("Projects/pic.png", "Notes/Day.md")).toBe("Projects/pic.png");
    expect(link("Files/report.pdf")).toBe("Files/report.pdf");
    expect(link("report.pdf")).toBe("report.pdf");
  });

  it("is case-insensitive like the resolver", () => {
    const mixed = new LinkFileIndex(["Att/Photo.PNG", "other/photo.png"]);
    // The two names match case-insensitively; the shorter path wins the bare
    // name, and the written name keeps the file's own case.
    expect(shortestLinkText("Att/Photo.PNG", mixed, null)).toBe("Photo.PNG");
    expect(shortestLinkText("other/photo.png", mixed, null)).toBe("other/photo.png");
  });
});
