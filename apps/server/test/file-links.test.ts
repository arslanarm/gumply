import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BaseViewResult, BoardDocument, Page } from "@gumply/core";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { VaultStore } from "../src/vault-store";
import { cleanupVaults, createTestServer, encodeId, getJson } from "./helpers";

afterEach(cleanupVaults);

/** #8k4ssrkb: Obsidian-style `![[x.png]]` resolve across the vault, as Obsidian 1.14.4 does. */
async function vault(files: Record<string, string>) {
  const server = await createTestServer();
  for (const [path, body] of Object.entries(files)) {
    await mkdir(join(server.dir, path, ".."), { recursive: true });
    await writeFile(join(server.dir, path), body, "utf8");
  }
  const store = new VaultStore(server.dir);
  await store.init();
  return { dir: server.dir, store, app: createApp({ vaultPath: server.dir, store }) };
}

const PNG = "\u0089PNG";
const HOME = "Root ![[photo.png]] and ![[pic.png|100]] and ![[att/pic.png]] and [[report.pdf]]\n\n`![[code.png]]`\n";

describe("Obsidian file links resolve across the vault (#8k4ssrkb)", () => {
  it("a page carries what each link resolves to, from that page; the file is never rewritten", async () => {
    const { app, dir } = await vault({
      "photo.png": PNG,
      "att/pic.png": PNG,
      "Files/report.pdf": "%PDF",
      "Home.md": HOME,
    });
    const page = await getJson<Page>(app, "/api/pages/Home");
    expect(page.fileLinks).toEqual({
      "photo.png": "photo.png",
      "pic.png": "att/pic.png",
      "att/pic.png": "att/pic.png",
      "report.pdf": "Files/report.pdf",
    });
    expect(await readFile(join(dir, "Home.md"), "utf8")).toBe(HOME);
    // A page without such links has no map.
    const plain = await vault({ "Plain.md": "No images here\n" });
    expect((await getJson<Page>(plain.app, "/api/pages/Plain")).fileLinks).toBeUndefined();
  });

  it("files under root attachments/ take part too", async () => {
    const { app } = await vault({ "attachments/up.png": PNG, "Note.md": "![[up.png]]\n" });
    expect((await getJson<Page>(app, "/api/pages/Note")).fileLinks).toEqual({ "up.png": "attachments/up.png" });
  });

  it("two notes in different folders resolve a same-named image from their own folder", async () => {
    const { app } = await vault({
      "Work/cover.png": PNG,
      "Home/cover.png": PNG,
      "Work/Plan.md": "![[cover.png]]\n",
      "Home/Plan.md": "![[cover.png]]\n",
    });
    expect((await getJson<Page>(app, `/api/pages/${encodeId("Work/Plan")}`)).fileLinks).toEqual({ "cover.png": "Work/cover.png" });
    expect((await getJson<Page>(app, `/api/pages/${encodeId("Home/Plan")}`)).fileLinks).toEqual({ "cover.png": "Home/cover.png" });
  });

  it("resolves a link typed after load; an unknown from is the vault root", async () => {
    const { app } = await vault({ "Work/cover.png": PNG, "Home/cover.png": PNG, "Work/Plan.md": "x\n" });
    const ask = (query: string) => getJson<{ path: string | null }>(app, `/api/files/resolve?${query}`);
    expect(await ask(`link=cover.png&from=${encodeId("Work/Plan")}`)).toEqual({ path: "Work/cover.png" });
    expect(await ask("link=cover.png&from=Gone%2FPage")).toEqual({ path: "Home/cover.png" });
    expect(await ask("link=COVER.PNG")).toEqual({ path: "Home/cover.png" });
    expect(await ask("link=missing.png")).toEqual({ path: null });
    expect((await app.request("/api/files/resolve")).status).toBe(400);
  });

  it("never resolves dot folders, the trash or non-attachment files", async () => {
    const { app } = await vault({
      ".trash/abc/secret.png": PNG,
      ".gumply/conflicts/old.png": PNG,
      ".obsidian/icon.png": PNG,
      "Note.md": "![[secret.png]] ![[old.png]] ![[icon.png]]\n",
    });
    expect((await getJson<Page>(app, "/api/pages/Note")).fileLinks).toEqual({ "secret.png": null, "old.png": null, "icon.png": null });
    expect(await getJson(app, "/api/files/resolve?link=Note.md")).toEqual({ path: null });
  });

  it("follows an attachment renamed or moved outside Gumply (watcher rescan)", async () => {
    const { app, store, dir } = await vault({ "att/pic.png": PNG, "Home.md": "![[pic.png]]\n" });
    expect((await getJson<Page>(app, "/api/pages/Home")).fileLinks).toEqual({ "pic.png": "att/pic.png" });
    await mkdir(join(dir, "assets"), { recursive: true });
    await rename(join(dir, "att/pic.png"), join(dir, "assets/pic.png"));
    await store.rescan();
    expect((await getJson<Page>(app, "/api/pages/Home")).fileLinks).toEqual({ "pic.png": "assets/pic.png" });
  });

  it("board text resolves from the board", async () => {
    const board = { nodes: [{ id: "a", type: "text", text: "![[map.png]]", x: 0, y: 0, width: 200, height: 100 }], edges: [] };
    const { app } = await vault({ "Trips/map.png": PNG, "Other/map.png": PNG, "Trips/Plan.canvas": JSON.stringify(board) });
    const doc = await getJson<BoardDocument>(app, `/api/boards/${encodeId("Trips/Plan.canvas")}`);
    expect(doc.fileLinks).toEqual({ "map.png": "Trips/map.png" });
  });

  it("a database cover written as a wikilink resolves from its row's page", async () => {
    const { app } = await vault({
      "Work/cover.png": PNG,
      "Home/cover.png": PNG,
      "Work/A.md": '---\ncover: "[[cover.png]]"\n---\nA\n',
      "Home/B.md": '---\ncover: "[[cover.png]]"\n---\nB\n',
      // #wf4hhfj7: the shared syntax: a `[` inside is no link; `#part|alias` is dropped.
      "Home/C.md": '---\ncover: "[[a[b.png]]"\n---\nC\n',
      "Home/D.md": '---\ncover: "![[cover.png#x|y]]"\n---\nD\n',
      "All.base": "views:\n  - type: cards\n    name: Cards\n    image: note.cover\n",
    });
    const result = await getJson<BaseViewResult>(app, "/api/bases/All.base/view");
    const files = Object.fromEntries(result.rows.map((row) => [row.id, row.files]));
    expect(files["Work/A"]).toEqual({ "cover.png": "Work/cover.png" });
    expect(files["Home/B"]).toEqual({ "cover.png": "Home/cover.png" });
    expect(files["Home/C"]).toBeUndefined();
    expect(files["Home/D"]).toEqual({ "cover.png": "Home/cover.png" });
  });
  it("an uploaded or imported file resolves by its bare name at once, before any rescan (#zawz963a)", async () => {
    const { app } = await vault({ "Work/Plan.md": "x\n" });
    const ask = () => getJson<{ path: string | null }>(app, `/api/files/resolve?link=fresh.png&from=${encodeId("Work/Plan")}`);
    expect(await ask()).toEqual({ path: null });
    const form = new FormData();
    form.set("file", new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "fresh.png", { type: "image/png" }));
    const upload = await app.request("/api/attachments", { method: "POST", body: form });
    expect(upload.status).toBe(201);
    expect(await ask()).toEqual({ path: "attachments/fresh.png" });
  });
});
