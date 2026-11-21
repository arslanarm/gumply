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
