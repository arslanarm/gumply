import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A read that races another program's atomic save (the MCP lost update, found
 * in race.test.ts "append_to_page after the user's save"). Reading the path
 * and then stat-ing it could pair the old text with the new mtime; the D22
 * check then let the next save erase the other program's write.
 *
 * The hook below replaces the file (write a temp, rename it over) right after
 * a read returns, whichever way the store reads: the module's `readFile` or a
 * FileHandle's. The store must then keep the text and the mtime of the same
 * file, so a save based on that text is a 409 and the other write survives.
 */
let replaceAfterRead: { path: string; text: string } | null = null;
let replaceAfterRename: { path: string; text: string } | null = null;
// A filesystem whose rename changes the reported mtime (SMB/NFS, cloud-sync, FAT):
// after the store renames onto `path`, every stat of it reports the mtime shifted by `ms`.
let shiftOnRename: { path: string; ms: number } | null = null;
const shifted = new Map<string, number>();

async function replaceNow(path: string, which: "read" | "rename" = "read"): Promise<void> {
  const pending = which === "read" ? replaceAfterRead : replaceAfterRename;
  if (!pending || pending.path !== path) return;
  if (which === "read") replaceAfterRead = null;
  else replaceAfterRename = null;
  const real = await vi.importActual<typeof fsPromises>("node:fs/promises");
  const temp = `${path}.other-program`;
  await real.writeFile(temp, pending.text);
  // A clearly later mtime, so the test doesn't depend on the clock's granularity.
  const later = new Date(Date.now() + 5_000);
  await real.utimes(temp, later, later);
  await real.rename(temp, path);
}

vi.mock("node:fs/promises", async () => {
  const real = await vi.importActual<typeof fsPromises>("node:fs/promises");
  return {
    ...real,
    readFile: async (...args: Parameters<typeof real.readFile>) => {
      const result = await real.readFile(...args);
      if (typeof args[0] === "string") await replaceNow(args[0]);
      return result;
    },
    stat: async (...args: Parameters<typeof real.stat>) => {
      const stats = await real.stat(...args);
      const ms = shifted.get(String(args[0]));
      if (ms === undefined) return stats;
      const copy = Object.assign(Object.create(Object.getPrototypeOf(stats)), stats);
      copy.mtimeMs = stats.mtimeMs + ms;
      copy.mtime = new Date(copy.mtimeMs);
      return copy;
    },
    rename: async (...args: Parameters<typeof real.rename>) => {
      await real.rename(...args);
      if (shiftOnRename && shiftOnRename.path === String(args[1])) shifted.set(shiftOnRename.path, shiftOnRename.ms);
      await replaceNow(String(args[1]), "rename");
    },
    open: async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args);
      const path = String(args[0]);
      const readFile = handle.readFile.bind(handle);
      handle.readFile = (async (...readArgs: Parameters<typeof handle.readFile>) => {
        const result = await readFile(...readArgs);
        await replaceNow(path);
        return result;
      }) as typeof handle.readFile;
      return handle;
    },
  };
});

const { VaultStore } = await import("../src/vault-store");
const { mkdtemp, readFile, rm, writeFile, utimes } = await vi.importActual<typeof fsPromises>("node:fs/promises");

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gumply-lost-update-"));
});
afterEach(async () => {
  replaceAfterRead = null;
  replaceAfterRename = null;
  shiftOnRename = null;
  shifted.clear();
  await rm(dir, { recursive: true, force: true });
});

