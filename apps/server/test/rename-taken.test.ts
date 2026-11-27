import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { VaultError } from "../src/errors";
import { VaultStore } from "../src/vault-store";
import { cleanupVaults, createTestServer, jsonRequest, trackStore } from "./helpers";

/**
 * #hazfav7a (found in #b9425ktw's repro): renaming a page, board or database to a name that's taken (any letter
 * case) made "X 2" and kept the title "X", leaving two items that look the same. Now every title change takes that
 * name or nothing: a 409 with reason "name-taken" before anything is written, the old name kept. Creating something
 * new with a taken name still gets "X 2", title included. A case-only rename of the same item is still allowed.
 * Synthetic vault.
 */

afterEach(cleanupVaults);

async function vault(files: Record<string, string>) {
  const server = await createTestServer();
  for (const [path, body] of Object.entries(files)) {
    await mkdir(join(server.dir, path, ".."), { recursive: true });
    await writeFile(join(server.dir, path), body, "utf8");
  }
  const store = trackStore(new VaultStore(server.dir));
  await store.init();
  const app = createApp({ vaultPath: server.dir, store });
  return { dir: server.dir, store, app };
}

async function refusal(run: () => Promise<unknown>): Promise<VaultError> {
  try {
    await run();
  } catch (error) {
    return error as VaultError;
  }
  throw new Error("not refused");
}

describe("a rename to a taken name is refused (#hazfav7a)", () => {
  it("a page: 409, reason name-taken, the file and title unchanged, no \"X 2\"", async () => {
    const { dir, store } = await vault({ "Pantry.md": "Shelves.\n", "Notes.md": "Body.\n" });
    const error = await refusal(() => store.update("Notes", { title: "Pantry" }));
    expect(error).toBeInstanceOf(VaultError);
    expect(error.status).toBe(409);
    expect(error.reason).toBe("name-taken");
    expect(error.message).toBe("“Pantry” is already used here");
    expect(await readFile(join(dir, "Notes.md"), "utf8")).toBe("Body.\n");
    expect(existsSync(join(dir, "Pantry 2.md"))).toBe(false);
    expect(store.get("Notes").title).toBe("Notes");
  });

  it("in another letter case too (\"pantry\"), as a case-insensitive file system would see it", async () => {
    const { dir, store } = await vault({ "Pantry.md": "Shelves.\n", "Notes.md": "Body.\n" });
    expect((await refusal(() => store.update("Notes", { title: "pantry" }))).reason).toBe("name-taken");
    expect((await readdir(dir)).filter((name) => name.endsWith(".md")).sort()).toEqual(["Notes.md", "Pantry.md"]);
  });

  it("a case-only rename of the same page is still allowed", async () => {
    const { dir, store } = await vault({ "pantry.md": "Shelves.\n" });
    const page = await store.update("pantry", { title: "Pantry" });
    expect(page.id).toBe("Pantry");
    expect(existsSync(join(dir, "Pantry.md"))).toBe(true);
  });

  it("a board, and a database: the same refusal", async () => {
    const { store } = await vault({ "Pantry.canvas": '{"nodes":[],"edges":[]}', "Shed.canvas": '{"nodes":[],"edges":[]}' });
    const board = await refusal(() => store.updateBoard("Shed.canvas", { title: "Pantry" }));
    expect([board.status, board.reason]).toEqual([409, "name-taken"]);
    expect(store.list().map((meta) => meta.id).sort()).toEqual(["Pantry.canvas", "Shed.canvas"]);
    const base = await store.createBase({ title: "Plants" });
    await store.createBase({ title: "Trees" });
    const refused = await refusal(() => store.updateBase(base.meta.id, { title: "Trees" }));
    expect([refused.status, refused.reason]).toEqual([409, "name-taken"]);
    expect(store.list().some((meta) => meta.id === "Trees 2.base")).toBe(false);
  });

  it("creating with a taken name still gets \"X 2\", title included", async () => {
    const { store } = await vault({ "Pantry.md": "Shelves.\n" });
    const page = await store.create({ title: "Pantry", content: "" });
    expect([page.id, page.title]).toEqual(["Pantry 2", "Pantry 2"]);
  });

  it("the API answers 409 with reason and title, for the client to say it in the user's language", async () => {
    const { app } = await vault({ "Pantry.md": "Shelves.\n", "Notes.md": "Body.\n" });
    const response = await jsonRequest(app, "PUT", `/api/pages/${encodeURIComponent("Notes")}`, { title: "Pantry" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "“Pantry” is already used here", reason: "name-taken", title: "Pantry" });
  });

  it("a move into a folder that has that name already: refused the same way (it was already refused, without the reason)", async () => {
    const { dir, store } = await vault({ "Pantry.md": "Shelves.\n", "Kitchen/Pantry.md": "Jars.\n" });
    const error = await refusal(() => store.move("Kitchen/Pantry", null));
    expect([error.status, error.reason, error.title]).toEqual([409, "name-taken", "Pantry"]);
    expect(await readFile(join(dir, "Kitchen/Pantry.md"), "utf8")).toBe("Jars.\n");
    expect(existsSync(join(dir, "Pantry 2.md"))).toBe(false);
  });

  it("a board moved into a folder that has a board of that name: the same refusal, nothing moved", async () => {
    const { dir, store } = await vault({ "Pantry.canvas": '{"nodes":[],"edges":[]}', "Kitchen/Pantry.canvas": '{"nodes":[],"edges":[]}' });
    const error = await refusal(() => store.move("Kitchen/Pantry.canvas", null));
    expect([error.status, error.reason]).toEqual([409, "name-taken"]);
    expect(existsSync(join(dir, "Kitchen/Pantry.canvas"))).toBe(true);
    expect(existsSync(join(dir, "Pantry 2.canvas"))).toBe(false);
  });
});
