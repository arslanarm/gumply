import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupVaults, createTestServer } from "./helpers";

/**
 * #bfy92cu6 (from #zy9dqwwz, backported to 0.9.7): a page's Trash Restore checks that its name is free, then moves
 * the file back. `rename()` would replace a file another app (Obsidian, a sync tool) saved at that name in between;
 * the move must never replace it. Forced deterministically: the outside file is written just before the move
 * (`rename`, or `link` for a move that mustn't replace). Synthetic vault.
 */

const outside = vi.hoisted(() => ({ before: null as null | { target: string; text: string }, noHardLinks: false, trashBusy: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const outsideFirst = async (to: unknown) => {
    const plan = outside.before;
    if (!plan || !String(to).endsWith(plan.target)) return;
    outside.before = null;
    await actual.writeFile(String(to), plan.text, "utf8");
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
  // A file in the Trash that can't be removed (a Windows lock, a read-only folder).
  const unlink: typeof actual.unlink = async (path) => {
    if (outside.trashBusy && String(path).includes(".trash")) throw Object.assign(new Error("EBUSY: resource busy or locked, unlink (test)"), { code: "EBUSY" });
    return actual.unlink(path);
  };
  return { ...actual, rename, link, unlink, default: { ...actual, rename, link, unlink } };
});

beforeEach(() => {
  outside.before = null;
  outside.noHardLinks = false;
  outside.trashBusy = false;
});
afterEach(async () => {
  outside.before = null;
  outside.noHardLinks = false;
  outside.trashBusy = false;
  await cleanupVaults();
});

const OUTSIDE = "Written in another app.\n";
const MINE = "Mine, trashed.\n";

async function trashed() {
  const server = await createTestServer();
  await writeFile(join(server.dir, "Note.md"), MINE, "utf8");
  await server.store.rescan();
  const mtime = (await stat(join(server.dir, "Note.md"))).mtimeMs;
  const { trashId } = await server.store.remove("Note");
  const texts = async () =>
    Promise.all((await readdir(server.dir)).filter((name) => name.endsWith(".md")).sort().map(async (name) => [name, await readFile(join(server.dir, name), "utf8")] as const));
  return { ...server, trashId: trashId!, mtime, texts };
}

describe("a page's Trash Restore never replaces a file another app just made at its name (#bfy92cu6)", () => {
  it("an outside file at the name: it stays, and the page comes back as \"Note 2\"", async () => {
    const { store, trashId, texts } = await trashed();
    outside.before = { target: "Note.md", text: OUTSIDE };
    await store.restore(trashId).catch(() => undefined);
    expect(outside.before, "the move was reached").toBeNull();
    expect(await texts()).toEqual([["Note 2.md", MINE], ["Note.md", OUTSIDE]]);
  });

  it("without hard links (link throws EPERM): the page comes back by a no-replace copy, bytes and time kept", async () => {
    const { dir, store, trashId, mtime, texts } = await trashed();
    outside.noHardLinks = true;
    await store.restore(trashId);
    expect(await texts()).toEqual([["Note.md", MINE]]);
    expect(Math.abs((await stat(join(dir, "Note.md"))).mtimeMs - mtime)).toBeLessThan(1000);
    expect(await store.listTrash()).toEqual([]);
  });

  it("without hard links, an outside file at the name: it stays, and the page comes back as \"Note 2\"", async () => {
    const { store, trashId, texts } = await trashed();
    outside.noHardLinks = true;
    outside.before = { target: "Note.md", text: OUTSIDE };
    await store.restore(trashId).catch(() => undefined);
    expect(outside.before, "the move was reached").toBeNull();
    expect(await texts()).toEqual([["Note 2.md", MINE], ["Note.md", OUTSIDE]]);
  });

  it("the Trash copy can't be removed (EBUSY): the Restore fails cleanly, the page stays in the Trash and nothing new is in the vault", async () => {
    const { store, trashId, texts } = await trashed();
    outside.trashBusy = true;
    await expect(store.restore(trashId)).rejects.toThrow();
    outside.trashBusy = false;
    expect(await texts()).toEqual([]);
    expect((await store.listTrash()).map((item) => item.trashId)).toEqual([trashId]);
  });
});