describe("a read racing another program's atomic save keeps text and mtime together (D22)", () => {
  for (const [kind, name, first, theirs, mine] of [
    ["page", "Plan.md", "# Plan\n\nIntro.\n", "# Plan\n\nIntro.\n\nUser line.\n", "# Plan\n\nIntro.\n\nModel line.\n"],
    ["board", "Map.canvas", '{"nodes":[],"edges":[]}', '{"nodes":[{"id":"u","type":"text","text":"User card","x":0,"y":0,"width":100,"height":50}],"edges":[]}', ""],
  ] as const) {
    it(`a ${kind}: the save based on the raced read is a conflict, and the other program's bytes survive`, async () => {
      const file = join(dir, name);
      await writeFile(file, first);
      const store = new VaultStore(dir);
      await store.init();
      const id = kind === "page" ? "Plan" : "Map.canvas";
      // Something changes it outside (so the next refresh reads it again)…
      const earlier = new Date(Date.now() - 60_000);
      const edited =
        kind === "page"
          ? first.replace("Intro", "Intro, edited")
          : '{"nodes":[{"id":"e","type":"text","text":"Edited outside","x":0,"y":0,"width":100,"height":50}],"edges":[]}';
      await writeFile(file, edited);
      await utimes(file, earlier, earlier);
      // …and while that read is happening, another program saves atomically.
      replaceAfterRead = { path: file, text: theirs };
      await store.rescan();
      expect(replaceAfterRead).toBeNull(); // the race really happened

      if (kind === "page") {
        const record = store.get(id);
        await expect(store.update(id, { content: mine, expectedUpdated: record.updated })).rejects.toMatchObject({ status: 409 });
      } else {
        const record = store.getBoard(id);
        await expect(store.updateBoard(id, { board: { nodes: [], edges: [] }, expectedUpdated: record.meta.updated })).rejects.toMatchObject({ status: 409 });
      }
      expect(await readFile(file, "utf8")).toBe(theirs);
    });
  }

  // The same race on the write side: the store saves (temp + rename), and another program
  // replaces the file before the store stats it. The mtime the store keeps must be its own
  // file's, so the next save is a 409 rather than erasing the other program's bytes.
  for (const [kind, name, first, theirs] of [
    ["page", "Plan.md", "# Plan\n\nIntro.\n", "# Plan\n\nIntro.\n\nUser line.\n"],
    ["board", "Map.canvas", '{"nodes":[],"edges":[]}', '{"nodes":[{"id":"u","type":"text","text":"User card","x":0,"y":0,"width":100,"height":50}],"edges":[]}'],
  ] as const) {
    it(`a ${kind}: a save racing another program's save keeps its own mtime, so the next save is a conflict`, async () => {
      const file = join(dir, name);
      await writeFile(file, first);
      const store = new VaultStore(dir);
      await store.init();
      replaceAfterRename = { path: file, text: theirs };
      if (kind === "page") {
        const saved = await store.update("Plan", { content: "# Plan\n\nIntro.\n\nModel line.\n", expectedUpdated: store.get("Plan").updated });
        expect(replaceAfterRename).toBeNull(); // the race really happened
        await expect(store.update("Plan", { content: "# Plan\n\nIntro.\n\nModel line 2.\n", expectedUpdated: saved.updated })).rejects.toMatchObject({ status: 409 });
      } else {
        const card = { id: "m", type: "text", text: "Model card", x: 0, y: 0, width: 100, height: 50 };
        const saved = await store.updateBoard("Map.canvas", { board: { nodes: [card], edges: [] } as never, expectedUpdated: store.getBoard("Map.canvas").meta.updated });
        expect(replaceAfterRename).toBeNull();
        await expect(store.updateBoard("Map.canvas", { board: { nodes: [], edges: [] }, expectedUpdated: saved.meta.updated })).rejects.toMatchObject({ status: 409 });
      }
      expect(await readFile(file, "utf8")).toBe(theirs);
    });
  }

  // The other side of that choice: when the path still holds our file (same inode) but the
  // filesystem reports a different mtime after the rename, the store keeps the path's mtime,
  // so the next save is not a false "changed on disk" conflict.
  for (const [kind, name, first] of [
    ["page", "Plan.md", "# Plan\n\nIntro.\n"],
    ["board", "Map.canvas", '{"nodes":[],"edges":[]}'],
  ] as const) {
    it(`a ${kind}: a rename that changes the reported mtime of our own file is not a conflict on the next save`, async () => {
      const file = join(dir, name);
      await writeFile(file, first);
      const store = new VaultStore(dir);
      await store.init();
      shiftOnRename = { path: file, ms: 2_000 };
      if (kind === "page") {
        const saved = await store.update("Plan", { content: "# Plan\n\nIntro.\n\nOne.\n", expectedUpdated: store.get("Plan").updated });
        expect(shifted.has(file)).toBe(true); // the stub really applied
        await store.update("Plan", { content: "# Plan\n\nIntro.\n\nOne.\n\nTwo.\n", expectedUpdated: saved.updated });
        expect(await readFile(file, "utf8")).toContain("Two.");
      } else {
        const card = (id: string) => ({ id, type: "text", text: id, x: 0, y: 0, width: 100, height: 50 });
        const saved = await store.updateBoard("Map.canvas", { board: { nodes: [card("one")], edges: [] } as never, expectedUpdated: store.getBoard("Map.canvas").meta.updated });
        expect(shifted.has(file)).toBe(true);
        await store.updateBoard("Map.canvas", { board: { nodes: [card("one"), card("two")], edges: [] } as never, expectedUpdated: saved.meta.updated });
        expect(await readFile(file, "utf8")).toContain('"two"');
      }
    });
  }
});
