import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCanvas, type CanvasBoard } from "@gumply/core";
import { afterEach, describe, expect, it } from "vitest";
import { VaultStore } from "../src/vault-store";
import { cleanupVaults, createTestServer, trackStore } from "./helpers";

afterEach(cleanupVaults);

/** A board file the way Obsidian writes one (tabs, no trailing newline). */
function canvasFile(board: CanvasBoard): string {
  return JSON.stringify(board, null, "\t");
}

const text = (id: string, value: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: "text" as const,
  text: value,
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  ...extra,
});
const card = (id: string, file: string) => ({ id, type: "file" as const, file, x: 300, y: 0, width: 400, height: 300 });

async function vault(files: Record<string, string> = {}) {
  const server = await createTestServer();
  for (const [path, body] of Object.entries(files)) {
    await mkdir(join(server.dir, path, ".."), { recursive: true });
    await writeFile(join(server.dir, path), body, "utf8");
  }
  const store = trackStore(new VaultStore(server.dir));
  await store.init();
  return { ...server, store };
}

describe("boards in the tree (D25, spec/api v1.7)", () => {
  it("creates `<Title>.canvas`; the id keeps the extension; kind is whiteboard", async () => {
    const { store, dir } = await vault({ "Projects.md": "---\ntitle: Projects\n---\nP\n" });
    const created = await store.createBoard({ title: "Project map", parentId: "Projects", icon: "🧭" });
    expect(created.meta).toMatchObject({
      id: "Projects/Project map.canvas",
      kind: "whiteboard",
      title: "Project map",
      icon: "🧭",
      parentId: "Projects",
      childCount: 0,
    });
    expect(created.board).toEqual({ nodes: [], edges: [], gumply: { icon: "🧭" } });
    const onDisk = await readFile(join(dir, "Projects", "Project map.canvas"), "utf8");
    expect(parseCanvas(onDisk)).toEqual(created.board);

    const list = store.list();
    expect(list.find((meta) => meta.id === "Projects")).toMatchObject({ kind: "page", childCount: 1 });
    // Reading a board as a page is refused.
    expect(() => store.get("Projects/Project map.canvas")).toThrow(/whiteboard/);
  });

  it("a new board's title follows its unique file name (#ux5cukze)", async () => {
    const { store, dir } = await vault({});
    const titles = [];
    for (let i = 0; i < 3; i += 1) titles.push((await store.createBoard({ title: "Untitled whiteboard" })).meta.title);
    expect(titles).toEqual(["Untitled whiteboard", "Untitled whiteboard 2", "Untitled whiteboard 3"]);
    // The file name says it all: no `gumply.title` on disk.
    expect(await readFile(join(dir, "Untitled whiteboard 2.canvas"), "utf8")).not.toContain('"title"');
    // A title the file name can't hold keeps it, with the suffix.
    await store.createBoard({ title: "Roadmap: Q3?" });
    expect((await store.createBoard({ title: "Roadmap: Q3?" })).meta).toMatchObject({
      id: "Roadmap Q3 2.canvas",
      title: "Roadmap: Q3? 2",
    });
    expect(store.list().map((meta) => meta.title).sort()).toEqual([
      "Roadmap: Q3?",
      "Roadmap: Q3? 2",
      "Untitled whiteboard",
      "Untitled whiteboard 2",
      "Untitled whiteboard 3",
    ]);
  });

  it("checks title collisions across pages and boards (case-insensitively)", async () => {
    const { store } = await vault({ "Map.md": "Page\n" });
    expect((await store.createBoard({ title: "map" })).meta.id).toBe("map 2.canvas");
    // "Map 2" is taken by the board "map 2", so the page gets the next suffix.
    expect((await store.create({ title: "Map 2" })).id).toBe("Map 2 2");
    // A page can't take an id that reads as a board.
    expect((await store.create({ title: "Plan.canvas" })).id).toBe("Plan.canvas 2");
  });

  it("keeps existing same-name pairs; [[Map]] means the page, [[Map.canvas]] the board", async () => {
    const { store } = await vault({
      "Map.md": "The page\n",
      "Map.canvas": canvasFile({ nodes: [], edges: [] }),
      "Map.canvas.md": "Odd page next to the board\n",
      "Links.md": "[[Map]] and [[Map.canvas]]\n",
    });
    expect(store.list().map((meta) => [meta.id, meta.kind])).toEqual([
      ["Links", "page"],
      ["Map", "page"],
      ["Map.canvas", "whiteboard"],
      ["Map.canvas.md", "page"],
    ]);
    const targets = store.graph().links.filter((link) => link.source === "Links").map((link) => link.target);
    expect(targets.sort()).toEqual(["Map", "Map.canvas"]);
  });

  it("boards can't have sub-pages", async () => {
    const { store } = await vault();
    const board = await store.createBoard({ title: "Board" });
    await expect(store.create({ title: "Child", parentId: board.meta.id })).rejects.toThrow();
    await expect(store.createBoard({ title: "Child", parentId: board.meta.id })).rejects.toThrow(/sub-pages/);
    const page = await store.create({ title: "Page" });
    await expect(store.move(page.id, board.meta.id)).rejects.toThrow(/sub-pages/);
  });
});

