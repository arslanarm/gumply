import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VaultStore } from "../src/vault-store";
import { cleanupVaults, createTestServer, trackStore } from "./helpers";

/**
 * #bg7c9bzk (#faqr8pj9's #20, @lead's ruling): a row a database makes (New row, paste) writes `title:` only when
 * its file name can't carry the title, and never `tags: []`; Obsidian then shows no empty properties on every row.
 * Plain pages are unchanged. A row made either way reads back with the same title (the grid, search, links).
 */

afterEach(cleanupVaults);

const BASE = 'gumply:\n  rows: People\nfilters:\n  and:\n    - file.folder == "People"\nviews:\n  - type: table\n    name: Table\n    order:\n      - file.name\n';

async function database() {
  const server = await createTestServer();
  await mkdir(join(server.dir, "People"), { recursive: true });
  await writeFile(join(server.dir, "People.base"), BASE, "utf8");
  const store = trackStore(new VaultStore(server.dir));
  await store.init();
  return { dir: server.dir, store };
}

const frontmatterOf = (text: string) => text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";

describe("a database row's frontmatter (#bg7c9bzk)", () => {
  it('"Dune" (the file name carries it): no title:, no tags: []', async () => {
    const { dir, store } = await database();
    const row = await store.create({ title: "Dune", parentId: "People" });
    const yaml = frontmatterOf(await readFile(join(dir, `${row.id}.md`), "utf8"));
    expect(yaml).not.toMatch(/^title:/m);
    expect(yaml).not.toMatch(/^tags:/m);
    expect(store.get(row.id).title).toBe("Dune");
    expect(store.list().find((meta) => meta.id === row.id)?.title).toBe("Dune");
  });

  it('"Dune: Part 2" (the file name can\'t carry the colon): title: kept, no tags: []; it reads back the same after a rescan', async () => {
    const { dir, store } = await database();
    const row = await store.create({ title: "Dune: Part 2", parentId: "People" });
    const yaml = frontmatterOf(await readFile(join(dir, `${row.id}.md`), "utf8"));
    expect(yaml).toMatch(/^title: /m);
    expect(yaml).not.toMatch(/^tags:/m);
    await store.rescan();
    expect(store.get(row.id).title).toBe("Dune: Part 2");
  });

  it("a row made by a paste has the same shape", async () => {
    const { dir, store } = await database();
    await store.pasteIntoOwnedRows("People.base", { rows: [{ title: "Bo", set: { role: "Pilot" } }] });
    const yaml = frontmatterOf(await readFile(join(dir, "People", "Bo.md"), "utf8"));
    expect(yaml).not.toMatch(/^title:/m);
    expect(yaml).not.toMatch(/^tags:/m);
    expect(yaml).toMatch(/^role: Pilot$/m);
  });

  it("a plain page (not in a rows folder) is unchanged: title: and tags: [] as before", async () => {
    const { dir, store } = await database();
    const page = await store.create({ title: "Notes" });
    const yaml = frontmatterOf(await readFile(join(dir, `${page.id}.md`), "utf8"));
    expect(yaml).toMatch(/^title: Notes$/m);
    expect(yaml).toMatch(/^tags: \[\]$/m);
  });
});
