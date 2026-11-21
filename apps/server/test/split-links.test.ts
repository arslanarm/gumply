import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupVaults, createTestServer, encodeId, getJson, jsonRequest } from "./helpers";

/** #pvrx7t6r: a `[[link]]` split across a line break is plain text, as in Obsidian. */

afterEach(cleanupVaults);

describe("split [[links]]", () => {
  it("aren't backlinks or graph edges, and a rename leaves them byte for byte", async () => {
    const { app, dir, store } = await createTestServer();
    await writeFile(join(dir, "Alpha.md"), "Alpha page.\n");
    await writeFile(join(dir, "Split.md"), "See [[Alpha|b\nc]] here.\n");
    const both = "See [[Alpha|b\r\nc]] and [[Alpha]].\r\n";
    await writeFile(join(dir, "Both.md"), both);
    await store.rescan();

    const backlinks = await getJson<Array<{ page: { id: string } }>>(app, `/api/pages/${encodeId("Alpha")}/backlinks`);
    expect(backlinks.map((item) => item.page.id)).toEqual(["Both"]);
    const graph = await getJson<{ links: Array<{ source: string; target: string }>; unresolved: unknown[] }>(app, "/api/graph");
    expect(graph.links).toEqual([{ source: "Both", target: "Alpha" }]);
    expect(graph.unresolved).toEqual([]);

    const page = await getJson<{ updated: string }>(app, `/api/pages/${encodeId("Alpha")}`);
    const response = await jsonRequest(app, "PUT", `/api/pages/${encodeId("Alpha")}`, { title: "Omega", expectedUpdated: page.updated });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { rewrittenPages: string[] }).rewrittenPages).toEqual(["Both"]);
    expect(await readFile(join(dir, "Split.md"), "utf8")).toBe("See [[Alpha|b\nc]] here.\n");
    expect(await readFile(join(dir, "Both.md"), "utf8")).toBe("See [[Alpha|b\r\nc]] and [[Omega]].\r\n");
  });
});
