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

const outside = vi.hoisted(() => ({ before: null as null | { target: string; text: string; dir?: boolean }, noHardLinks: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  // Another app saves a file (or a folder holding one) at that name a moment before the move, whichever call
  // makes the move (`rename`, or `link` for a move that mustn't replace).
  const outsideFirst = async (to: unknown) => {
    const plan = outside.before;
    if (!plan || !String(to).endsWith(plan.target)) return;
    outside.before = null;
    if (plan.dir) {
      await actual.mkdir(String(to), { recursive: true });
      await actual.writeFile(`${String(to)}/Outside.md`, plan.text, "utf8");
    } else await actual.writeFile(String(to), plan.text, "utf8");
  };
  const rename: typeof actual.rename = async (from, to) => {
    await outsideFirst(to);
    return actual.rename(from, to);
  };
  const link: typeof actual.link = async (from, to) => {
    await outsideFirst(to);
    // A file system without hard links (FAT/exFAT USB vaults): the move falls back to a no-replace copy.
    if (outside.noHardLinks) throw Object.assign(new Error("EPERM: operation not permitted, link (test)"), { code: "EPERM" });
    return actual.link(from, to);
  };
  return { ...actual, rename, link, default: { ...actual, rename, link } };
});

beforeEach(() => {
  outside.before = null;
  outside.noHardLinks = false;
});
afterEach(async () => {
  outside.before = null;
  outside.noHardLinks = false;
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

  it("Restore of an ordinary page from the Trash (@lead: the same pattern)", async () => {
    const server = await createTestServer();
    await writeFile(join(server.dir, "Note.md"), "Mine, trashed.\n", "utf8");
    await server.store.rescan();
    const { trashId } = await server.store.remove("Note");
    outside.before = { target: "Note.md", text: OUTSIDE };
    await server.store.restore(trashId!).catch(() => undefined);
    expect(outside.before, "the move was reached").toBeNull();
    const { readdir } = await import("node:fs/promises");
    const texts = await Promise.all((await readdir(server.dir)).filter((name) => name.endsWith(".md")).map((name) => readFile(join(server.dir, name), "utf8")));
    expect(texts).toContain(OUTSIDE);
    expect(texts).toContain("Mine, trashed.\n");
  });

  it("Restore of a plain folder from the Trash (@lead: the same pattern)", async () => {
    const server = await createTestServer();
    await mkdir(join(server.dir, "Projects"), { recursive: true });
    await writeFile(join(server.dir, "Projects", "Plan.md"), "Mine, trashed.\n", "utf8");
    await server.store.rescan();
    const { trashId } = await server.store.remove("Projects");
    outside.before = { target: "Projects", text: OUTSIDE, dir: true };
    await server.store.restore(trashId!).catch(() => undefined);
    expect(outside.before, "the move was reached").toBeNull();
    expect(await readFile(join(server.dir, "Projects", "Outside.md"), "utf8")).toBe(OUTSIDE);
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

describe("on a file system without hard links (FAT/exFAT; `link` throws EPERM) a Restore still never replaces (#bfy92cu6)", () => {
  it("a page comes back by a no-replace copy, bytes and time kept, and the Trash entry goes", async () => {
    const server = await createTestServer();
    await writeFile(join(server.dir, "Note.md"), "Mine, trashed.\n", "utf8");
    await server.store.rescan();
    const { stat } = await import("node:fs/promises");
    const mtime = (await stat(join(server.dir, "Note.md"))).mtimeMs;
    const { trashId } = await server.store.remove("Note");
    outside.noHardLinks = true;
    await server.store.restore(trashId!);
    expect(await readFile(join(server.dir, "Note.md"), "utf8")).toBe("Mine, trashed.\n");
    expect(Math.abs((await stat(join(server.dir, "Note.md"))).mtimeMs - mtime)).toBeLessThan(1000);
    expect(await server.store.listTrash()).toEqual([]);
  });

  it("an outside file at the name: the copy refuses to replace it, and the page comes back as \"Note 2\"", async () => {
    const server = await createTestServer();
    await writeFile(join(server.dir, "Note.md"), "Mine, trashed.\n", "utf8");
    await server.store.rescan();
    const { trashId } = await server.store.remove("Note");
    outside.noHardLinks = true;
    outside.before = { target: "Note.md", text: OUTSIDE };
    await server.store.restore(trashId!);
    expect(outside.before, "the move was reached").toBeNull();
    expect(await readFile(join(server.dir, "Note.md"), "utf8")).toBe(OUTSIDE);
    expect(await readFile(join(server.dir, "Note 2.md"), "utf8")).toBe("Mine, trashed.\n");
  });
});
