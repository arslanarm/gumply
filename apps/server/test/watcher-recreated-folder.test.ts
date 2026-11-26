import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupVaults, createTestServer } from "./helpers";

/**
 * Found by #dqdwz9qw (trial-main18's database-grid:280, only in file order): directory watchers are kept
 * by path, but a watch follows the directory itself. A folder moved away (the Trash, a sync tool, git) and
 * made again at the same path kept its old watcher, which still watches the moved directory, so nothing
 * inside the new folder was seen until a full rescan for some other reason. Synthetic vault.
 */

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

describe("a folder moved away and made again at the same path is watched again", () => {
  it("a folder put back from the Trash: an outside edit inside it is seen", async () => {
    const { store, dir } = await createTestServer();
    store.startWatching();
    try {
      await mkdir(join(dir, "Crew"));
      await writeFile(join(dir, "Crew", "Ann.md"), "Before the Trash.\n");
      expect(await waitFor(() => store.list().some((meta) => meta.id === "Crew/Ann"))).toBe(true);
      await sleep(400);
      const { trashId } = await store.remove("Crew");
      await store.restore(trashId);
      expect(await waitFor(() => store.list().some((meta) => meta.id === "Crew/Ann"))).toBe(true);
      await sleep(400);
      await writeFile(join(dir, "Crew", "Ann.md"), "Back from the Trash, edited elsewhere.\n");
      const seen = await waitFor(() => {
        try {
          return store.get("Crew/Ann").content.includes("edited elsewhere");
        } catch {
          return false;
        }
      }, 5000);
      expect(seen).toBe(true);
    } finally {
      store.stopWatching();
    }
  }, 20_000);

  for (const how of ["moved away by another app", "moved to the Trash by Gumply", "deleted and made again (git checkout)"] as const) {
    it(`${how}: an outside edit inside the new folder is seen`, async () => {
      const { store, dir } = await createTestServer();
      store.startWatching();
      try {
        await mkdir(join(dir, "Crew"));
        await writeFile(join(dir, "Crew", "Ann.md"), "First folder.\n");
        expect(await waitFor(() => store.list().some((meta) => meta.id === "Crew/Ann"))).toBe(true);
        // Let the watcher settle on the folder.
        await sleep(400);

        if (how === "moved away by another app") {
          await rename(join(dir, "Crew"), join(dir, ".gone-crew"));
        } else if (how === "moved to the Trash by Gumply") {
          await store.remove("Crew");
        } else {
          // Deleted outright: the new directory may even get the same inode number back.
          await rm(join(dir, "Crew"), { recursive: true });
        }
        // Made again at the same path straight away, inside the watcher's quiet gap, so no rescan runs in
        // between (the e2e's vault reset then writeVault, a sync tool's restore, a git checkout).
        await mkdir(join(dir, "Crew"));
        await writeFile(join(dir, "Crew", "Ann.md"), "Second folder, Cook.\n");
        expect(await waitFor(() => store.list().some((meta) => meta.id === "Crew/Ann"))).toBe(true);
        await sleep(400);

        // Another app edits the page inside the new folder.
        await writeFile(join(dir, "Crew", "Ann.md"), "Second folder, Chef, edited elsewhere.\n");
        const seen = await waitFor(() => {
          try {
            return store.get("Crew/Ann").content.includes("Chef");
          } catch {
            return false;
          }
        }, 5000);
        expect(seen, `still: ${JSON.stringify(store.get("Crew/Ann").content)}`).toBe(true);
      } finally {
        store.stopWatching();
      }
    }, 20_000);
  }
});
