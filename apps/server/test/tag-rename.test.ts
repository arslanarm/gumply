import { readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupVaults, createTestServer, getJson, jsonRequest } from "./helpers";

/** #9bx3aznb: rename a tag in every page and board; nothing else changes. */

afterEach(cleanupVaults);

const FILES: Record<string, string> = {
  // Flow list, an unknown key and a comment: only `tags` (and `updated`) change.
  "Flow.md": "---\ntitle: Flow\ntags: [work, other] # mine\nstatus: draft\nupdated: 2026-01-01T00:00:00.000Z\n---\n\nBody #work/ideas and `#work`.\n",
  // Block list, CRLF.
  "Block.md": "---\r\ntags:\r\n  - Work\r\n  - job\r\n---\r\n\r\nMerged into an existing tag.\r\n",
  // Plain Obsidian note: no frontmatter is added for an inline-only rename.
  "Plain.md": "Inline #work, a link [x](#work), a URL https://e.com/#work and #workshop.\n",
  "Untouched.md": "Nothing to see #other.\n",
  ".trash/x/Old.md": "Trashed #work\n",
};

/** @opus-hunter's fixture, measured in real Obsidian 1.14.4 (pane: proj 9 › alpha 3, beta 1; a-b_c 1; y2024 1). */
export const OBSIDIAN_FIXTURE: Record<string, string> = {
  "A.md": "#proj #proj #proj/alpha\n",
  "B.md": "#proj/alpha #proj/beta\n",
  "C.md": "---\ntags: [proj, Proj/Alpha]\n---\n\nNo inline tags.\n",
  "D.md": "#PROJ #2024 #y2024 [link](#anchor) `#incode` #a-b_c\n",
  "E.md": "```#infence``` plus https://x.com/#frag plus #proj\n",
};

describe("GET /tags counts like Obsidian's tags pane (#9bx3aznb)", () => {
  it("counts occurrences (inline repeats, each frontmatter entry), case-folded, first spelling kept", async () => {
    const { app, dir, store } = await createTestServer();
    for (const [name, text] of Object.entries(OBSIDIAN_FIXTURE)) await writeFile(join(dir, name), text);
    await store.rescan();
    const tags = await getJson<Array<{ tag: string; count: number; pages: string[] }>>(app, "/api/tags");
    const byTag = Object.fromEntries(tags.map((entry) => [entry.tag, [entry.count, [...entry.pages].sort()]]));
    expect(byTag).toEqual({
      proj: [5, ["A", "C", "D", "E"]],
      "proj/alpha": [3, ["A", "B", "C"]],
      "proj/beta": [1, ["B"]],
      y2024: [1, ["D"]],
      "a-b_c": [1, ["D"]],
    });
  });
});

