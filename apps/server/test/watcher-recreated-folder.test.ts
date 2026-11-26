import { mkdir, rename, writeFile } from "node:fs/promises";
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
  for (const how of ["moved away by another app", "moved to the Trash by Gumply"] as const) {
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
        } else {
          await store.remove("Crew");
        }
        expect(await waitFor(() => !store.list().some((meta) => meta.id === "Crew/Ann"))).toBe(true);
        await sleep(400);

        // Made again at the same path (the next test's writeVault, a sync tool's restore, a git checkout).
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
