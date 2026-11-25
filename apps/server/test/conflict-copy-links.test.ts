import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VaultStore } from "../src/vault-store";
import { RM_VAULT } from "./helpers";

/**
 * #2badjmxf (D43): a sync tool's conflict copy beside its original holds no links. A cold start
 * (a full reindex) used to index the copy's `[[links]]` anyway, so it showed as a backlink and a
 * graph edge until something recomputed it; the incremental path already left copies out.
 */
const COPY = "A.sync-conflict-20261123-100000-ABCDEFG";
let dir: string;
let store: VaultStore | null = null;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gumply-copy-links-"));
  await writeFile(join(dir, "A.md"), "Mine, linking [[B]].\n");
  await writeFile(join(dir, `${COPY}.md`), "Theirs, linking [[B]] too.\n");
  await writeFile(join(dir, "B.md"), "The target.\n");
});

afterEach(async () => {
  store?.stopWatching();
  store = null;
  await rm(dir, RM_VAULT);
});

async function coldStart(): Promise<VaultStore> {
  store = new VaultStore(dir);
  await store.init();
  await store.whenIndexed();
  return store;
}
const backlinkIds = (s: VaultStore) => s.backlinks("B").map((link) => link.page.id).sort();
const copyEdges = (s: VaultStore) => s.graph().links.filter((link) => link.source === COPY);

describe("a conflict copy holds no links after a full reindex (#2badjmxf, D43)", () => {
  it("after a cold start, B's backlinks are only A, and the graph has no edge from the copy", async () => {
    const s = await coldStart();
    expect(backlinkIds(s)).toEqual(["A"]);
    expect(copyEdges(s)).toEqual([]);
  });

  it("still so after the original is edited (a save recomputes A) and after an outside change rescans the vault", async () => {
    const s = await coldStart();
    const a = s.get("A");
    await s.update("A", { content: "Mine, edited, still linking [[B]].\n", expectedUpdated: a.updated });
    expect(backlinkIds(s)).toEqual(["A"]);
    // An outside change that moves link targets runs a full reindex again.
    await writeFile(join(dir, "C.md"), "A new page, linking [[B]].\n");
    const later = new Date(Date.now() + 2_000);
    await utimes(join(dir, "C.md"), later, later);
    await s.rescan();
    expect(backlinkIds(s)).toEqual(["A", "C"]);
    expect(copyEdges(s)).toEqual([]);
  });
});