describe("renaming changes only the tag bytes (#9bx3aznb, @opus-hunter's P2)", () => {
  async function vault() {
    const server = await createTestServer();
    for (const [name, text] of Object.entries(OBSIDIAN_FIXTURE)) await writeFile(join(server.dir, name), text);
    await server.store.rescan();
    const rename = async (from: string, to: string) =>
      (await (await jsonRequest(server.app, "POST", "/api/tags/rename", { from, to })).json()) as { rewrittenPages: string[] };
    const read = (name: string) => readFile(join(server.dir, name), "utf8");
    const counts = async () =>
      Object.fromEntries(
        (await getJson<Array<{ tag: string; count: number }>>(server.app, "/api/tags")).map((entry) => [entry.tag, entry.count]),
      );
    return { rename, read, counts };
  }

  it("#proj → #work: exact bytes in every file; C's frontmatter gains no updated:", async () => {
    const { rename, read, counts } = await vault();
    expect((await rename("proj", "work")).rewrittenPages.sort()).toEqual(["A", "B", "C", "D", "E"]);
    expect(await read("A.md")).toBe("#work #work #work/alpha\n");
    expect(await read("B.md")).toBe("#work/alpha #work/beta\n");
    expect(await read("C.md")).toBe("---\ntags: [work, work/Alpha]\n---\n\nNo inline tags.\n");
    expect(await read("D.md")).toBe("#work #2024 #y2024 [link](#anchor) `#incode` #a-b_c\n");
    expect(await read("E.md")).toBe("```#infence``` plus https://x.com/#frag plus #work\n");
    expect(await counts()).toEqual({ work: 5, "work/alpha": 3, "work/beta": 1, y2024: 1, "a-b_c": 1 });
  });

  it("a nested tag alone merging into its sibling: #proj/alpha → #proj/beta", async () => {
    const { rename, read, counts } = await vault();
    expect((await rename("proj/alpha", "proj/beta")).rewrittenPages.sort()).toEqual(["A", "B", "C"]);
    expect(await read("A.md")).toBe("#proj #proj #proj/beta\n");
    expect(await read("B.md")).toBe("#proj/beta #proj/beta\n");
    expect(await read("C.md")).toBe("---\ntags: [proj, proj/beta]\n---\n\nNo inline tags.\n");
    expect(await read("D.md")).toBe(OBSIDIAN_FIXTURE["D.md"]);
    expect(await counts()).toEqual({ proj: 5, "proj/beta": 4, y2024: 1, "a-b_c": 1 });
  });

  it("a top-level merge: #y2024 → #a-b_c", async () => {
    const { rename, read, counts } = await vault();
    expect((await rename("y2024", "a-b_c")).rewrittenPages).toEqual(["D"]);
    expect(await read("D.md")).toBe("#PROJ #2024 #a-b_c [link](#anchor) `#incode` #a-b_c\n");
    expect(await counts()).toMatchObject({ "a-b_c": 2 });
    expect(await counts()).not.toHaveProperty("y2024");
  });

  it("a note that has updated: keeps it current; inline-only changes leave frontmatter alone", async () => {
    const { app, dir, store } = await createTestServer();
    await writeFile(join(dir, "G.md"), "---\ntitle: G\nupdated: 2026-01-01T00:00:00.000Z\n---\n\n#proj\n");
    await writeFile(join(dir, "H.md"), "---\nstatus: draft\n---\n\n#proj\n");
    await store.rescan();
    await jsonRequest(app, "POST", "/api/tags/rename", { from: "proj", to: "work" });
    const g = await readFile(join(dir, "G.md"), "utf8");
    expect(g).toMatch(/^---\ntitle: G\nupdated: (?!2026-01-01)[^\n]+\n---\n\n#work\n$/);
    expect(await readFile(join(dir, "H.md"), "utf8")).toBe("---\nstatus: draft\n---\n\n#work\n");
  });
});

describe("renaming a tag (#9bx3aznb)", () => {
  it("rewrites frontmatter and inline tags, byte for byte elsewhere", async () => {
    const { app, dir, store } = await createTestServer();
    await import("node:fs/promises").then(({ mkdir }) => mkdir(join(dir, ".trash", "x"), { recursive: true }));
    for (const [name, text] of Object.entries(FILES)) await writeFile(join(dir, name), text);
    await store.rescan();

    const response = await jsonRequest(app, "POST", "/api/tags/rename", { from: "#work", to: "job" });
    expect(response.status).toBe(200);
    const result = (await response.json()) as { renamed: number; rewrittenPages: string[]; skippedPages: string[] };
    expect(result.rewrittenPages.sort()).toEqual(["Block", "Flow", "Plain"]);
    expect(result).toMatchObject({ renamed: 3, skippedPages: [] });

    const flow = await readFile(join(dir, "Flow.md"), "utf8");
    expect(flow).toMatch(/^---\ntitle: Flow\ntags: \[job, other\] # mine\nstatus: draft\nupdated: [^\n]+\n---\n\nBody #job\/ideas and `#work`.\n$/);
    expect(flow).not.toContain("2026-01-01T00:00:00.000Z");
    const block = await readFile(join(dir, "Block.md"), "utf8");
    expect(block.startsWith("---\r\ntags:\r\n  - job\r\n")).toBe(true);
    expect(block).not.toMatch(/Work/);
    expect(block.endsWith("\r\n\r\nMerged into an existing tag.\r\n")).toBe(true);
    expect(await readFile(join(dir, "Plain.md"), "utf8")).toBe(
      "Inline #job, a link [x](#work), a URL https://e.com/#work and #workshop.\n",
    );
    expect(await readFile(join(dir, "Untouched.md"), "utf8")).toBe(FILES["Untouched.md"]);
    expect(await readFile(join(dir, ".trash/x/Old.md"), "utf8")).toBe(FILES[".trash/x/Old.md"]);

    // The index follows: no page has #work any more.
    const pages = await getJson<Array<{ id: string; tags: string[] }>>(app, "/api/pages");
    expect(pages.flatMap((page) => page.tags).filter((tag) => /^work(\/|$)/i.test(tag))).toEqual([]);
    expect(pages.find((page) => page.id === "Flow")?.tags).toEqual(["job", "other", "job/ideas"]);
  });

  it("renames inside boards: tags, cards, frame and connector labels", async () => {
    const { app, dir, store } = await createTestServer();
    const board = {
      nodes: [
        { id: "a", type: "text", text: "Card #work", x: 0, y: 0, width: 100, height: 50 },
        { id: "g", type: "group", label: "Frame #work/x", x: 0, y: 0, width: 300, height: 300 },
      ],
      edges: [{ id: "e", fromNode: "a", toNode: "g", label: "#work" }],
      gumply: { tags: ["work"] },
    };
    await writeFile(join(dir, "Map.canvas"), JSON.stringify(board));
    await store.rescan();
    const response = await jsonRequest(app, "POST", "/api/tags/rename", { from: "work", to: "job" });
    expect(((await response.json()) as { rewrittenPages: string[] }).rewrittenPages).toEqual(["Map.canvas"]);
    const saved = JSON.parse(await readFile(join(dir, "Map.canvas"), "utf8")) as typeof board;
    expect(saved.nodes.map((node) => ("text" in node ? node.text : node.label))).toEqual(["Card #job", "Frame #job/x"]);
    expect(saved.edges[0]?.label).toBe("#job");
    expect(saved.gumply.tags).toEqual(["job"]);
  });

  it("skips a file another app changed since it was read, and refuses bad names", async () => {
    const { app, dir, store } = await createTestServer();
    await writeFile(join(dir, "A.md"), "#work\n");
    await store.rescan();
    // Changed behind the store's back after the rescan inside the rename:
    // simulated by moving the mtime only (the content check is the scan's job).
    const original = store.renameTag.bind(store);
    let touched = false;
    (store as unknown as { refreshFromDisk: () => Promise<boolean> }).refreshFromDisk = async () => {
      if (!touched) {
        touched = true;
        await utimes(join(dir, "A.md"), new Date(), new Date(Date.now() + 5_000));
      }
      return false;
    };
    const result = await original("work", "job");
    expect(result).toEqual({ renamed: 0, rewrittenPages: [], skippedPages: ["A"] });
    expect(await readFile(join(dir, "A.md"), "utf8")).toBe("#work\n");

    for (const to of ["two words", "2024", "", "a//b"]) {
      const response = await jsonRequest(app, "POST", "/api/tags/rename", { from: "work", to });
      expect(response.status, to).toBe(400);
    }
    expect((await jsonRequest(app, "POST", "/api/tags/rename", { from: "work" })).status).toBe(400);
  });

  it("leaves the ids in `skip` alone (an open page with unsaved edits) and reports them", async () => {
    const { app, dir, store } = await createTestServer();
    await writeFile(join(dir, "Open.md"), "Open #work\n");
    await writeFile(join(dir, "Other.md"), "Other #work\n");
    await store.rescan();
    const response = await jsonRequest(app, "POST", "/api/tags/rename", { from: "work", to: "job", skip: ["Open"] });
    expect(await response.json()).toEqual({ renamed: 1, rewrittenPages: ["Other"], skippedPages: ["Open"] });
    expect(await readFile(join(dir, "Open.md"), "utf8")).toBe("Open #work\n");
    expect(await readFile(join(dir, "Other.md"), "utf8")).toBe("Other #job\n");
    expect((await jsonRequest(app, "POST", "/api/tags/rename", { from: "work", to: "job", skip: "Open" })).status).toBe(400);
  });

  it("is a write: refused from another origin", async () => {
    const { app } = await createTestServer();
    const response = await app.request("/api/tags/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ from: "a", to: "b" }),
    });
    expect(response.status).toBe(403);
  });
});
