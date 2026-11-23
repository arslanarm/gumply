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

async function replaceNow(path: string): Promise<void> {
  const pending = replaceAfterRead;
  if (!pending || pending.path !== path) return;
  replaceAfterRead = null;
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
});
