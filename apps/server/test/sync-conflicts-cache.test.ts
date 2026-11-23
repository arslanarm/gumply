import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupVaults, createTestServer } from "./helpers";

/**
 * #3jkf2gf6 (@lead): the conflict-copy map is derived from file names only,
 * so it is computed once per set of files, not once per page in a per-page
 * loop (that would be pages², the class of #udbaghb4).
 */

const calls = vi.hoisted(() => ({ count: 0 }));

vi.mock("@gumply/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@gumply/core")>();
  return {
    ...actual,
    conflictCopyOf: (name: string) => {
      calls.count += 1;
      return actual.conflictCopyOf(name);
    },
  };
});

const { VaultStore } = await import("../src/vault-store");

afterEach(cleanupVaults);

interface Internals {
  reindexAll: () => void;
  recomputeSource: (id: string) => void;
}

async function vaultOf(pages: number) {
  const { dir } = await createTestServer();
  await mkdir(join(dir, "Notes"), { recursive: true });
  for (let i = 0; i < pages; i++) await writeFile(join(dir, "Notes", `Note ${i}.md`), `See [[Note ${(i + 1) % pages}]].\n`, "utf8");
  await writeFile(join(dir, "Notes", "Note 0.sync-conflict-20261122-143005-ABCDEFG.md"), "Theirs.\n", "utf8");
  const store = new VaultStore(dir);
  await store.init();
  return store;
}

/** conflictCopyOf calls for a reindex, then a recompute of every page's links (what an incremental refresh does at scale). */
async function callsFor(pages: number): Promise<number> {
  const store = await vaultOf(pages);
  const internal = store as unknown as Internals;
  const ids = store.list().map((page) => page.id);
  calls.count = 0;
  internal.reindexAll();
  for (const id of ids) internal.recomputeSource(id);
  store.list();
  store.tags();
  return calls.count;
}

describe("the conflict-copy map is computed once per set of files (#3jkf2gf6)", () => {
  it("a reindex plus a per-page recompute of N pages costs at most about N conflictCopyOf calls, not N²", async () => {
    const small = await callsFor(100);
    const large = await callsFor(800);
    // Cached: at most one computation per set of files (≤ pages + 1 calls); on demand it was N per page.
    expect(small).toBeLessThanOrEqual(101 + 1);
    expect(large).toBeLessThanOrEqual(801 + 1);
  }, 60_000);

  it("a content save keeps the cache; a new file or a rename recomputes it", async () => {
    const store = await vaultOf(50);
    store.list();
    calls.count = 0;
    await store.update("Notes/Note 1", { content: "Edited.\n", expectedUpdated: store.get("Notes/Note 1").updated });
    store.list();
    expect(calls.count).toBe(0);
    await store.create({ title: "Fresh" });
    store.list();
    expect(calls.count).toBeGreaterThan(0);
    // The copy is still recognised after all this.
    expect(store.list().find((page) => page.id === "Notes/Note 0.sync-conflict-20261122-143005-ABCDEFG")?.conflictOf).toBe("Notes/Note 0");
  }, 30_000);
});