describe("links, backlinks, graph and search", () => {
  const files = {
    "Projects.md": "---\ntitle: Projects\n---\nP\n",
    "Projects/Plan.md": "---\ntitle: Plan\n---\nThe plan\n",
    "Other.md": "Other\n",
    "Map.canvas": canvasFile({
      nodes: [
        card("c1", "Projects/Plan.md"),
        text("t1", "See [[Other]] and the **roadmap**", { gumply: { kind: "sticky" }, color: "3" }),
        card("c2", "Missing page.md"),
      ],
      edges: [{ id: "e1", fromNode: "c1", toNode: "t1" }],
    }),
  };

  it("cards and [[links]] on a board are links: backlinks, graph edges, ghosts", async () => {
    const { store } = await vault(files);
    expect(store.backlinks("Projects/Plan").map((item) => item.page.id)).toEqual(["Map.canvas"]);
    expect(store.backlinks("Other").map((item) => item.page)).toEqual([
      expect.objectContaining({ id: "Map.canvas", kind: "whiteboard" }),
    ]);
    const graph = store.graph();
    expect(graph.nodes.find((node) => node.id === "Map.canvas")).toMatchObject({ kind: "whiteboard", linkCount: 2 });
    expect(graph.links).toEqual(
      expect.arrayContaining([
        { source: "Map.canvas", target: "Projects/Plan" },
        { source: "Map.canvas", target: "Other" },
      ]),
    );
    expect(graph.unresolved).toContainEqual({ source: "Map.canvas", targetTitle: "Missing page" });
    // The local graph of a board works too.
    expect(store.graph({ center: "Map.canvas" }).nodes.map((node) => node.id).sort()).toEqual([
      "Map.canvas",
      "Other",
      "Projects/Plan",
    ]);
  });

  it("search finds boards by title and by the text on them, with a snippet", async () => {
    const { store } = await vault(files);
    expect(store.search("map")[0]).toMatchObject({ page: { id: "Map.canvas", kind: "whiteboard" } });
    const byText = store.search("roadmap");
    expect(byText.map((result) => result.page.id)).toEqual(["Map.canvas"]);
    expect(byText[0]!.snippet).toContain("roadmap");
  });

  it("renaming a page rewrites board cards and [[links]] in boards", async () => {
    const { store, dir } = await vault(files);
    const renamed = await store.update("Other", { title: "Other v2" });
    expect(renamed.rewrittenPages).toContain("Map.canvas");
    await store.update("Projects/Plan", { title: "Plan v2" });
    const board = parseCanvas(await readFile(join(dir, "Map.canvas"), "utf8"));
    expect(board.nodes.find((node) => node.id === "c1")).toMatchObject({ file: "Projects/Plan v2.md" });
    expect(board.nodes.find((node) => node.id === "t1")).toMatchObject({
      text: "See [[Other v2]] and the **roadmap**",
      gumply: { kind: "sticky" },
      color: "3",
    });
    expect(store.backlinks("Projects/Plan v2").map((item) => item.page.id)).toEqual(["Map.canvas"]);
  });

  it("moving a page (or renaming its parent) updates the cards that show it", async () => {
    const { store, dir } = await vault(files);
    await store.update("Projects", { title: "Work" });
    let board = parseCanvas(await readFile(join(dir, "Map.canvas"), "utf8"));
    expect(board.nodes[0]).toMatchObject({ file: "Work/Plan.md" });
    await store.move("Work/Plan", null);
    board = parseCanvas(await readFile(join(dir, "Map.canvas"), "utf8"));
    expect(board.nodes[0]).toMatchObject({ file: "Plan.md" });
  });
});

