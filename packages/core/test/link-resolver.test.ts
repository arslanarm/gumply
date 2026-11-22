import { describe, expect, it } from "vitest";
import { collectLinkEdges, resolveWikilink } from "../src/links";
import { legacySlugTitle, slugify } from "../src/ids";
import { preferredLinkPath, linkSourceFolder } from "../src/link-order";
import type { PageMeta } from "../src/types";
import { countWork } from "./work-counter";

/**
 * #udbaghb4: resolving every link of a vault must be linear. Before, each of
 * resolveWikilink's checks scanned every page, so a reindex cost links × pages
 * (2000 dangling links: 10.6 s per rescan, saves waiting behind it).
 */

function page(id: string, title?: string, kind: PageMeta["kind"] = "page"): PageMeta {
  return { id, title: title ?? id.split("/").pop()!, kind, tags: [], parentId: null, childCount: 0, created: "", updated: "" } as PageMeta;
}

/**
 * Work for a reindex: `countWork`'s units plus every element read from the
 * page list, which `countWork` can't see (`for…of` loops aren't patched).
 */
function reindexWork(count: number): number {
  const metas = Array.from({ length: count }, (_, i) => page(`Folder ${i % 10}/Note ${i}`));
  let reads = 0;
  const counted = new Proxy(metas, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property)) reads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  // Every page links to a page that doesn't exist (the worst case) and to one that does.
  const units = countWork(() => {
    for (let i = 0; i < count; i++) collectLinkEdges(metas[i]!.id, `See [[Missing ${i}]] and [[Note ${(i + 1) % count}]].`, counted);
  });
  return units + reads;
}

describe("resolveWikilink is linear in the vault (#udbaghb4)", () => {
  it("8× the pages and links costs about 8× the work, not 64×", () => {
    const small = reindexWork(250);
    const large = reindexWork(2000);
    // Linear: about 8; quadratic: about 64. Allow for constant overhead.
    expect(large / small).toBeLessThan(12);
  });

  it("a page list is indexed once: later lookups on the same array read no pages", () => {
    const metas = Array.from({ length: 500 }, (_, i) => page(`Note ${i}`));
    let reads = 0;
    const counted = new Proxy(metas, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) reads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    resolveWikilink("Nothing here", counted);
    const afterFirst = reads;
    for (let i = 0; i < 100; i++) resolveWikilink(`Nothing ${i}`, counted);
    expect(afterFirst).toBeGreaterThan(0);
    expect(reads).toBe(afterFirst);
  });

  it("a page list that grew in place is re-indexed (no stale answer)", () => {
    const metas = [page("Alpha")];
    expect(resolveWikilink("Beta", metas)).toBeNull();
    metas.push(page("Beta"));
    expect(resolveWikilink("Beta", metas)?.id).toBe("Beta");
  });
});

// --- The algorithm before #udbaghb4, verbatim, as the reference ---------------
function normalise(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}
function preferred(a: PageMeta, b: PageMeta, folder: string): boolean {
  const boardA = a.kind === "whiteboard";
  const boardB = b.kind === "whiteboard";
  if (boardA !== boardB) return boardB;
  return preferredLinkPath(a.id, b.id, folder);
}
function referenceResolve(targetTitle: string, pages: readonly PageMeta[], from?: string | null): PageMeta | null {
  const target = normalise(targetTitle);
  if (target.length === 0) return null;
  const folder = linkSourceFolder(from);
  const byTitle = (candidate: PageMeta): string => normalise(candidate.title);
  const byId = (candidate: PageMeta): string => normalise(candidate.id);
  const lastSegment = (candidate: PageMeta): string => normalise(candidate.id.split("/").pop() ?? "");
  const checks: Array<(page: PageMeta) => boolean> = [
    (page) => byId(page) === target,
    (page) => byTitle(page) === target,
    (page) => lastSegment(page) === slugify(targetTitle),
    (page) => lastSegment(page) === target,
    (page) => byId(page).endsWith(`/${slugify(targetTitle)}`),
    (page) => normalise(legacySlugTitle(page.id)) === target,
  ];
  for (const check of checks) {
    let found: PageMeta | null = null;
    for (const page of pages) {
      if (check(page) && (found === null || preferred(page, found, folder))) found = page;
    }
    if (found) return found;
  }
  return null;
}

/** A small deterministic PRNG (mulberry32), so a failure reproduces. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("same answers as before, on random vaults (#udbaghb4, D40)", () => {
  // Names chosen to collide across every check: case, spaces, slugs, legacy slugs, titles that
  // are another page's path, boards with a page's name, the same name in several folders.
  // @opus-hunter's edge cases too: names whose slug is empty or "untitled", apostrophes,
  // tabs and edge spaces, spaces around a `/`.
  const NAMES = [
    "Target", "target", "Five", "five", "Meeting notes", "meeting-notes", "meeting_notes", "Q1 plan", "q1-plan", "Map",
    "Café", "cafe", "Other/Target", "Ünïcode", "a  b", "Untitled",
    "???", "#", "-", "It’s", "It's", "its", "a\tb", "x ", " x",
  ];
  const FOLDERS = ["", "Projects/", "Projects/Sub/", "Other/", "Aaaa/", "Zzzz/", "projects/", "Projects /", "Projects/ Sub/", "a/", "A/"];
  const LINKS = [
    ...NAMES, "Projects/Target", "projects/sub/five", "Map.canvas", "Nothing", "  Target  ", "MEETING NOTES", "q1 plan", "Projects",
    "", " ", "/", "a/x", "A/X", "Projects / Target", "projects/ sub/five", "Tasks.base", "Tasks",
  ];

  for (let seed = 1; seed <= 80; seed++) {
    it(`seed ${seed}`, () => {
      const next = random(seed);
      const pick = <T,>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!;
      const ids = new Set<string>();
      const pages: PageMeta[] = [];
      const count = 5 + Math.floor(next() * 40);
      while (pages.length < count) {
        const board = next() < 0.15;
        const name = pick(NAMES).replace("/", " ");
        const id = `${pick(FOLDERS)}${name}${board ? ".canvas" : ""}`;
        if (ids.has(id)) continue;
        ids.add(id);
        // Sometimes a frontmatter title that differs from the file name.
        const title = next() < 0.3 ? pick(NAMES) : name;
        pages.push(page(id, title, board ? "whiteboard" : "page"));
      }
      // Folders and bases are in the list the server and web pass (`list()`); they're candidates too.
      for (const folder of ["Projects", "a", "A"]) if (!ids.has(folder) && next() < 0.5) pages.push(page(folder, folder, "folder"));
      if (next() < 0.5) pages.push(page(`${pick(FOLDERS)}Tasks.base`, "Tasks", "base"));
      for (const link of LINKS) {
        for (const from of [null, ...pages.slice(0, 6).map((p) => p.id), "Projects/Sub/Deep/Note"]) {
          expect(resolveWikilink(link, pages, from)?.id ?? null, `[[${link}]] from ${from}`).toBe(referenceResolve(link, pages, from)?.id ?? null);
        }
      }
    });
  }
});
