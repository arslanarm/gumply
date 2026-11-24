import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { historyDir, readHistory } from "../src/history";
import { VaultStore } from "../src/vault-store";

/**
 * N1 (#kw8th869, D41): database views (.base) get version history like pages
 * and boards. Every version is the file's exact bytes (D37): the view below
 * has a comment and spacing a YAML round trip would lose.
 */
const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const ORIGINAL = "# my view, kept as written\nviews:\n  - type: table\n    name:   Tasks\n    order: [file.name]\n";

async function vault() {
  const dir = await mkdtemp(join(tmpdir(), "gumply-base-history-"));
  dirs.push(dir);
  await writeFile(join(dir, "View.base"), ORIGINAL);
  const store = new VaultStore(dir);
  await store.init();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  return { dir, store };
}

const versions = (dir: string, id = "View.base") => readHistory(historyDir(dir, id)).then((history) => history.entries);
const versionBytes = (dir: string, file: string, id = "View.base") => readFile(join(historyDir(dir, id), file), "utf8");
const renamedTable = (store: VaultStore, name: string) => {
  const { config } = store.getBase("View.base");
  return { ...config, views: config.views.map((view, i) => (i === 0 ? { ...view, name } : view)) };
};

describe("history for database views (N1)", () => {
  it("a save from the view puts the exact previous bytes into history first", async () => {
    const { dir, store } = await vault();
    const before = store.getBase("View.base");
    await store.updateBase("View.base", { config: renamedTable(store, "Renamed"), expectedUpdated: before.meta.updated });
    const list = await versions(dir);
    expect(list).toHaveLength(1);
    expect(list[0]!.file).toMatch(/\.base$/);
    expect(await versionBytes(dir, list[0]!.file)).toBe(ORIGINAL); // byte for byte, comment and spacing included
    expect(await readFile(join(dir, "View.base"), "utf8")).not.toBe(ORIGINAL);
  });

  it("a save that writes the same bytes makes no version", async () => {
    const { dir, store } = await vault();
    const before = store.getBase("View.base");
    // The same config: nothing to write, nothing to keep.
    await store.updateBase("View.base", { config: before.config, expectedUpdated: before.meta.updated });
    expect(await versions(dir)).toHaveLength(0);
  });

  it("an outside edit (Obsidian, git) is an outside version of the new bytes", async () => {
    const { dir, store } = await vault();
    const theirs = ORIGINAL.replace("Tasks", "Theirs");
    await writeFile(join(dir, "View.base"), theirs);
    const later = new Date(Date.now() + 5_000);
    await utimes(join(dir, "View.base"), later, later);
    await store.rescan();
    const list = await versions(dir);
    const outside = list.find((entry) => entry.source === "external");
    expect(outside).toBeTruthy();
    expect(await versionBytes(dir, outside!.file)).toBe(theirs);
  });

  it("restore writes the version's exact bytes back, keeps what it replaced, and answers the view", async () => {
    const { dir, store } = await vault();
    const before = store.getBase("View.base");
    const saved = await store.updateBase("View.base", { config: renamedTable(store, "Renamed"), expectedUpdated: before.meta.updated });
    const replacedBytes = await readFile(join(dir, "View.base"), "utf8");
    const [original] = await versions(dir);
    const restored = await store.restoreVersion("View.base", original!.file, { expectedUpdated: saved.meta.updated });
    expect(await readFile(join(dir, "View.base"), "utf8")).toBe(ORIGINAL);
    expect("config" in restored && restored.config.views[0]?.name).toBe("Tasks");
    // The restore itself can be undone: the replaced bytes are a "before restore" version.
    const list = await versions(dir);
    const beforeRestore = list.find((entry) => entry.reason === "before-restore");
    expect(beforeRestore).toBeTruthy();
    expect(await versionBytes(dir, beforeRestore!.file)).toBe(replacedBytes);
  });

  it("restore over an outside change is refused (D22): the other program's bytes stay", async () => {
    const { dir, store } = await vault();
    const before = store.getBase("View.base");
    const saved = await store.updateBase("View.base", { config: renamedTable(store, "Renamed"), expectedUpdated: before.meta.updated });
    const [original] = await versions(dir);
    const theirs = ORIGINAL.replace("Tasks", "Changed elsewhere");
    await writeFile(join(dir, "View.base"), theirs);
    const later = new Date(Date.now() + 9_000);
    await utimes(join(dir, "View.base"), later, later);
    await expect(store.restoreVersion("View.base", original!.file, { expectedUpdated: saved.meta.updated })).rejects.toMatchObject({ status: 409 });
    expect(await readFile(join(dir, "View.base"), "utf8")).toBe(theirs);
  });

  it("a rename keeps the history", async () => {
    const { dir, store } = await vault();
    const before = store.getBase("View.base");
    const saved = await store.updateBase("View.base", { config: renamedTable(store, "Renamed"), expectedUpdated: before.meta.updated });
    await store.updateBase("View.base", { title: "Board view", expectedUpdated: saved.meta.updated });
    const list = await versions(dir, "Board view.base");
    expect(list.some((entry) => entry.file.endsWith(".base"))).toBe(true);
    const listed = await store.listHistory("Board view.base");
    expect(listed.items.length).toBeGreaterThanOrEqual(1);
  });

  it("delete keeps the last save, and Trash restore brings the view back with its history", async () => {
    const { dir, store } = await vault();
    const before = store.getBase("View.base");
    await store.updateBase("View.base", { config: renamedTable(store, "Renamed"), expectedUpdated: before.meta.updated });
    const count = (await versions(dir)).length;
    const deleted = await store.remove("View.base");
    expect(deleted.trashId).toBeTruthy();
    await store.restore(deleted.trashId!);
    const listed = await store.listHistory("View.base");
    expect(listed.items.length).toBeGreaterThanOrEqual(count);
  });

  it("a new view with a trashed view's name starts its own history (the old one is set aside)", async () => {
    const { dir, store } = await vault();
    const first = await store.createBase({ title: "Tasks" });
    const edited = await store.updateBase(first.meta.id, { config: { ...first.config, views: [{ ...first.config.views[0]!, name: "Old view" }] }, expectedUpdated: first.meta.updated });
    expect(edited.meta.id).toBe("Tasks.base");
    expect((await versions(dir, "Tasks.base")).length).toBeGreaterThanOrEqual(1);
    await store.remove("Tasks.base");

    const second = await store.createBase({ title: "Tasks" });
    expect(second.meta.id).toBe("Tasks.base");
    const listed = await store.listHistory("Tasks.base");
    expect(listed.items).toHaveLength(0);
    // Its first save keeps only its own bytes, none of the trashed view's.
    await store.updateBase("Tasks.base", { config: { ...second.config, views: [{ ...second.config.views[0]!, name: "New view" }] }, expectedUpdated: second.meta.updated });
    const list = await versions(dir, "Tasks.base");
    expect(list).toHaveLength(1);
    expect(await versionBytes(dir, list[0]!.file, "Tasks.base")).not.toContain("Old view");
  });

  it("Before reload has nothing to keep for a view: a clear 400", async () => {
    const { store } = await vault();
    await expect(store.saveUnsavedVersion("View.base", { content: "x" })).rejects.toMatchObject({ status: 400 });
  });
});
