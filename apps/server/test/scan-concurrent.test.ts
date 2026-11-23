import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SCAN_CONCURRENCY, VaultStore } from "../src/vault-store";

/**
 * #g95wkd9y: a scan reads files concurrently (bounded), yet the index is
 * exactly a sequential read's: the same records, the same order, the same
 * ids for colliding names. Counted, never timed.
 */
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gumply-scan-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

type Internals = { scanConcurrency: number; pages: Map<string, unknown>; readRecord: (...args: unknown[]) => Promise<unknown> };

async function fixture(): Promise<void> {
  // Collisions and nesting: a board and a page of one name, a page whose name
  // is a board's, a folder page with sub-pages, a plain folder, deep nesting.
  await writeFile(join(dir, "Map.canvas"), JSON.stringify({ nodes: [], edges: [] }));
  await writeFile(join(dir, "Map.md"), "The page Map, linking [[Work]].\n");
  await writeFile(join(dir, "Map.canvas.md"), "A page named like the board.\n");
  await writeFile(join(dir, "Work.md"), "---\ntitle: Work\ntags: [area]\n---\nThe folder page.\n");
  await mkdir(join(dir, "Work", "Deep", "Deeper"), { recursive: true });
  for (let i = 0; i < 60; i++) await writeFile(join(dir, "Work", `Task ${i}.md`), `Task ${i} #tag${i % 3} [[Task ${(i + 1) % 60}]]\n`);
  await writeFile(join(dir, "Work", "Deep", "Deeper", "Leaf.md"), "Leaf [[Map]].\n");
  await mkdir(join(dir, "Plain"));
  for (let i = 0; i < 40; i++) await writeFile(join(dir, "Plain", `Note ${i}.md`), `---\nicon: 📝\n---\nNote ${i} [[Missing ${i}]]\n`);
}

async function opened(concurrency: number): Promise<VaultStore> {
  const store = new VaultStore(dir);
  (store as unknown as Internals).scanConcurrency = concurrency;
  await store.init();
  return store;
}

describe("concurrent scan (#g95wkd9y)", () => {
  it("gives exactly the sequential read's index: records, order, ids, tags, links", async () => {
    await fixture();
    const sequential = await opened(1);
    const concurrent = await opened(SCAN_CONCURRENCY);
    const order = (store: VaultStore) => [...(store as unknown as Internals).pages.keys()];
    expect(order(concurrent)).toEqual(order(sequential));
    expect(concurrent.list()).toEqual(sequential.list());
    expect(concurrent.graph()).toEqual(sequential.graph());
    expect(concurrent.tags()).toEqual(sequential.tags());
    // The collisions resolved the same way.
    expect(order(concurrent)).toEqual(expect.arrayContaining(["Map.canvas", "Map", "Map.canvas.md", "Work", "Work/Deep/Deeper/Leaf"]));
  });

  it(`never reads more than ${SCAN_CONCURRENCY} files at once, and does read several at once`, async () => {
    await fixture();
    const store = new VaultStore(dir);
    const internals = store as unknown as Internals;
    const readRecord = internals.readRecord;
    let inFlight = 0;
    let most = 0;
    internals.readRecord = async function (this: unknown, ...args: unknown[]) {
      inFlight += 1;
      most = Math.max(most, inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 2));
        return await readRecord.apply(this, args);
      } finally {
        inFlight -= 1;
      }
    };
    await store.init();
    expect(most).toBeLessThanOrEqual(SCAN_CONCURRENCY);
    expect(most).toBeGreaterThan(1);
    expect(store.list().filter((meta) => meta.kind !== "folder")).toHaveLength(105); // 3 at the root, Work, 60 tasks, the leaf, 40 notes
  });
});
