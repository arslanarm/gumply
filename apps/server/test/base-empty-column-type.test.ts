import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createApp } from "../src/app";
import { VaultStore } from "../src/vault-store";
import { cleanupVaults, createTestServer, trackStore } from "./helpers";

/**
 * #bg7c9bzk (#faqr8pj9's #10): a column added as Number has its type in `.gumply/types.json` but no values yet.
 * The view must still report it as a number column (the menu ticks Number), not "text" because no page uses the
 * key. Synthetic vault.
 */

afterEach(cleanupVaults);

it("an empty typed column keeps the type types.json gives it (#bg7c9bzk)", async () => {
  const server = await createTestServer();
  await mkdir(join(server.dir, "Books"), { recursive: true });
  await mkdir(join(server.dir, ".gumply"), { recursive: true });
  await writeFile(join(server.dir, ".gumply", "types.json"), JSON.stringify({ year: "number" }), "utf8");
  await writeFile(
    join(server.dir, "Books.base"),
    'gumply:\n  rows: Books\nfilters:\n  and:\n    - file.folder == "Books"\nviews:\n  - type: table\n    name: Table\n    order:\n      - file.name\n      - year\n',
    "utf8",
  );
  await writeFile(join(server.dir, "Books", "Dune.md"), "Dune\n", "utf8");
  const store = trackStore(new VaultStore(server.dir));
  await store.init();
  const app = createApp({ vaultPath: server.dir, store });
  const view = (await (await app.request(`/api/bases/${encodeURIComponent("Books.base")}/view`)).json()) as { columns: Array<{ id: string; type: string }> };
  expect(view.columns.find((column) => column.id === "note.year")?.type).toBe("number");
});

