import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VaultStore } from "../src/vault-store";
import { cleanupVaults, createTestServer } from "./helpers";

/**
 * #zy9dqwwz (data-safety hunt on New database): a redo of a paste, and a Restore of an undo's group of rows,
 * check that each row's name is free, then move the row back with `rename()`, which replaces whatever is there.
 * Between the check and the move (a big undo writes for seconds), another app (Obsidian, a sync tool) may make a
 * file with that name. Its bytes must never be replaced. Forced deterministically: the outside file is written
 * just before the move. Synthetic vault.
 */

const outside = vi.hoisted(() => ({ before: null as null | { target: string; text: string } }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const rename: typeof actual.rename = async (from, to) => {
    const plan = outside.before;
    if (plan && String(to).endsWith(plan.target)) {
      outside.before = null;
      // Another app saves a file at that name a moment before the move.
      await actual.writeFile(String(to), plan.text, "utf8");
    }
    return actual.rename(from, to);
  };
  return { ...actual, rename, default: { ...actual, rename } };
});

beforeEach(() => {
  outside.before = null;
});
afterEach(async () => {
  outside.before = null;
  await cleanupVaults();
});

const BASE = 'gumply:\n  rows: People\nfilters:\n  and:\n    - file.folder == "People"\nviews:\n  - type: table\n    name: Table\n    order:\n      - file.name\n      - role\n';
const OUTSIDE = "---\nrole: Diver\n---\nWritten in another app.\n";

async function undonePaste() {
  const server = await createTestServer();
  await mkdir(join(server.dir, "People"), { recursive: true });
  await writeFile(join(server.dir, "People.base"), BASE, "utf8");
  const store = new VaultStore(server.dir);
  await store.init();
  const pasted = await store.pasteIntoOwnedRows("People.base", { rows: [{ title: "Bo", set: { role: "Pilot" } }] });
  const undo = await store.undoDatabaseChange("People.base", { drop: pasted.made.map((row) => ({ id: row.id, from: row.after })) });
  expect(undo.refused).toEqual([]);
  const read = (path: string) => readFile(join(server.dir, path), "utf8");
  return { dir: server.dir, store, undo, read };
}

/** Every file in the vault's People/ folder that holds the outside text. */
async function outsideTextKept(dir: string): Promise<boolean> {
  const { readdir } = await import("node:fs/promises");
  for (const name of await readdir(join(dir, "People"))) {
    if ((await readFile(join(dir, "People", name), "utf8").catch(() => "")) === OUTSIDE) return true;
  }
  return false;
}

describe("a row brought back never replaces a file another app just made at its name (#zy9dqwwz)", () => {
  it("redo of a paste", async () => {
    const { dir, store, undo } = await undonePaste();
    outside.before = { target: join("People", "Bo.md"), text: OUTSIDE };
    await store.undoDatabaseChange("People.base", { create: undo.dropped.map((row) => ({ id: row.id, trashId: row.trashId })) }).catch(() => undefined);
    expect(outside.before, "the move was reached").toBeNull();
    expect(await outsideTextKept(dir)).toBe(true);
  });

  it("Restore of an undo's group of rows from the Trash", async () => {
    const { dir, store } = await undonePaste();
    const [item] = await store.listTrash();
    outside.before = { target: join("People", "Bo.md"), text: OUTSIDE };
    await store.restore(item!.trashId).catch(() => undefined);
    expect(outside.before, "the move was reached").toBeNull();
    expect(await outsideTextKept(dir)).toBe(true);
  });
});
