import { chmod, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