describe("saving, renaming and deleting boards", () => {
  it("saves a board, keeping unknown keys and Obsidian's layout", async () => {
    const { store, dir } = await vault({
      "Map.canvas": canvasFile({ nodes: [text("a", "Hi")], edges: [], obsidianFuture: { x: 1 } } as never),
    });
    const loaded = store.getBoard("Map.canvas");
    const next = { ...loaded.board, nodes: [...loaded.board.nodes, text("b", "Second", { unknownKey: true })] };
    const saved = await store.updateBoard("Map.canvas", { board: next, expectedUpdated: loaded.meta.updated });
    expect(saved.board.nodes.map((node) => node.id)).toEqual(["a", "b"]);
    const raw = await readFile(join(dir, "Map.canvas"), "utf8");
    expect(raw).toContain('"obsidianFuture"');
    expect(raw).toContain('"unknownKey":true');
    expect(raw.startsWith("{\n\t")).toBe(true);
    expect(store.search("second")[0]?.page.id).toBe("Map.canvas");
  });

  it("is conditional like pages (409), and Keep mine backs up the disk version", async () => {
    const { store, dir } = await vault({ "Map.canvas": canvasFile({ nodes: [], edges: [] }) });
    const loaded = store.getBoard("Map.canvas");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(join(dir, "Map.canvas"), canvasFile({ nodes: [text("x", "From Obsidian")], edges: [] }));
    await expect(store.updateBoard("Map.canvas", { board: loaded.board, expectedUpdated: loaded.meta.updated })).rejects.toMatchObject({ status: 409 });
    const forced = await store.updateBoard("Map.canvas", { board: loaded.board, force: true });
    expect(forced.conflictBackup).toMatch(/^\.gumply\/conflicts\/.*\.canvas$/);
    expect(await readFile(join(dir, forced.conflictBackup!), "utf8")).toContain("From Obsidian");
  });

  it("backs up a file with entries a board can't keep before the first save", async () => {
    const original = canvasFile({
      nodes: [text("a", "One"), text("a", "Duplicate id")],
      edges: [{ id: "e", fromNode: "a", toNode: "gone" }],
    });
    const { store, dir } = await vault({ "Odd.canvas": original, "Broken.canvas": "{ not json" });
    const odd = store.getBoard("Odd.canvas");
    expect(odd.board.nodes).toHaveLength(1);
    const saved = await store.updateBoard("Odd.canvas", { board: odd.board });
    expect(saved.repairBackup).toMatch(/\.canvas$/);
    expect(await readFile(join(dir, saved.repairBackup!), "utf8")).toBe(original);
    // Only once.
    expect((await store.updateBoard("Odd.canvas", { board: odd.board })).repairBackup).toBeUndefined();

    // Not JSON Canvas at all: listed as an empty board; saving keeps the original.
    expect(store.getBoard("Broken.canvas").board).toEqual({ nodes: [], edges: [] });
    const fixed = await store.updateBoard("Broken.canvas", { board: { nodes: [text("n", "New")], edges: [] } });
    expect(await readFile(join(dir, fixed.repairBackup!), "utf8")).toBe("{ not json");
  });

  it("renaming a board renames the file, redirects the old id and rewrites links to it", async () => {
    const { store, dir } = await vault({
      "Map.canvas": canvasFile({ nodes: [], edges: [] }),
      "Notes.md": "Open [[Map]] please\n",
      "Index.canvas": canvasFile({ nodes: [card("c", "Map.canvas")], edges: [] }),
    });
    const renamed = await store.updateBoard("Map.canvas", { title: "Roadmap" });
    expect(renamed.meta).toMatchObject({ id: "Roadmap.canvas", title: "Roadmap", kind: "whiteboard" });
    expect(renamed.rewrittenPages).toEqual(expect.arrayContaining(["Index.canvas", "Notes"]));
    expect((await readdir(dir)).sort()).toEqual(expect.arrayContaining(["Roadmap.canvas"]));
    expect(await readFile(join(dir, "Notes.md"), "utf8")).toBe("Open [[Roadmap.canvas|Roadmap]] please\n");
    expect(parseCanvas(await readFile(join(dir, "Index.canvas"), "utf8")).nodes[0]).toMatchObject({ file: "Roadmap.canvas" });
    expect(store.getBoard("Map.canvas").meta.id).toBe("Roadmap.canvas");
    expect(store.backlinks("Roadmap.canvas").map((item) => item.page.id).sort()).toEqual(["Index.canvas", "Notes"]);
  });

  it("sets icon and tags in the top-level gumply object", async () => {
    const { store, dir } = await vault({ "Map.canvas": canvasFile({ nodes: [], edges: [] }) });
    const saved = await store.updateBoard("Map.canvas", { icon: "🧭", tags: ["Plan", "q1"] });
    expect(saved.meta).toMatchObject({ icon: "🧭", tags: ["Plan", "q1"] });
    expect(parseCanvas(await readFile(join(dir, "Map.canvas"), "utf8")).gumply).toEqual({ icon: "🧭", tags: ["Plan", "q1"] });
  });

  it("delete moves the .canvas to trash; restore and move work by id", async () => {
    const { store, dir } = await vault({ "Projects.md": "P\n" });
    const board = await store.createBoard({ title: "Map", parentId: "Projects" });
    const removed = await store.remove(board.meta.id);
    expect(removed.deleted).toEqual(["Projects/Map.canvas"]);
    expect(await readdir(join(dir, "Projects")).catch(() => [])).not.toContain("Map.canvas");
    const restored = await store.restore(removed.trashId);
    expect(restored.restored.map((meta) => [meta.id, meta.kind])).toEqual([["Projects/Map.canvas", "whiteboard"]]);
    const moved = await store.move("Projects/Map.canvas", null);
    expect(moved).toMatchObject({ id: "Map.canvas", kind: "whiteboard", content: "" });
    expect(await readdir(dir)).toContain("Map.canvas");
  });

  it("the watcher picks up boards created, changed and renamed outside Gumply", async () => {
    const { store, dir } = await vault();
    store.startWatching();
    try {
      await writeFile(join(dir, "Outside.canvas"), canvasFile({ nodes: [text("a", "first")], edges: [] }));
      await waitFor(() => store.list().some((meta) => meta.id === "Outside.canvas"));
      await writeFile(join(dir, "Outside.canvas"), canvasFile({ nodes: [text("a", "changed outside")], edges: [] }));
      await waitFor(() => store.search("changed outside").length === 1);
      await rename(join(dir, "Outside.canvas"), join(dir, "Renamed.canvas"));
      await waitFor(() => store.list().some((meta) => meta.id === "Renamed.canvas"));
      expect(store.getBoard("Outside.canvas").meta.id).toBe("Renamed.canvas");
    } finally {
      store.stopWatching();
    }
  });
});

