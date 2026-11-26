import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupVaults, createTestServer } from "./helpers";

/**
 * #zh87z4pf (@graph-dev's review): a directory deleted and made again at the same path can get the same
 * inode number back (ext4 hands out a just-freed one; git checkout does this). Its watcher must still be
 * made anew: the directory's identity includes its birth time. The reuse is forced here, deterministically,
 * by reporting the old inode number for the new directory.
 */

const reuse = vi.hoisted(() => ({ path: "", ino: 0, on: false }));

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const statSync = ((...args: Parameters<typeof real.statSync>) => {
    const info = real.statSync(...args) as import("node:fs").Stats;
    if (!reuse.on || String(args[0]) !== reuse.path || !info) return info;
    // The same inode number as the deleted directory, everything else (birth time included) the new one's.
    const fake = Object.create(Object.getPrototypeOf(info)) as import("node:fs").Stats;
    Object.assign(fake, info, { ino: reuse.ino });
    return fake;
  }) as typeof real.statSync;
  return { ...real, statSync, default: { ...real, statSync } };
});

afterEach(cleanupVaults);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check: () => boolean, ms = 5000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return true;
    await sleep(50);
  }
  return check();
}

describe("a folder made again with its old inode number is watched again (#zh87z4pf)", () => {
  it("deleted, made again, the same inode number reported: an outside edit inside it is seen", async () => {
    const { store, dir } = await createTestServer();
    const crew = join(dir, "Crew");
    store.startWatching();
    try {
      await mkdir(crew);
      await writeFile(join(crew, "Ann.md"), "First folder.\n");
      expect(await waitFor(() => store.list().some((meta) => meta.id === "Crew/Ann"))).toBe(true);
      await sleep(400);
      const { statSync } = await import("node:fs");
      reuse.ino = statSync(crew).ino;
      reuse.path = crew;
      await rm(crew, { recursive: true });
      await mkdir(crew);
      reuse.on = true;
      await writeFile(join(crew, "Ann.md"), "Second folder, Cook.\n");
      await sleep(600);
      await writeFile(join(crew, "Ann.md"), "Second folder, Chef, edited elsewhere.\n");
      const seen = await waitFor(() => {
        try {
          return store.get("Crew/Ann").content.includes("Chef");
        } catch {
          return false;
        }
      }, 5000);
      expect(seen, `still: ${JSON.stringify(store.get("Crew/Ann").content)}`).toBe(true);
    } finally {
      reuse.on = false;
      store.stopWatching();
    }
  }, 20_000);
});
