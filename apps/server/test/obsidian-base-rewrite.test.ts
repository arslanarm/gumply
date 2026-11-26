import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { VaultStore } from "../src/vault-store";
import { cleanupVaults, createTestServer, trackStore } from "./helpers";

/**
 * #iwbnjeqh (hunt: Obsidian and Gumply editing the same database): `fixtures/obsidian-1.14.4/People.base` is the
 * exact file Obsidian 1.14.4's Bases view wrote (a sealed run) after adding a formula and renaming the Stage column's
 * display name in a Gumply database. Obsidian keeps Gumply's keys (the `gumply:` marker, `gumplyType` and
 * `gumplyOptions`, through its `unrecognizedData`), only moving `displayName` after them. Gumply must read it as the
 * same owned database with the same options, and an option rename must leave every line Obsidian wrote as it was.
 * A guard: it holds on main 46136144.
 */

afterEach(cleanupVaults);

const here = dirname(fileURLToPath(import.meta.url));
const fixture = () => readFile(join(here, "fixtures", "obsidian-1.14.4", "People.base"), "utf8");

async function database() {
  const server = await createTestServer();
  await mkdir(join(server.dir, "People"), { recursive: true });
  await writeFile(join(server.dir, "People.base"), await fixture(), "utf8");
  await writeFile(join(server.dir, "People", "Ann.md"), "---\nrole: Cook\nstage: Todo\n---\nAnn\n", "utf8");
  await writeFile(join(server.dir, "People", "Bo.md"), "---\nrole: Pilot\nstage: Doing\n---\nBo\n", "utf8");
  // A value typed in Obsidian that isn't an option.
  await writeFile(join(server.dir, "People", "Cy.md"), "---\nrole: Diver\nstage: Blocked\n---\nCy\n", "utf8");
  const store = trackStore(new VaultStore(server.dir));
  await store.init();
  return { dir: server.dir, store };
}

describe("a database Obsidian 1.14.4 rewrote is the same Gumply database (#iwbnjeqh)", () => {
  it("still owns its rows folder, and the Select keeps its options in order, with their colours", async () => {
    const { store } = await database();
    const meta = store.list().find((item) => item.id === "People.base");
    expect(meta?.rowsFolder).toBe("People");
    const base = store.getBase("People.base");
    const stage = (base.config.properties as Record<string, Record<string, unknown>>)["note.stage"];
    expect(stage?.gumplyType).toBe("select");
    expect(stage?.gumplyOptions).toEqual([
      { value: "Todo", color: "blue" },
      { value: "Doing", color: "orange" },
      { value: "Done", color: "green" },
    ]);
    expect(stage?.displayName).toBe("Phase");
  });

  it("an option rename changes only that option's line in the base and the rows that hold it; Obsidian's other lines and a value outside the options stay", async () => {
    const { dir, store } = await database();
    const before = await fixture();
    const result = await store.changeOwnedRowsOption("People.base", { key: "stage", rename: { from: "Doing", to: "Working" } });
    expect(result.refused).toEqual([]);
    expect(result.changed).toEqual(["People/Bo"]);
    const after = await readFile(join(dir, "People.base"), "utf8");
    expect(after).toBe(before.replace("      - value: Doing\n", "      - value: Working\n"));
    expect(await readFile(join(dir, "People", "Cy.md"), "utf8")).toBe("---\nrole: Diver\nstage: Blocked\n---\nCy\n");
    expect(await readFile(join(dir, "People", "Ann.md"), "utf8")).toBe("---\nrole: Cook\nstage: Todo\n---\nAnn\n");
  });
});
