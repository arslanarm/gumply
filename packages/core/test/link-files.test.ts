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

  // Timing on a shared, loaded machine: compare how the cost grows with the
  // vault instead of against wall-clock budgets (a 50 ms budget failed at
  // 50.2 ms under load ~20). Medians of several runs, after a warm-up.
  it("builds in linear time and resolves in time independent of the vault's size", () => {
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
    const time = (task: () => void, runs = 5) => {
      task(); // warm-up (JIT)
      return median(
        Array.from({ length: runs }, () => {
          const started = performance.now();
          task();
          return performance.now() - started;
        }),
      );
    };
    // `n` files where every name is shared by exactly 7 paths, at any size:
    // a resolve looks at 7 candidates whether the vault is small or large.
    const vault = (n: number) =>
      Array.from({ length: n }, (_, i) => `folder${i % 7}/sub${Math.floor(i / 7) % 13}/image-${Math.floor(i / 7)}.png`);
    const small = vault(2_500);
    const large = vault(20_000);

    const buildSmall = time(() => void new LinkFileIndex(small));
    const buildLarge = time(() => void new LinkFileIndex(large));

    const resolves = (files: string[]) => {
      const index = new LinkFileIndex(files);
      const names = Math.floor(files.length / 7);
      const links = Array.from({ length: 5_000 }, (_, i) => `image-${(i * 7919) % names}.png`);
      return () => {
        for (const link of links) if (index.resolve(link, "folder3/sub4/note.md") === null) throw new Error(link);
      };
    };
    const resolveSmall = time(resolves(small));
    const resolveLarge = time(resolves(large));

    // 8x the files: a linear build is ~8x slower (6.7-13x measured under
    // load ~25, GC included), an O(n²) one ~64x. The limit sits in between.
    expect(buildLarge / Math.max(buildSmall, 0.05)).toBeLessThan(32);
    // A resolve looks only at files of that name: ~1x (1.0-1.4x measured);
    // a full scan would be ~8x (7.9-9.4x measured).
    expect(resolveLarge / Math.max(resolveSmall, 0.05)).toBeLessThan(3);
    // Loose sanity bounds that only a pathological slowdown trips, even under load.
    expect(buildLarge).toBeLessThan(1_000);
    expect(resolveLarge / 5_000).toBeLessThan(5);
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
