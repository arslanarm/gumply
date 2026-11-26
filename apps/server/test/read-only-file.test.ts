import { chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { historyDir, readHistory } from "../src/history";
import { cleanupVaults, createTestServer, jsonRequest } from "./helpers";

/**
 * #bajn9rna (found by the #yy35bfac hunt): a file the user or another tool made
 * read-only is never replaced. On Unix the atomic temp + rename needs only a
 * writable folder, so a save used to replace a `chmod 444` page and drop its
 * mode. Now the save is refused with 423 and nothing is written (no temp file,
 * the bytes and the mode kept); once the file is writable it saves again.
 * Root ignores file modes, so these run only as a normal user.
 */

afterEach(cleanupVaults);

const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
const mode = async (file: string) => (await stat(file)).mode & 0o777;
const temps = async (dir: string) => (await readdir(dir)).filter((name) => name.startsWith(".~gumply"));

describe.skipIf(asRoot)("a read-only file is never replaced (#bajn9rna)", () => {
  it("a page: the save is refused (423), the file keeps its bytes and its mode, no temp file; it saves once writable", async () => {
    const { store, dir } = await createTestServer();
    const page = await store.create({ title: "Ledger", content: "Balance: ten." });
    const file = join(dir, `${page.id}.md`);
    const before = await readFile(file, "utf8");
    await chmod(file, 0o444);
    const refused = await store.update(page.id, { content: "Balance: ten. Mine.", expectedUpdated: page.updated }).then(
      () => null,
      (error: { status?: number; message: string }) => error,
    );
    expect(refused?.status).toBe(423);
    expect(refused?.message).toMatch(/read-only/);
    expect(await readFile(file, "utf8")).toBe(before);
    expect(await mode(file)).toBe(0o444);
    expect(await temps(dir)).toEqual([]);

    await chmod(file, 0o644);
    await store.update(page.id, { content: "Balance: ten. Mine.", expectedUpdated: page.updated });
    expect(await readFile(file, "utf8")).toContain("Mine.");
  });

  it("over HTTP: PUT /api/pages/:id answers 423 with the reason", async () => {
    const { app, store, dir } = await createTestServer();
    const page = await store.create({ title: "Ledger", content: "Balance: ten." });
    await chmod(join(dir, `${page.id}.md`), 0o444);
    const response = await jsonRequest(app, "PUT", `/api/pages/${encodeURIComponent(page.id)}`, { content: "x", expectedUpdated: page.updated });
    expect(response.status).toBe(423);
    expect(((await response.json()) as { error: string }).error).toMatch(/read-only/);
    await chmod(join(dir, `${page.id}.md`), 0o644);
  });

  it("a heading rename with a read-only linking page: the save is done, the other pages are rewritten, the read-only one is kept (@graph-dev)", async () => {
    const { store, dir } = await createTestServer();
    await writeFile(join(dir, "Plan.md"), "# Plan\n\n## Goals\n\nShip it.\n");
    await writeFile(join(dir, "Notes.md"), "Read [[Plan#Goals]].\n");
    await writeFile(join(dir, "Daily.md"), "Today: [[Plan#Goals]].\n");
    await store.rescan();
    const notes = join(dir, "Notes.md");
    await chmod(notes, 0o444);
    try {
      const plan = store.get("Plan");
      const saved = await store.update("Plan", { content: plan.content.replace("## Goals", "## Objectives"), expectedUpdated: plan.updated });
      expect(saved.rewrittenPages).toEqual(["Daily"]);
      expect(await readFile(join(dir, "Plan.md"), "utf8")).toContain("## Objectives");
      expect(await readFile(join(dir, "Daily.md"), "utf8")).toBe("Today: [[Plan#Objectives]].\n");
      expect(await readFile(notes, "utf8")).toBe("Read [[Plan#Goals]].\n");
      expect(await mode(notes)).toBe(0o444);
    } finally {
      await chmod(notes, 0o644);
    }
  });

  // #bbh3n5p7: the answer names the pages whose links were left as they were, so the app can say so.
  it("the answers name a read-only linking page in linksNotRewritten: a heading rename, a title rename, a folder rename", async () => {
    const { store, dir } = await createTestServer();
    await writeFile(join(dir, "Plan.md"), "# Plan\n\n## Goals\n\nShip it.\n");
    await mkdir(join(dir, "Box"), { recursive: true });
    await writeFile(join(dir, "Box", "Inside.md"), "Inside.\n");
    await writeFile(join(dir, "Notes.md"), "Read [[Plan#Goals]], [[Plan]] and [[Box/Inside]].\n");
    await writeFile(join(dir, "Daily.md"), "Today: [[Plan#Goals]], [[Plan]] and [[Box/Inside]].\n");
    await store.rescan();
    const notes = join(dir, "Notes.md");
    await chmod(notes, 0o444);
    try {
      const plan = store.get("Plan");
      const heading = await store.update("Plan", { content: plan.content.replace("## Goals", "## Objectives"), expectedUpdated: plan.updated });
      expect((heading as { linksNotRewritten?: string[] }).linksNotRewritten).toEqual(["Notes"]);
      expect(heading.rewrittenPages).toEqual(["Daily"]);

      const title = await store.update("Plan", { title: "Plan 2026" });
      await store.settleRenames?.(10_000);
      expect((title as { linksNotRewritten?: string[] }).linksNotRewritten).toEqual(["Notes"]);

      const folder = await store.update("Box", { title: "Crate" });
      await store.settleRenames?.(10_000);
      expect((folder as { linksNotRewritten?: string[] }).linksNotRewritten).toEqual(["Notes"]);
      expect(await readFile(notes, "utf8")).toBe("Read [[Plan#Goals]], [[Plan]] and [[Box/Inside]].\n");
      expect(await readFile(join(dir, "Daily.md"), "utf8")).toBe("Today: [[Plan 2026#Objectives]], [[Plan 2026]] and [[Crate/Inside]].\n");
    } finally {
      await chmod(notes, 0o644);
    }
  });

  it("History restore on a read-only page: refused (423), the file keeps its bytes and mode, no before-restore version (@graph-dev)", async () => {
    const { store, dir } = await createTestServer();
    const page = await store.create({ title: "Ledger", content: "Balance: one." });
    const second = await store.update(page.id, { content: "Balance: two." });
    const third = await store.update(page.id, { content: "Balance: three.", expectedUpdated: second.updated });
    const file = join(dir, `${page.id}.md`);
    const { entries } = await readHistory(historyDir(dir, page.id));
    let older: (typeof entries)[number] | undefined;
    for (const entry of entries) {
      if ((await readFile(join(historyDir(dir, page.id), entry.file), "utf8")).includes("Balance: one.")) older = entry;
    }
    expect(older).toBeDefined();
    const before = await readFile(file, "utf8");
    const count = entries.length;
    await chmod(file, 0o444);
    try {
      const status = await store.restoreVersion(page.id, older!.file, { expectedUpdated: third.updated }).then(() => 0, (error: { status?: number }) => error.status);
      expect(status).toBe(423);
      expect(await readFile(file, "utf8")).toBe(before);
      expect(await mode(file)).toBe(0o444);
      expect((await readHistory(historyDir(dir, page.id))).entries.filter((entry) => entry.reason === "before-restore")).toEqual([]);
      expect((await readHistory(historyDir(dir, page.id))).entries.length).toBe(count);
    } finally {
      await chmod(file, 0o644);
    }
  });

  it("a board and a base are refused the same way, and keep their bytes", async () => {
    const { store, dir } = await createTestServer();
    const board = await store.createBoard({ title: "Map" });
    const boardFile = join(dir, board.meta.id);
    const boardBytes = await readFile(boardFile, "utf8");
    await chmod(boardFile, 0o444);
    const boardResult = await store
      .updateBoard(board.meta.id, { board: { nodes: [{ id: "a", type: "text", text: "Hi", x: 0, y: 0, width: 100, height: 40 }], edges: [] }, expectedUpdated: board.meta.updated })
      .then(() => 0, (error: { status?: number }) => error.status);
    expect(boardResult).toBe(423);
    expect(await readFile(boardFile, "utf8")).toBe(boardBytes);
    await chmod(boardFile, 0o644);

    const base = await store.createBase({ title: "Accounts" });
    const baseFile = join(dir, base.meta.id);
    const baseBytes = await readFile(baseFile, "utf8");
    await chmod(baseFile, 0o444);
    const config = { ...base.config, views: [...base.config.views, { type: "table" as const, name: "Second" }] };
    const baseResult = await store.updateBase(base.meta.id, { config, expectedUpdated: base.meta.updated }).then(() => 0, (error: { status?: number }) => error.status);
    expect(baseResult).toBe(423);
    expect(await readFile(baseFile, "utf8")).toBe(baseBytes);
    await chmod(baseFile, 0o644);
    expect(await temps(dir)).toEqual([]);
  });
});
