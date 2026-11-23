import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { historyDir, readHistory } from "../src/history";
import { VaultStore } from "../src/vault-store";

/**
 * #xgnvipyd (1.0 gap N9): a title rename rewrites the links to it in batches,
 * each its own queued task, so other saves run in between; the rename stays
 * correct (a page saved or edited outside mid-rewrite keeps its text and gets
 * the new link) and the renamed page itself waits for it.
 */
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function vault(linkers: number, extra: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "gumply-rename-yield-"));
  dirs.push(dir);
  await writeFile(join(dir, "Hub.md"), "The hub.\n");
  await writeFile(join(dir, "Other.md"), "Other page.\n");
  await mkdir(join(dir, "L"));
  for (let i = 0; i < linkers; i += 100) {
    await Promise.all(
      Array.from({ length: Math.min(100, linkers - i) }, (_, j) => writeFile(join(dir, "L", `Linker ${i + j}.md`), `See [[Hub]] (${i + j}).\n`)),
    );
  }
  for (const [name, body] of Object.entries(extra)) await writeFile(join(dir, name), body);
  const store = new VaultStore(dir);
  await store.init();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  return { dir, store };
}

/** The linking page the rewrite reaches last (the batches go in the store's own order). */
const lastLinker = (store: VaultStore) => [...(store as unknown as { pages: Map<string, unknown> }).pages.keys()].filter((id) => id.startsWith("L/")).at(-1)!;

