import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VaultStore } from "../src/vault-store";

/**
 * #m67tqa7m: an outside refresh puts the new records in place and recomputes
 * their links before it awaits any history work, so a request served while
 * the history step runs sees a page list and links that match.
 */
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gumply-consistency-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

type Internals = { versionFromOutside: (...args: unknown[]) => Promise<unknown> };

/** Hold the refresh's history step until `release()`; `entered` resolves once it's reached. */
function holdHistory(store: VaultStore) {
  const internals = store as unknown as Internals;
  const original = internals.versionFromOutside;
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const reached = new Promise<void>((resolve) => (entered = resolve));
  internals.versionFromOutside = async function (this: unknown, ...args: unknown[]) {
    entered();
    await gate;
    return original.apply(this, args);
  };
  return { reached, release, restore: () => (internals.versionFromOutside = original) };
}

const backlinkIds = (store: VaultStore, id: string) => store.backlinks(id).map((item) => item.page.id).sort();

describe("links match the page list during an outside refresh's history step (#m67tqa7m)", () => {
  it("an edit that changes a page's own links: backlinks and the graph are already new", async () => {
    await writeFile(join(dir, "Hub.md"), "The hub.\n");
    await writeFile(join(dir, "Other.md"), "Another target.\n");
    await writeFile(join(dir, "Note.md"), "Links to [[Hub]].\n");
    const store = new VaultStore(dir);
    await store.init();
    await writeFile(join(dir, "Note.md"), "Now links to [[Other]] instead.\n");
    const held = holdHistory(store);
    try {
      const refresh = store.rescan();
      await held.reached; // The history step is running; the refresh isn't done.
      expect(store.get("Note").content).toContain("[[Other]]");
      expect(backlinkIds(store, "Other")).toEqual(["Note"]);
      expect(backlinkIds(store, "Hub")).toEqual([]);
      expect(store.graph().links.map((link) => `${link.source}>${link.target}`)).toEqual(["Note>Other"]);
      held.release();
      await refresh;
    } finally {
      held.restore();
    }
  });

  it("a rename outside that moves a link target: the reindex is done before the history step", async () => {
    await writeFile(join(dir, "Target.md"), "---\ntitle: Target\n---\nIt.\n");
    await writeFile(join(dir, "Linker.md"), "See [[Fresh]].\n");
    await writeFile(join(dir, "Changed.md"), "Will change.\n");
    const store = new VaultStore(dir);
    await store.init();
    // A new page "Fresh" appears (a target moves: full reindex), and another page is edited (a history step).
    await writeFile(join(dir, "Fresh.md"), "New.\n");
    await writeFile(join(dir, "Changed.md"), "Changed outside.\n");
    const held = holdHistory(store);
    try {
      const refresh = store.rescan();
      await held.reached;
      expect(store.list().some((meta) => meta.id === "Fresh")).toBe(true);
      expect(backlinkIds(store, "Fresh")).toEqual(["Linker"]);
      expect(store.graph().unresolved).not.toContainEqual({ source: "Linker", targetTitle: "Fresh" });
      held.release();
      await refresh;
    } finally {
      held.restore();
    }
  });
});
