import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VaultStore } from "../src/vault-store";
import { createApp } from "../src/app";
import { cleanupVaults, createTestServer, encodeId, jsonRequest, trackStore } from "./helpers";

/**
 * #zy9dqwwz (data-safety hunt on New database), hypotheses 3–5: a save into a row whose database was deleted with
 * its rows, an API delete of a database without `withRows`, and an undo after another app renamed a row. Each must
 * refuse or leave the rows as they are, never write behind the user's back. Synthetic vault.
 */

afterEach(cleanupVaults);

const BASE = 'gumply:\n  rows: People\nfilters:\n  and:\n    - file.folder == "People"\nviews:\n  - type: table\n    name: Table\n    order:\n      - file.name\n      - role\n';
const ANN = "---\nrole: Cook\n---\nAnn\n";

async function database() {
  const server = await createTestServer();
  await mkdir(join(server.dir, "People"), { recursive: true });
  await writeFile(join(server.dir, "People.base"), BASE, "utf8");
  await writeFile(join(server.dir, "People", "Ann.md"), ANN, "utf8");
  const store = trackStore(new VaultStore(server.dir));
  await store.init();
  const app = createApp({ vaultPath: server.dir, store });
  return { dir: server.dir, store, app };
}

describe("New database: saves, deletes and undos that must not write behind the user's back (#zy9dqwwz)", () => {
  it("3. a row open in the editor, its database deleted with its rows: the pending save is refused, nothing made again", async () => {
    const { dir, store, app } = await database();
    const version = store.get("People/Ann").updated;
    await store.remove("People.base", { withRows: true });
    const response = await jsonRequest(app, "PUT", `/api/pages/${encodeId("People/Ann")}`, { content: "Ann, edited.", expectedUpdated: version });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(existsSync(join(dir, "People", "Ann.md"))).toBe(false);
    // The row is in the Trash, as it was.
    const [item] = await store.listTrash();
    await store.restore(item!.trashId);
    expect(await readFile(join(dir, "People", "Ann.md"), "utf8")).toBe(ANN);
  });

  it("4. DELETE of a database without withRows (API, MCP) leaves its rows where they are, visible", async () => {
    const { dir, store, app } = await database();
    const response = await app.request(`/api/pages/${encodeId("People.base")}`, { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(await readFile(join(dir, "People", "Ann.md"), "utf8")).toBe(ANN);
    expect(store.list().find((meta) => meta.id === "People")?.ownedBy).toBeUndefined();
  });

  it("5. undo after another app renamed a pasted row: refused and named, the old name isn't made again", async () => {
    const { dir, store } = await database();
    const pasted = await store.pasteIntoOwnedRows("People.base", { rows: [{ title: "Bo", set: { role: "Pilot" } }] });
    const bo = await readFile(join(dir, "People", "Bo.md"), "utf8");
    // Obsidian renames the row.
    await rename(join(dir, "People", "Bo.md"), join(dir, "People", "Robert.md"));
    await store.rescan();
    const undo = await store.undoDatabaseChange("People.base", { drop: pasted.made.map((row) => ({ id: row.id, from: row.after })) });
    expect(undo.refused.map((row) => row.id)).toEqual(["People/Bo"]);
    expect(existsSync(join(dir, "People", "Bo.md"))).toBe(false);
    expect(await readFile(join(dir, "People", "Robert.md"), "utf8")).toBe(bo);
  });
});