// Each builds hundreds of files: generous under a parallel full run.
describe("a rename lets other saves through (#xgnvipyd)", { timeout: 60_000 }, () => {
  it("a save to another page sent during a 1,500-link rename answers in under a second, before the rename ends", async () => {
    const { dir, store } = await vault(1500);
    const started = Date.now();
    let renameEnded = 0;
    const rename = store.update("Hub", { title: "Hub renamed" }).then((page) => {
      renameEnded = Date.now();
      return page;
    });
    // Once the rename has started rewriting (its first batch is done), save another page.
    await vi.waitFor(() => expect(store.renameBatchesRun).toBeGreaterThan(0), { timeout: 10_000, interval: 5 });
    const sent = Date.now();
    await store.update("Other", { content: "Edited during the rename." });
    const saved = Date.now();
    const renamed = await rename;

    expect(saved - sent, "the save waited at most one batch").toBeLessThan(1000);
    expect(saved).toBeLessThan(renameEnded);
    expect(store.renameBatchesRun).toBeGreaterThan(1);
    expect(renamed.rewrittenPages).toHaveLength(1500);
    expect(await readFile(join(dir, "L", "Linker 1499.md"), "utf8")).toContain("[[Hub renamed]]");
    expect(await readFile(join(dir, "Other.md"), "utf8")).toContain("Edited during the rename.");
    // The interleaved save is an ordinary edit in history, not part of the rename.
    const otherHistory = await readHistory(historyDir(dir, "Other"));
    expect(otherHistory.entries.map((entry) => entry.reason)).not.toContain("rename");
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 60_000);

  it("a linking page saved between batches keeps the user's text and gets the new link", async () => {
    const { dir, store } = await vault(600);
    const target = lastLinker(store);
    let edited = false;
    store.afterRenameBatch = async () => {
      if (edited) return;
      edited = true;
      const page = store.get(target);
      expect(page.content).toContain("[[Hub]]"); // not reached yet
      await store.update(target, { content: `${page.content}\nMy line, typed mid-rename.\n`, expectedUpdated: page.updated });
    };
    const renamed = await store.update("Hub", { title: "Hub renamed" });
    const text = await readFile(join(dir, `${target}.md`), "utf8");
    expect(text).toContain("My line, typed mid-rename.");
    expect(text).toContain("[[Hub renamed]]");
    expect(text).not.toContain("[[Hub]]");
    expect(renamed.rewrittenPages).toContain(target);
  });

  it("a linking page changed outside before its batch: the outside text is kept, and the link rewritten in it", async () => {
    const { dir, store } = await vault(600);
    const target = lastLinker(store);
    const file = join(dir, `${target}.md`);
    let edited = false;
    store.afterRenameBatch = async () => {
      if (edited) return;
      edited = true;
      // Another program writes it; the watcher isn't running, so only the rename's re-check can see it.
      await writeFile(file, "Rewritten by another app: see [[Hub]] and more.\n");
      const later = new Date(Date.now() + 5_000);
      await utimes(file, later, later);
    };
    await store.update("Hub", { title: "Hub renamed" });
    expect(await readFile(file, "utf8")).toBe("Rewritten by another app: see [[Hub renamed]] and more.\n");
  });

  it("the renamed page waits for its rename: a second rename of it runs after the first, from its result", async () => {
    const { dir, store } = await vault(500);
    const first = store.update("Hub", { title: "Hub renamed" });
    await vi.waitFor(() => expect(store.renameBatchesRun).toBeGreaterThan(0), { timeout: 10_000, interval: 5 });
    // By its old id, as a client that hasn't heard of the first rename yet.
    const second = store.update("Hub", { title: "Hub three" });
    const [a, b] = await Promise.all([first, second]);
    expect(a.id).toBe("Hub renamed");
    expect(b.id).toBe("Hub three");
    expect(await readFile(join(dir, "L", "Linker 499.md"), "utf8")).toContain("[[Hub three]]");
  });

  it("a deleted linking page mid-rename is skipped, not recreated", async () => {
    const { dir, store } = await vault(600);
    const target = lastLinker(store);
    let removed = false;
    store.afterRenameBatch = async () => {
      if (removed) return;
      removed = true;
      await store.remove(target);
    };
    const renamed = await store.update("Hub", { title: "Hub renamed" });
    expect(renamed.rewrittenPages).not.toContain(target);
    await expect(readFile(join(dir, `${target}.md`), "utf8")).rejects.toThrow();
  });
});

// Each builds hundreds of files: generous under a parallel full run.
describe("while the batches run, the old name still means the renamed page (#xgnvipyd, spec/api v1.35)", { timeout: 60_000 }, () => {
  it("backlinks list every linker, the graph has no ghost, and GET /pages says which rename is running", async () => {
    const { dir, store } = await vault(600);
    const app = createApp({ vaultPath: dir, store });
    let checked = false;
    store.afterRenameBatch = async () => {
      if (checked) return;
      checked = true;
      // Most linking pages still say [[Hub]] here.
      expect((await readFile(join(dir, `${lastLinker(store)}.md`), "utf8"))).toContain("[[Hub]]");
      expect(new Set(store.backlinks("Hub renamed").map((link) => link.page.id)).size).toBe(600);
      const graph = store.graph();
      expect(graph.nodes.some((node) => node.id === "Hub renamed")).toBe(true);
      expect(graph.nodes.filter((node) => /^hub$/i.test(node.title ?? "") && node.id !== "Hub renamed")).toEqual([]);
      const response = await app.request("/api/pages");
      expect(JSON.parse(decodeURIComponent(response.headers.get("X-Gumply-Renaming")!))).toEqual([{ fromTitle: "Hub", fromId: "Hub", to: "Hub renamed" }]);
    };
    await store.update("Hub", { title: "Hub renamed" });
    expect(checked).toBe(true);
    // Done: no alias left, and every link really says the new name.
    expect(store.renamesInProgress).toEqual([]);
    expect((await app.request("/api/pages")).headers.get("X-Gumply-Renaming")).toBeNull();
    expect(new Set(store.backlinks("Hub renamed").map((link) => link.page.id)).size).toBe(600);
  });

  it("a rename whose first step fails after capturing its rewrite leaves no alias and no hold behind", async () => {
    const { store } = await vault(50);
    const internals = store as unknown as { reindexAll: () => void };
    vi.spyOn(internals, "reindexAll").mockImplementationOnce(() => {
      throw new Error("index failed (test)");
    });
    await expect(store.update("Hub", { title: "Hub renamed" })).rejects.toThrow(/index failed/);
    expect(store.renamesInProgress).toEqual([]);
    // Nothing still holds the page: renaming it again goes through (by its id now, as moved).
    const id = store.list().find((meta) => meta.title === "Hub renamed" || meta.title === "Hub")!.id;
    const again = await store.update(id, { title: "Hub again" });
    expect(again.id).toBe("Hub again");
    expect(store.renamesInProgress).toEqual([]);
  });

  it("a page really named like the old title, created mid-rename, takes its links from then on", async () => {
    const { dir, store } = await vault(300);
    store.afterRenameBatch = async () => {
      if (store.list().some((meta) => meta.id === "Hub")) return;
      await store.create({ title: "Hub", content: "A new hub." });
    };
    await store.update("Hub", { title: "Hub renamed" });
    // The links written before the rename were to the old page: they follow it.
    expect(await readFile(join(dir, "L", "Linker 299.md"), "utf8")).toContain("[[Hub renamed]]");
    expect(store.renamesInProgress).toEqual([]);
  });
});

// Each builds hundreds of files: generous under a parallel full run.
describe("@opus-editor's review cases (#xgnvipyd)", { timeout: 60_000 }, () => {
  it("moving the renamed page's parent waits for the rename; links end on its final id, its own body untouched", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gumply-rename-yield-"));
    dirs.push(dir);
    await mkdir(join(dir, "Area"));
    await writeFile(join(dir, "Area.md"), "The area.\n");
    await writeFile(join(dir, "Area", "Hub.md"), "The hub, see [[Hub]] itself.\n");
    await writeFile(join(dir, "Shelf.md"), "Shelf.\n");
    await mkdir(join(dir, "L"));
    for (let i = 0; i < 400; i++) await writeFile(join(dir, "L", `Linker ${i}.md`), `See [[Hub]] (${i}).\n`);
    const store = new VaultStore(dir);
    await store.init();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const order: string[] = [];
    let move: Promise<unknown> | null = null;
    store.afterRenameBatch = async () => {
      move ??= store.move("Area", "Shelf").then(() => order.push("move"));
    };
    await store.update("Area/Hub", { title: "Hub renamed" }).then(() => order.push("rename"));
    await move;
    expect(order).toEqual(["rename", "move"]);
    expect(store.get("Shelf/Area/Hub renamed").content).toContain("[[Hub]] itself"); // its own body isn't rewritten
    expect(await readFile(join(dir, "L", "Linker 399.md"), "utf8")).toMatch(/\[\[(Shelf\/Area\/)?Hub renamed/);
  });

  it("a page that appears mid-rename with a link to the old name (a duplicate, a restore) gets the new link too", async () => {
    const { dir, store } = await vault(400);
    let created = false;
    store.afterRenameBatch = async () => {
      if (created) return;
      created = true;
      await store.create({ title: "Copy of a linker", content: "See [[Hub]] (copy)." });
    };
    const renamed = await store.update("Hub", { title: "Hub renamed" });
    expect(await readFile(join(dir, "Copy of a linker.md"), "utf8")).toContain("[[Hub renamed]] (copy)");
    expect(renamed.rewrittenPages).toContain("Copy of a linker");
  });

  it("a path-form link to the old id counts as a backlink during the window", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gumply-rename-yield-"));
    dirs.push(dir);
    await mkdir(join(dir, "Area"));
    await writeFile(join(dir, "Area", "Hub.md"), "The hub.\n");
    await writeFile(join(dir, "Hub.md"), "Another page titled Hub.\n");
    await mkdir(join(dir, "L"));
    for (let i = 0; i < 300; i++) await writeFile(join(dir, "L", `Linker ${i}.md`), `See [[Area/Hub|Hub]] (${i}).\n`);
    const store = new VaultStore(dir);
    await store.init();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let mid = -1;
    store.afterRenameBatch = async () => {
      if (mid < 0) mid = new Set(store.backlinks("Area/Hub renamed").map((link) => link.page.id)).size;
    };
    await store.update("Area/Hub", { title: "Hub renamed" });
    expect(mid).toBe(300);
    expect(new Set(store.backlinks("Area/Hub renamed").map((link) => link.page.id)).size).toBe(300);
  });

  it("a write error on one page is logged and skipped: the other pages still get their links, the rename succeeds", async () => {
    const { dir, store } = await vault(300);
    const internals = store as unknown as { writeRewrittenBody: (...args: unknown[]) => Promise<void> };
    const real = internals.writeRewrittenBody.bind(store);
    let failedOnce = false;
    vi.spyOn(internals, "writeRewrittenBody").mockImplementation(async (...args: unknown[]) => {
      const record = args[0] as { id: string };
      if (!failedOnce && record.id === "L/Linker 10") {
        failedOnce = true;
        throw new Error("EACCES (test)");
      }
      return real(...args);
    });
    const renamed = await store.update("Hub", { title: "Hub renamed" });
    expect(renamed.rewrittenPages).not.toContain("L/Linker 10");
    expect(renamed.rewrittenPages).toHaveLength(299);
    expect(await readFile(join(dir, "L", "Linker 11.md"), "utf8")).toContain("[[Hub renamed]]");
    expect(await readFile(join(dir, "L", "Linker 10.md"), "utf8")).toContain("[[Hub]]");
  });

  it("settleRenames waits for a running rename, bounded", async () => {
    const { store } = await vault(300);
    expect(await store.settleRenames(10)).toBe(true); // nothing running
    const rename = store.update("Hub", { title: "Hub renamed" });
    await vi.waitFor(() => expect(store.renameBatchesRun).toBeGreaterThan(0), { timeout: 10_000, interval: 5 });
    expect(await store.settleRenames(30_000)).toBe(true);
    await rename;
  });
});

describe("boards and bases rename in batches too (#xgnvipyd)", { timeout: 60_000 }, () => {
  it("a board's rename rewrites the links to it across batches", async () => {
    const { dir, store } = await vault(0);
    await mkdir(join(dir, "B"), { recursive: true });
    for (let i = 0; i < 300; i++) await writeFile(join(dir, "B", `Ref ${i}.md`), `Map: [[Map.canvas]] (${i}).\n`);
    await writeFile(join(dir, "Map.canvas"), '{"nodes":[],"edges":[]}');
    await store.rescan();
    const renamed = await store.updateBoard("Map.canvas", { title: "Atlas" });
    expect(renamed.meta.id).toBe("Atlas.canvas");
    expect(store.renameBatchesRun).toBeGreaterThan(1);
    expect(await readFile(join(dir, "B", "Ref 299.md"), "utf8")).toContain("[[Atlas.canvas");
  });

  it("a base's rename rewrites its embeds", async () => {
    const { dir, store } = await vault(0, { "Tasks.base": "views:\n  - type: table\n    name: Table\n", "Home.md": "![[Tasks.base]]\n" });
    const renamed = await store.updateBase("Tasks.base", { title: "Todo" });
    expect(renamed.meta.id).toBe("Todo.base");
    expect(await readFile(join(dir, "Home.md"), "utf8")).toContain("![[Todo.base");
  });
});
