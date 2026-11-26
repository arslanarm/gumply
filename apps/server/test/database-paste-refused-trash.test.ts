import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VaultStore } from "../src/vault-store";
import { cleanupVaults, createTestServer, trackStore } from "./helpers";

/**
 * #f4jkpja6 follow-up (@lead): a refused paste's own new rows go to the Trash as **one** item, "N rows from People"
 * (the undo's grouped `"rows"` entry), not one item per row; the result counts them (`inTrash`) so the alert can say
 * so. A row changed meanwhile is in the same item and is still named. Synthetic vault.
 */

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupVaults();
});

const BASE = 'gumply:\n  rows: People\nfilters:\n  and:\n    - file.folder == "People"\nviews:\n  - type: table\n    name: Table\n    order:\n      - file.name\n      - role\n';

async function database(files: Record<string, string> = {}) {
  const server = await createTestServer();
  await mkdir(join(server.dir, "People"), { recursive: true });
  await writeFile(join(server.dir, "People.base"), BASE, "utf8");
  for (const [path, body] of Object.entries(files)) await writeFile(join(server.dir, path), body, "utf8");
  const store = trackStore(new VaultStore(server.dir));
  await store.init();
  return { dir: server.dir, store };
}

describe("a refused paste's new rows in the Trash (#f4jkpja6 follow-up)", () => {
  it("are one Trash item, counted, restored as one", async () => {
    const { dir, store } = await database({ "People/Ann.md": "Ann\n" });
    // Bo and Cy are made; the next new row can't be (its title is too long), so the paste is refused.
    const result = await store.pasteIntoOwnedRows("People.base", {
      rows: [
        { title: "Bo", set: { role: "Pilot" } },
        { title: "Cy", set: { role: "Cook" } },
        { title: "X".repeat(400), set: { role: "Diver" } },
      ],
    });
    expect(result.refused.length).toBeGreaterThan(0);
    expect(result.inTrash).toBe(2);
    expect(result.trashed).toEqual([]);
    expect(existsSync(join(dir, "People", "Bo.md"))).toBe(false);
    expect(existsSync(join(dir, "People", "Cy.md"))).toBe(false);
    const trash = await store.listTrash();
    expect(trash).toHaveLength(1);
    expect(trash[0]).toMatchObject({ id: "People", undoRows: 2 });
    expect(trash[0]!.children.map((child) => child.id).sort()).toEqual(["People/Bo", "People/Cy"]);
    // Ann, and the folder, stay.
    expect(await readFile(join(dir, "People", "Ann.md"), "utf8")).toBe("Ann\n");

    await store.restore(trash[0]!.trashId);
    expect(existsSync(join(dir, "People", "Bo.md"))).toBe(true);
    expect(existsSync(join(dir, "People", "Cy.md"))).toBe(true);
    expect(await store.listTrash()).toEqual([]);
  });
});
