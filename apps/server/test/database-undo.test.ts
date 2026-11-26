import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TrashItem } from "@gumply/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VaultStore } from "../src/vault-store";
import { cleanupVaults, createTestServer } from "./helpers";

/**
 * #7prbquxu phase 4b (@opus-hunter's review, @lead's required points 2 and 3): the table's undo is all or nothing
 * also when a write fails part way (read-only files are refused before any write; a later failure puts every
 * written file back), the rows it drops go to the Trash (never deleted outright) and a redo brings them back from
 * there, and a redo refuses when the rows folder is gone instead of making a new one.
 */

const failing = vi.hoisted(() => ({ renameTo: null as string | null }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const rename: typeof actual.rename = async (from, to) => {
    if (failing.renameTo && String(to).endsWith(failing.renameTo)) throw Object.assign(new Error("ENOSPC: no space left (test)"), { code: "ENOSPC" });
    return actual.rename(from, to);
  };
  return { ...actual, rename, default: { ...actual, rename } };
});

beforeEach(() => {
  failing.renameTo = null;
});
afterEach(async () => {
  failing.renameTo = null;
  await cleanupVaults();
});

const BASE = 'gumply:\n  rows: People\nfilters:\n  and:\n    - file.folder == "People"\nviews:\n  - type: table\n    name: Table\n    order:\n      - file.name\n      - role\n';

async function vault(files: Record<string, string>) {
  const server = await createTestServer();
  for (const [path, body] of Object.entries(files)) {
    await mkdir(join(server.dir, path, ".."), { recursive: true });
    await writeFile(join(server.dir, path), body, "utf8");
  }
  const store = new VaultStore(server.dir);
  await store.init();
  const read = (path: string) => readFile(join(server.dir, path), "utf8");
  return { dir: server.dir, store, read };
}

/** A property deleted from two rows and the base; the undo step for it, and the row written last. */
async function deletedProperty() {
  const v = await vault({ "People.base": BASE, "People/Ann.md": "---\nrole: Cook\n---\nAnn\n", "People/Bo.md": "---\nrole: Pilot\n---\nBo\n" });
  const done = await v.store.changeOwnedRowsProperty("People.base", { remove: "role" });
  const step = { files: done.files.map((file) => ({ id: file.id, from: file.after, to: file.before })) };
  const rows = done.files.filter((file) => file.id !== "People.base").map((file) => file.id);
  const after = { ann: await v.read("People/Ann.md"), bo: await v.read("People/Bo.md"), base: await v.read("People.base") };
  return { ...v, step, last: rows[rows.length - 1]!, after };
}

describe("the table's undo, all or nothing (#7prbquxu phase 4b)", () => {
  it("a read-only row refuses the whole step before any write, and is named (point 2)", async () => {
    const { dir, store, read, step, last, after } = await deletedProperty();
    await chmod(join(dir, `${last}.md`), 0o444);
    const result = await store.undoDatabaseChange("People.base", step);
    expect(result.refused.map((row) => row.id)).toEqual([last]);
    expect(await read("People/Ann.md")).toBe(after.ann);
    expect(await read("People/Bo.md")).toBe(after.bo);
    expect(await read("People.base")).toBe(after.base);
  });

  it("a write that fails part way puts every file it wrote back (point 2)", async () => {
    const { store, read, step, last, after } = await deletedProperty();
    failing.renameTo = `${last}.md`;
    await expect(store.undoDatabaseChange("People.base", step)).rejects.toThrow();
    failing.renameTo = null;
    expect(await read("People/Ann.md")).toBe(after.ann);
    expect(await read("People/Bo.md")).toBe(after.bo);
    expect(await read("People.base")).toBe(after.base);
  });

  it("the rows an undo drops go to the Trash, and its redo brings them back from there, byte for byte (point 3)", async () => {
    const { dir, store, read } = await vault({ "People.base": BASE });
    const pasted = await store.pasteIntoOwnedRows("People.base", { rows: [{ title: "Bo", set: { role: "Pilot" } }] });
    const bo = await read("People/Bo.md");
    const undo = await store.undoDatabaseChange("People.base", { drop: pasted.made.map((row) => ({ id: row.id, from: row.after })) });
    expect(undo.refused).toEqual([]);
    expect(existsSync(join(dir, "People/Bo.md"))).toBe(false);
    const trash = await store.listTrash();
    expect(trash.map((item: TrashItem) => item.id)).toEqual(["People"]);
    expect(undo.dropped).toEqual([expect.objectContaining({ id: "People/Bo", trashId: trash[0]!.trashId })]);

    const redo = await store.undoDatabaseChange("People.base", { create: undo.dropped.map((row) => ({ id: row.id, trashId: row.trashId })) });
    expect(redo.refused).toEqual([]);
    expect(await read("People/Bo.md")).toBe(bo);
    expect(await store.listTrash()).toEqual([]);
  });

  it("an undo's dropped rows are one Trash item, \"N rows from People\", restored as one (@lead, before phase 4 ships)", async () => {
    const { dir, store, read } = await vault({ "People.base": BASE, "People/Ann.md": "Ann\n" });
    const pasted = await store.pasteIntoOwnedRows("People.base", { rows: [{ title: "Bo", set: { role: "Pilot" } }, { title: "Cy", set: { role: "Cook" } }] });
    const bo = await read("People/Bo.md");
    const cy = await read("People/Cy.md");
    const undo = await store.undoDatabaseChange("People.base", { drop: pasted.made.map((row) => ({ id: row.id, from: row.after })) });
    expect(undo.refused).toEqual([]);
    const trash = await store.listTrash();
    expect(trash).toHaveLength(1);
    expect(trash[0]).toMatchObject({ id: "People", undoRows: 2 });
    expect(trash[0]!.children.map((child) => child.id).sort()).toEqual(["People/Bo", "People/Cy"]);
    expect(new Set(undo.dropped.map((row) => row.trashId)).size).toBe(1);
    // Ann, and the folder itself, stay where they are.
    expect(await read("People/Ann.md")).toBe("Ann\n");

    // Restore from the Trash brings both back into the folder, byte for byte; the item goes.
    await store.restore(trash[0]!.trashId);
    expect(await read("People/Bo.md")).toBe(bo);
    expect(await read("People/Cy.md")).toBe(cy);
    expect(await store.listTrash()).toEqual([]);
    expect(existsSync(join(dir, "People/Ann.md"))).toBe(true);
  });

  it("a redo refuses when the rows folder is gone, and makes no new folder (@opus-hunter)", async () => {
    const { dir, store } = await vault({ "People.base": BASE });
    const pasted = await store.pasteIntoOwnedRows("People.base", { rows: [{ title: "Bo", set: { role: "Pilot" } }] });
    const undo = await store.undoDatabaseChange("People.base", { drop: pasted.made.map((row) => ({ id: row.id, from: row.after })) });
    await store.remove("People");
    const redo = await store.undoDatabaseChange("People.base", { create: undo.dropped.map((row) => ({ id: row.id, trashId: row.trashId })) });
    expect(redo.refused.map((row) => row.id)).toEqual(["People/Bo"]);
    expect(existsSync(join(dir, "People"))).toBe(false);
  });
});
