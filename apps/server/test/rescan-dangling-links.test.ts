import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VaultStore } from "../src/vault-store";
import { cleanupVaults, createTestServer } from "./helpers";

/**
 * #udbaghb4: a sync tool delivering many notes whose links point nowhere
 * (spec/sync-conflicts §2) made each rescan cost links × pages, and saves
 * waited behind it. The store queue is serial by design, so a save can't
 * overtake a rescan (that's spec/sync-conflicts §8's save priority); what
 * matters is that it's answered as soon as the rescan ends, and that the
 * rescan's own cost is linear (core's link-resolver.test.ts counts it).
 */

afterEach(cleanupVaults);

describe("a big rescan with dangling links (#udbaghb4)", () => {
  it("indexes every new page with its unresolved link, and a save queued behind it is answered", async () => {
    const server = await createTestServer();
    await writeFile(join(server.dir, "Mine.md"), "Draft.\n", "utf8");
    const store = new VaultStore(server.dir);
    await store.init();

    // What a sync tool drops in at once: 1500 notes, each linking to a note that isn't there.
    await mkdir(join(server.dir, "Synced"));
    for (let i = 0; i < 1500; i++) await writeFile(join(server.dir, "Synced", `Note ${i}.md`), `From elsewhere [[Missing ${i}]].\n`, "utf8");

    const rescan = store.rescan();
    const save = store.update("Mine", { content: "Draft, saved during the rescan.\n", expectedUpdated: store.get("Mine").updated });
    const [changed] = await Promise.all([rescan, save]);

    expect(changed).toBe(true);
    expect(await readFile(join(server.dir, "Mine.md"), "utf8")).toBe("Draft, saved during the rescan.\n");
    const graph = store.graph();
    expect(graph.nodes.filter((node) => node.id.startsWith("Synced/"))).toHaveLength(1500);
    expect(graph.unresolved.filter((link) => link.source.startsWith("Synced/"))).toHaveLength(1500);
  }, 60_000);
});
