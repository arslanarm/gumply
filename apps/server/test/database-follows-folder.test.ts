import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VaultStore } from "../src/vault-store";
import { cleanupVaults, createTestServer, trackStore } from "./helpers";

/**
 * #dcc5p5um (#zy9dqwwz H2, @lead's ruling): a database follows its rows folder. Renaming or moving the folder in
 * the app renames or moves the database with it (the marker and filter rewritten, as a database rename does), and
 * moving the database takes its folder. Synthetic vault.
 */

afterEach(cleanupVaults);

const base = (rows: string) =>
  `gumply:\n  rows: ${rows}\nfilters:\n  and:\n    - file.folder == "${rows}"\nviews:\n  - type: table\n    name: Table\n`;
const ANN = "---\nrole: Cook\n---\nAnn\n";

async function vault(extra: Record<string, string> = {}) {
  const server = await createTestServer();
  const files: Record<string, string> = { "People.base": base("People"), "People/Ann.md": ANN, "Archive/Old.md": "Old\n", ...extra };
  for (const [path, body] of Object.entries(files)) {
    await mkdir(join(server.dir, path, ".."), { recursive: true });
    await writeFile(join(server.dir, path), body, "utf8");
  }
  const store = trackStore(new VaultStore(server.dir));
  await store.init();
  const read = (path: string) => readFile(join(server.dir, path), "utf8");
  return { dir: server.dir, store, read };
}

describe("a database follows its rows folder (#dcc5p5um)", () => {
  it("renaming the folder renames the database: Staff.base owns Staff/, and the row is untouched", async () => {
    const { dir, store, read } = await vault();
    await store.update("People", { title: "Staff" });
    expect(existsSync(join(dir, "People.base"))).toBe(false);
    expect(await read("Staff.base")).toBe(base("Staff"));
    expect(await read("Staff/Ann.md")).toBe(ANN);
    expect(store.list().find((meta) => meta.id === "Staff.base")).toMatchObject({ rowsFolder: "Staff" });
  });

  it("a taken name: the folder rename picks a name free for both (\"Staff 2\")", async () => {
    const { store, read } = await vault({ "Staff/Other.md": "Other\n" });
    await store.update("People", { title: "Staff" });
    expect(await read("Staff 2.base")).toBe(base("Staff 2"));
    expect(await read("Staff 2/Ann.md")).toBe(ANN);
    expect(await read("Staff/Other.md")).toBe("Other\n");
  });

  it("moving the folder moves the database next to it; the marker and filter name the new path", async () => {
    const { dir, store, read } = await vault();
    await store.move("People", "Archive");
    expect(existsSync(join(dir, "People.base"))).toBe(false);
    expect(await read("Archive/People.base")).toBe(base("Archive/People"));
    expect(await read("Archive/People/Ann.md")).toBe(ANN);
    expect(store.list().find((meta) => meta.id === "Archive/People.base")).toMatchObject({ rowsFolder: "Archive/People" });
  });

  it("moving the database takes its folder", async () => {
    const { dir, store, read } = await vault();
    await store.move("People.base", "Archive");
    expect(existsSync(join(dir, "People"))).toBe(false);
    expect(await read("Archive/People/Ann.md")).toBe(ANN);
    expect(await read("Archive/People.base")).toBe(base("Archive/People"));
  });

  it("a move whose folder place is taken changes nothing", async () => {
    const { dir, store, read } = await vault({ "Archive/People/Kept.md": "Kept\n" });
    await expect(store.move("People", "Archive")).rejects.toThrow();
    expect(await read("People.base")).toBe(base("People"));
    expect(await read("People/Ann.md")).toBe(ANN);
    expect(existsSync(join(dir, "Archive/People.base"))).toBe(false);
  });
});
