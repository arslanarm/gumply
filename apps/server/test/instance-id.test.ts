import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadInstanceId, serverInstanceId, serverStateDir } from "../src/instance-id";

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
    expect(serverInstanceId({ GUMPLY_INSTANCE_ID: "test-instance-1" })).toBe("test-instance-1");
    expect(serverStateDir({ XDG_STATE_HOME: "/state" }, "linux")).toBe(join("/state", "gumply"));
    expect(serverStateDir({ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "win32")).toBe(join("C:\\Users\\u\\AppData\\Local", "Gumply"));
    expect(serverStateDir({}, "darwin")).toMatch(/Library[\\/]Application Support[\\/]Gumply$/);
    const dir = await mkdtemp(join(tmpdir(), "gumply-instance-"));
    dirs.push(dir);
    const id = serverInstanceId({ XDG_STATE_HOME: dir });
    expect(serverInstanceId({ XDG_STATE_HOME: dir })).toBe(id);
  });
});