describe("boards API", () => {
  it("POST/GET/PUT /api/boards and 404 on /api/pages for a board", async () => {
    const { app } = await createTestServer();
    const created = await app.request("/api/boards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Map" }),
    });
    expect(created.status).toBe(201);
    const doc = (await created.json()) as { meta: { id: string; updated: string } };
    expect(doc.meta.id).toBe("Map.canvas");
    const id = encodeURIComponent(doc.meta.id);

    expect((await app.request(`/api/pages/${id}`)).status).toBe(404);
    expect((await app.request(`/api/boards/${id}`)).status).toBe(200);

    const put = await app.request(`/api/boards/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ board: { nodes: [text("a", "Hi")], edges: [] }, expectedUpdated: doc.meta.updated }),
    });
    expect(put.status).toBe(200);
    const stale = await app.request(`/api/boards/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ board: { nodes: [], edges: [] }, expectedUpdated: doc.meta.updated }),
    });
    expect(stale.status).toBe(409);
    const bad = await app.request(`/api/boards/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ board: { nodes: "nope" } }),
    });
    expect(bad.status).toBe(400);
    expect((await app.request("/api/boards/Nope.canvas")).status).toBe(404);
  });
});

async function waitFor(predicate: () => boolean, timeout = 4000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for the vault watcher");
}

describe("display titles the file name can't hold (#phvu6zt9)", () => {
  it("keeps `Roadmap: Q3?` in gumply.title of `Roadmap Q3.canvas`, and links use it as the alias", async () => {
    const { store, dir } = await vault({ "Notes.md": "See [[Plan]]\n", "Plan.canvas": canvasFile({ nodes: [], edges: [] }) });
    const renamed = await store.updateBoard("Plan.canvas", { title: "Roadmap: Q3?" });
    expect(renamed.meta).toMatchObject({ id: "Roadmap Q3.canvas", title: "Roadmap: Q3?" });
    const raw = parseCanvas(await readFile(join(dir, "Roadmap Q3.canvas"), "utf8"));
    expect(raw.gumply).toEqual({ title: "Roadmap: Q3?" });
    expect(await readFile(join(dir, "Notes.md"), "utf8")).toBe("See [[Roadmap Q3.canvas|Roadmap: Q3?]]\n");

    // Survives a restart, a save that drops the key (a client), and search.
    const reopened = trackStore(new VaultStore(dir));
    await reopened.init();
    expect(reopened.getBoard("Roadmap Q3.canvas").meta.title).toBe("Roadmap: Q3?");
    const loaded = reopened.getBoard("Roadmap Q3.canvas");
    await reopened.updateBoard("Roadmap Q3.canvas", { board: { nodes: [text("a", "x")], edges: [] }, expectedUpdated: loaded.meta.updated });
    expect(parseCanvas(await readFile(join(dir, "Roadmap Q3.canvas"), "utf8")).gumply).toEqual({ title: "Roadmap: Q3?" });
    expect(reopened.search("roadmap: q3")[0]?.page).toMatchObject({ id: "Roadmap Q3.canvas", title: "Roadmap: Q3?" });
  });

  it("created with such a title, or behind a collision suffix; dropped again when the name says it all", async () => {
    const { store, dir } = await vault({ "Map.md": "Page\n" });
    const created = await store.createBoard({ title: "Ideas / later" });
    expect(created.meta).toMatchObject({ id: "Ideas later.canvas", title: "Ideas / later" });
    expect(created.board.gumply).toEqual({ title: "Ideas / later" });

    // #ux5cukze: behind a collision suffix the title takes the suffix too, so
    // the file name says it all again.
    const suffixed = await store.createBoard({ title: "Map", icon: "🧭" });
    expect(suffixed.meta).toMatchObject({ id: "Map 2.canvas", title: "Map 2" });
    expect(suffixed.board.gumply).toEqual({ icon: "🧭" });

    const plain = await store.updateBoard("Ideas later.canvas", { title: "Ideas" });
    expect(plain.meta).toMatchObject({ id: "Ideas.canvas", title: "Ideas" });
    expect(parseCanvas(await readFile(join(dir, "Ideas.canvas"), "utf8")).gumply).toBeUndefined();
  });

  it("a rename outside Gumply wins over a stale stored title", async () => {
    const { dir } = await vault({
      "Renamed in Obsidian.canvas": canvasFile({ nodes: [], edges: [], gumply: { title: "Roadmap: Q3?" } }),
      "Roadmap Q3 2.canvas": canvasFile({ nodes: [], edges: [], gumply: { title: "Roadmap: Q3?" } }),
    });
    const store = trackStore(new VaultStore(dir));
    await store.init();
    expect(store.getBoard("Renamed in Obsidian.canvas").meta.title).toBe("Renamed in Obsidian");
    // A duplicate suffix still belongs to the stored title.
    expect(store.getBoard("Roadmap Q3 2.canvas").meta.title).toBe("Roadmap: Q3?");
    // The stale key is cleaned up on the next save.
    await store.updateBoard("Renamed in Obsidian.canvas", { board: { nodes: [], edges: [] } });
    expect(parseCanvas(await readFile(join(dir, "Renamed in Obsidian.canvas"), "utf8")).gumply).toBeUndefined();
  });
});
