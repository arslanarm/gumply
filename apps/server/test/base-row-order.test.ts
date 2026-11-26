import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { VaultStore } from "../src/vault-store";
import { cleanupVaults, createTestServer, trackStore } from "./helpers";

/**
 * #bg7c9bzk (#faqr8pj9's #9, @lead's ruling (a)): a database Gumply owns, whose view has no sort, lists its rows
 * oldest first (Notion's default), by the `created:` each row stores in its frontmatter (never the file's birth
 * time, which sync and git reset). A paste gives its rows increasing `created:` in the sheet's order. Rows with no
 * `created:` (made in Obsidian) come after, by name. A base Gumply doesn't own keeps its order. Synthetic vault.
 */

afterEach(cleanupVaults);

const OWNED = 'gumply:\n  rows: Plants\nfilters:\n  and:\n    - file.folder == "Plants"\nviews:\n  - type: table\n    name: Table\n    order:\n      - file.name\n';

async function vault(files: Record<string, string>) {
  const server = await createTestServer();
  await mkdir(join(server.dir, "Plants"), { recursive: true });
  for (const [path, body] of Object.entries(files)) await writeFile(join(server.dir, path), body, "utf8");
  const store = trackStore(new VaultStore(server.dir));
  await store.init();
  const app = createApp({ vaultPath: server.dir, store });
  const order = async (base: string) =>
    ((await (await app.request(`/api/bases/${encodeURIComponent(base)}/view`)).json()) as { rows: Array<{ id: string }> }).rows.map((row) => row.id.split("/").pop());
  return { dir: server.dir, store, order };
}

describe("an owned database with no sort lists rows oldest first (#bg7c9bzk)", () => {
  it("a paste's rows keep the sheet's order, after the rows that were there", async () => {
    const { store, order } = await vault({ "Plants.base": OWNED, "Plants/Zinnia.md": "---\ncreated: 2026-01-01T00:00:00.000Z\n---\nZinnia\n" });
    await store.pasteIntoOwnedRows("Plants.base", { rows: ["Monstera", "Basil", "Cactus", "Aloe"].map((title) => ({ title, set: {} })) });
    expect(await order("Plants.base")).toEqual(["Zinnia", "Monstera", "Basil", "Cactus", "Aloe"]);
  });

  it("rows with no created: (made in Obsidian) come after the others, by name", async () => {
    const { order } = await vault({
      "Plants.base": OWNED,
      "Plants/Mint.md": "---\ncreated: 2026-02-01T00:00:00.000Z\n---\nMint\n",
      "Plants/Basil.md": "---\ncreated: 2026-03-01T00:00:00.000Z\n---\nBasil\n",
      "Plants/Yarrow.md": "Yarrow, from Obsidian.\n",
      "Plants/Aloe.md": "Aloe, from Obsidian.\n",
    });
    expect(await order("Plants.base")).toEqual(["Mint", "Basil", "Aloe", "Yarrow"]);
  });

  it("a view with its own sort, and a base Gumply doesn't own, keep their order", async () => {
    const sorted = OWNED.replace("    order:\n", "    sort:\n      - property: file.name\n        direction: ASC\n    order:\n");
    const plain = 'filters:\n  and:\n    - file.inFolder("Plants")\nviews:\n  - type: table\n    name: Table\n';
    const { order } = await vault({
      "Plants.base": sorted,
      "Other.base": plain,
      "Plants/Mint.md": "---\ncreated: 2026-02-01T00:00:00.000Z\n---\nMint\n",
      "Plants/Basil.md": "---\ncreated: 2026-03-01T00:00:00.000Z\n---\nBasil\n",
    });
    expect(await order("Plants.base")).toEqual(["Basil", "Mint"]);
    expect(await order("Other.base")).toEqual(["Basil", "Mint"]);
  });
});
