import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readdir } from "node:fs/promises";
import { instanceIdIn, loadInstanceId, serverInstanceId, serverStateDir } from "../src/instance-id";
import { VaultStore } from "../src/vault-store";
import { RENAME_JOURNAL } from "../src/rename-journal";
import { mkdir, writeFile } from "node:fs/promises";

/** D47 (#xhdjpaev): this installation's id, kept in app data (never the vault). */
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("the installation id (D47)", () => {
  it("is created once and stays the same", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gumply-instance-"));
    dirs.push(dir);
    const first = loadInstanceId(join(dir, "app-data"));
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(loadInstanceId(join(dir, "app-data"))).toBe(first);
    expect((await readFile(join(dir, "app-data", "instance-id"), "utf8")).trim()).toBe(first);
  });

  it("the server's: GUMPLY_INSTANCE_ID wins; otherwise its own state folder per platform", async () => {
    expect(serverInstanceId({ GUMPLY_INSTANCE_ID: "test-instance-1" }).ensure()).toBe("test-instance-1");
    expect(serverStateDir({ XDG_STATE_HOME: "/state" }, "linux")).toBe(join("/state", "gumply"));
    expect(serverStateDir({ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "win32")).toBe(join("C:\\Users\\u\\AppData\\Local", "Gumply"));
    expect(serverStateDir({}, "darwin")).toMatch(/Library[\\/]Application Support[\\/]Gumply$/);
    const dir = await mkdtemp(join(tmpdir(), "gumply-instance-"));
    dirs.push(dir);
    // Lazily: peeking creates nothing; ensuring creates it once.
    expect(serverInstanceId({ XDG_STATE_HOME: dir }).peek()).toBeNull();
    expect(await readdir(dir)).toEqual([]);
    const id = serverInstanceId({ XDG_STATE_HOME: dir }).ensure();
    expect(serverInstanceId({ XDG_STATE_HOME: dir }).peek()).toBe(id);
  });

  it("a start writes nothing to app data; the first rename's journal creates the id", async () => {
    const root = await mkdtemp(join(tmpdir(), "gumply-instance-"));
    dirs.push(root);
    const vault = join(root, "vault");
    const appData = join(root, "app-data");
    await mkdir(join(vault, "L"), { recursive: true });
    await writeFile(join(vault, "Hub.md"), "The hub.\n");
    for (let i = 0; i < 3; i++) await writeFile(join(vault, "L", `N${i}.md`), "See [[Hub]].\n");
    const store = new VaultStore(vault, { instanceId: instanceIdIn(appData) });
    await store.init();
    await store.renamesResumed;
    await store.update("L/N0", { content: "An edit, no rename." });
    await expect(readdir(appData)).rejects.toThrow(); // never created
    // A rename journals: now the id exists, and the entry carries it.
    let entry: { instance?: string } | null = null;
    store.afterRenameBatch = async () => {
      entry = (JSON.parse(await readFile(join(vault, RENAME_JOURNAL), "utf8")) as { renames: Array<{ instance: string }> }).renames[0] ?? null;
    };
    await store.update("Hub", { title: "Hub 2" });
    const id = (await readFile(join(appData, "instance-id"), "utf8")).trim();
    expect(entry).toMatchObject({ instance: id });
  });
});
