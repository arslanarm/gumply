import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VaultStore } from "../src/vault-store";
import { createApp } from "../src/app";
import { cleanupVaults, createTestServer, trackStore } from "./helpers";

/**
 * #zy9dqwwz (data-safety hunt on New database): a database owns its rows folder by name (People.base next to
 * People/, its marker and `file.folder == "People"`). Renaming the database takes the folder along (#7prbquxu).
 * Renaming or moving the **folder** itself (the sidebar once "Show rows" is on, Move to…, the API or MCP) must not
 * leave the database empty with its rows elsewhere: either the database follows the folder, or the change is
 * refused. Synthetic vault.
 */

afterEach(cleanupVaults);

const BASE = 'gumply:\n  rows: People\nfilters:\n  and:\n    - file.folder == "People"\nviews:\n  - type: table\n    name: Table\n    order:\n      - file.name\n      - role\n';

async function database() {
  const server = await createTestServer();
  await mkdir(join(server.dir, "People"), { recursive: true });
  await mkdir(join(server.dir, "Archive"), { recursive: true });
  await writeFile(join(server.dir, "Archive", "Old.md"), "Old\n", "utf8");
  await writeFile(join(server.dir, "People.base"), BASE, "utf8");
  await writeFile(join(server.dir, "People", "Ann.md"), "---\nrole: Cook\n---\nAnn\n", "utf8");
  await writeFile(join(server.dir, "People", "Bo.md"), "---\nrole: Pilot\n---\nBo\n", "utf8");
  const store = trackStore(new VaultStore(server.dir));
  await store.init();
  const app = createApp({ vaultPath: server.dir, store });
  /** The titles the database's table shows, whatever its id is now. */
  const rowsShown = async () => {
    const base = store.list().find((meta) => meta.kind === "base");
    const response = await app.request(`/api/bases/${encodeURIComponent(base!.id)}/view`);
    const view = (await response.json()) as { rows: Array<{ id: string }> };
    return view.rows.map((row) => row.id.split("/").pop()).sort();
  };
  expect(await rowsShown()).toEqual(["Ann", "Bo"]);
  return { dir: server.dir, store, rowsShown };
}

describe("the rows folder renamed or moved on its own: the database still shows its rows (#zy9dqwwz)", () => {
  it("renamed (People → Staff)", async () => {
    const { store, rowsShown } = await database();
    await store.update("People", { title: "Staff" }).catch(() => undefined);
    expect(await rowsShown()).toEqual(["Ann", "Bo"]);
  });

  it("moved into another folder (People → Archive/People)", async () => {
    const { store, rowsShown } = await database();
    await store.move("People", "Archive").catch(() => undefined);
    expect(await rowsShown()).toEqual(["Ann", "Bo"]);
  });

  it("the database moved into another folder (People.base → Archive/People.base)", async () => {
    const { dir, store, rowsShown } = await database();
    await store.move("People.base", "Archive").catch(() => undefined);
    expect(await rowsShown()).toEqual(["Ann", "Bo"]);
    // Whichever way it went, the rows themselves are untouched.
    const ann = await readFile(join(dir, "People", "Ann.md"), "utf8").catch(() => readFile(join(dir, "Archive", "People", "Ann.md"), "utf8"));
    expect(ann).toBe("---\nrole: Cook\n---\nAnn\n");
  });
});
