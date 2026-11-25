import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VaultStore } from "../src/vault-store";
import { cleanupVaults, createTestServer } from "./helpers";

/**
 * #siuwzhwy (@opus-editor's review): a rename rewrites the links that resolve to the
 * renamed page (D12). Links written with the file's extension (`[[Note.md]]`) or in the
 * other Unicode form (NFC vs NFD) resolve to it now, so the rename rewrites them too;
 * on 0.9.3 they resolved to nothing and were left pointing at the old name. Every
 * other byte of a linking page stays as it was (D37), aliases included.
 */

afterEach(cleanupVaults);

async function vault(files: Record<string, string>) {
  const server = await createTestServer();
  for (const [path, body] of Object.entries(files)) {
    await mkdir(join(server.dir, path, ".."), { recursive: true });
    await writeFile(join(server.dir, path), body, "utf8");
  }
  const store = new VaultStore(server.dir);
  await store.init();
  return { dir: server.dir, store };
}

describe("a rename rewrites links written with .md or in the other Unicode form (#siuwzhwy)", () => {
  it("rename Note → Memo rewrites [[Note.md]], keeps its alias, and leaves an unrelated link's bytes alone", async () => {
    const source = "See [[Note.md]], [[Note.md|the note]] and [[note]].\nAlso [[Other]], spaced  as is.\n";
    const { dir, store } = await vault({ "Note.md": "# Note\n", "Other.md": "# Other\n", "Source.md": source });
    await store.update("Note", { title: "Memo" });
    const after = await readFile(join(dir, "Source.md"), "utf8");
    expect(after).toBe("See [[Memo]], [[Memo|the note]] and [[Memo]].\nAlso [[Other]], spaced  as is.\n");
  });

  it("rename of a page whose name is decomposed (NFD) rewrites a composed (NFC) link to it", async () => {
    const nfd = "Café".normalize("NFD");
    const { dir, store } = await vault({ [`${nfd}.md`]: "# Café\n", "Source.md": "Go to [[Café]] now.\n" });
    const id = (await store.list()).find((meta) => meta.id.normalize("NFC") === "Café")!.id;
    await store.update(id, { title: "Bistro" });
    expect(await readFile(join(dir, "Source.md"), "utf8")).toBe("Go to [[Bistro]] now.\n");
  });
});
