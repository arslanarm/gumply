import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VaultError } from "../src/errors";
import { VaultStore } from "../src/vault-store";
import { cleanupVaults, createTestServer, trackStore } from "./helpers";

/**
 * #5q4vaacm (@lead's ruling 1): `PUT /api/pages/:id {title, exact: true}` takes exactly that name or nothing. A name
 * another page has, in any letter case, is a 409 before anything is written, never the next free " 2". A table's undo
 * of a rename uses it. Synthetic vault.
 */

afterEach(async () => {
  await cleanupVaults();
});

async function vault(files: Record<string, string>) {
  const server = await createTestServer();
  for (const [path, body] of Object.entries(files)) {
    await mkdir(join(server.dir, path, ".."), { recursive: true });
    await writeFile(join(server.dir, path), body, "utf8");
  }
  const store = trackStore(new VaultStore(server.dir));
  await store.init();
  return { dir: server.dir, store };
}

describe("an exact rename (#5q4vaacm)", () => {
  it("is refused with a 409 when another page has the name in another letter case; nothing is written", async () => {
    const { dir, store } = await vault({ "People/Annie.md": "---\nrole: Cook\n---\nAnnie.\n", "People/ann.md": "Another one.\n" });
    const before = await readFile(join(dir, "People/Annie.md"), "utf8");
    let caught: unknown;
    try {
      await store.update("People/Annie", { title: "Ann", exact: true });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(VaultError);
    expect((caught as VaultError).status).toBe(409);
    expect(await readFile(join(dir, "People/Annie.md"), "utf8")).toBe(before);
    expect((await readdir(join(dir, "People"))).sort()).toEqual(["Annie.md", "ann.md"]);
    expect(store.get("People/Annie").title).toBe("Annie");
  });

  it("#hazfav7a: without `exact` the same rename is refused too (every title change is exact now), never \"Ann 2\"", async () => {
    const { dir, store } = await vault({ "People/Annie.md": "Annie.\n", "People/ann.md": "Another one.\n" });
    await expect(store.update("People/Annie", { title: "Ann" })).rejects.toMatchObject({ status: 409, reason: "name-taken" });
    expect(existsSync(join(dir, "People/Ann 2.md"))).toBe(false);
  });

  it("renames as usual when the name is free, links following", async () => {
    const { dir, store } = await vault({ "People/Annie.md": "Annie.\n", "Notes.md": "Ask [[Annie]].\n" });
    const page = await store.update("People/Annie", { title: "Ann", exact: true });
    expect(page.id).toBe("People/Ann");
    expect(existsSync(join(dir, "People/Annie.md"))).toBe(false);
    expect(await readFile(join(dir, "Notes.md"), "utf8")).toContain("[[Ann]]");
  });
});
