import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupVaults, createTestServer, encodeId, getJson, jsonRequest } from "./helpers";

/**
 * spec/api v1.34 (#chbpc9yb): text about to be dropped kept as a `before-reload`
 * version (never written to the page file), and a restore that says what it undid.
 */

afterEach(cleanupVaults);

interface Item {
  file: string;
  reason?: string;
  source: string;
  undid?: string;
  restoredFrom?: string;
}

const items = async (app: Parameters<typeof getJson>[0], id: string) =>
  (await getJson<{ items: Item[] }>(app, `/api/history/${encodeId(id)}`)).items;

const version = async (app: Parameters<typeof getJson>[0], id: string, file: string) =>
  (await app.request(`/api/history/${encodeId(id)}/${encodeURIComponent(file)}`)).text();

describe("POST /api/history/:id/unsaved", () => {
  it("a page: the file's frontmatter as on disk with this body, as a before-reload version; the page file is untouched", async () => {
    const { app, dir, store } = await createTestServer();
    const file = join(dir, "Plan.md");
    const onDisk = "---\nstatus: draft\ntags: [work]\n---\nSaved line.\n";
    await writeFile(file, onDisk);
    await store.rescan();

    const response = await jsonRequest(app, "POST", `/api/history/${encodeId("Plan")}/unsaved`, { content: "Unsaved line." });
    expect(response.status).toBe(201);
    const created = (await response.json()) as { file: string; at: string };
    expect(created.file).toMatch(/\.md$/);

    expect(await readFile(file, "utf8")).toBe(onDisk); // D37: never written
    const list = await items(app, "Plan");
    const entry = list.find((item) => item.file === created.file)!;
    expect(entry).toMatchObject({ reason: "before-reload", source: "app" });
    expect(await version(app, "Plan", created.file)).toBe("---\nstatus: draft\ntags: [work]\n---\nUnsaved line.\n");

    // The same text again: nothing new.
    const again = await jsonRequest(app, "POST", `/api/history/${encodeId("Plan")}/unsaved`, { content: "Unsaved line." });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ saved: false });
    expect((await items(app, "Plan")).length).toBe(list.length);
  });

  it("a plain note (no frontmatter) stays plain in the version", async () => {
    const { app, dir, store } = await createTestServer();
    await writeFile(join(dir, "Plain.md"), "Saved.\n");
    await store.rescan();
    const response = await jsonRequest(app, "POST", `/api/history/${encodeId("Plain")}/unsaved`, { content: "Unsaved." });
    expect(response.status).toBe(201);
    const { file } = (await response.json()) as { file: string };
    expect(await version(app, "Plain", file)).toBe("Unsaved.\n");
  });

  it("a board: the board serialized, as a version; the board file is untouched", async () => {
    const { app, dir, store } = await createTestServer();
    const file = join(dir, "Map.canvas");
    const onDisk = '{"nodes":[],"edges":[]}';
    await writeFile(file, onDisk);
    await store.rescan();
    const board = { nodes: [{ id: "a", type: "text", text: "Unsaved card", x: 0, y: 0, width: 100, height: 50 }], edges: [] };
    const response = await jsonRequest(app, "POST", `/api/history/${encodeId("Map.canvas")}/unsaved`, { board });
    expect(response.status).toBe(201);
    const { file: versionFile } = (await response.json()) as { file: string };
    expect(versionFile).toMatch(/\.canvas$/);
    expect(await readFile(file, "utf8")).toBe(onDisk);
    const saved = JSON.parse(await version(app, "Map.canvas", versionFile)) as { nodes: Array<{ text: string }> };
    expect(saved.nodes[0]!.text).toBe("Unsaved card");
  });

  it("refuses what a save refuses: unknown page 404, wrong type 400, an invalid board 400, too large 413", async () => {
    const { app, dir, store } = await createTestServer();
    await writeFile(join(dir, "Plan.md"), "Saved.\n");
    await writeFile(join(dir, "Map.canvas"), '{"nodes":[],"edges":[]}');
    await store.rescan();
    expect((await jsonRequest(app, "POST", `/api/history/${encodeId("Nope")}/unsaved`, { content: "x" })).status).toBe(404);
    expect((await jsonRequest(app, "POST", `/api/history/${encodeId("Plan")}/unsaved`, { content: 5 })).status).toBe(400);
    expect((await jsonRequest(app, "POST", `/api/history/${encodeId("Map.canvas")}/unsaved`, { board: [] })).status).toBe(400);
    expect((await jsonRequest(app, "POST", `/api/history/${encodeId("Map.canvas")}/unsaved`, { board: { nodes: "no" } })).status).toBe(400);
    expect((await jsonRequest(app, "POST", `/api/history/${encodeId("Plan")}/unsaved`, { content: "x".repeat(5_000_001) })).status).toBe(413);
  });
});

describe("POST /api/history/:id/:file/restore with why", () => {
  it('"undo-keep-copy" marks the new entry undid: keep-copy; any other why is a 400', async () => {
    const { app, dir, store } = await createTestServer();
    await writeFile(join(dir, "Plan.md"), "Saved.\n");
    await store.rescan();
    const kept = (await (await jsonRequest(app, "POST", `/api/history/${encodeId("Plan")}/unsaved`, { content: "Earlier." })).json()) as { file: string };
    const page = await getJson<{ updated: string }>(app, `/api/pages/${encodeId("Plan")}`);

    const bad = await jsonRequest(app, "POST", `/api/history/${encodeId("Plan")}/${encodeURIComponent(kept.file)}/restore`, { expectedUpdated: page.updated, why: "because" });
    expect(bad.status).toBe(400);

    const response = await jsonRequest(app, "POST", `/api/history/${encodeId("Plan")}/${encodeURIComponent(kept.file)}/restore`, { expectedUpdated: page.updated, why: "undo-keep-copy" });
    expect(response.status).toBe(200);
    const restored = (await items(app, "Plan")).find((item) => item.restoredFrom === kept.file)!;
    expect(restored.undid).toBe("keep-copy");
    expect(await readFile(join(dir, "Plan.md"), "utf8")).toBe("Earlier.\n");
  });

  it("a plain restore carries no undid", async () => {
    const { app, dir, store } = await createTestServer();
    await writeFile(join(dir, "Plan.md"), "Saved.\n");
    await store.rescan();
    const kept = (await (await jsonRequest(app, "POST", `/api/history/${encodeId("Plan")}/unsaved`, { content: "Earlier." })).json()) as { file: string };
    const page = await getJson<{ updated: string }>(app, `/api/pages/${encodeId("Plan")}`);
    await jsonRequest(app, "POST", `/api/history/${encodeId("Plan")}/${encodeURIComponent(kept.file)}/restore`, { expectedUpdated: page.updated });
    const restored = (await items(app, "Plan")).find((item) => item.restoredFrom === kept.file)!;
    expect(restored.undid).toBeUndefined();
  });
});
