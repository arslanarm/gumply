import { watch } from "node:fs";
import { mkdir, readdir, readFile, symlink, utimes, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { isGumplyTempName, sweepTempFiles, tempPathBeside } from "../src/temp-files";
import { VaultStore } from "../src/vault-store";
import { cleanupVaults, createTestServer, getJson, jsonRequest } from "./helpers";

/**
 * #e9hs2zgq (spec/sync-conflicts §7): atomic writes go through a hidden
 * `.~gumply-<pid>-<ms>-<n>.tmp` beside the target (Dropbox skips `.~`, file
 * managers hide dot-names), and a startup sweep removes only those, a day old.
 */

afterEach(cleanupVaults);

const DAY = 24 * 60 * 60 * 1000;

async function allFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (at: string) => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) await walk(path);
      else out.push(relative(dir, path).split(sep).join("/"));
    }
  };
  await walk(dir);
  return out.sort();
}

async function age(path: string, ms: number): Promise<void> {
  const when = new Date(Date.now() - ms);
  await utimes(path, when, when);
}

describe("temp file names (#e9hs2zgq)", () => {
  it("are hidden, beside the target, and never repeat", () => {
    const names = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const path = tempPathBeside(join("/vault", "Projects", "Note.md"));
      expect(path.startsWith(join("/vault", "Projects", ".~gumply-"))).toBe(true);
      expect(isGumplyTempName(path)).toBe(true);
      names.add(path);
    }
    expect(names.size).toBe(2000);
  });

  it("every vault write uses one, and none is left behind", async () => {
    const { app, store, dir } = await createTestServer();
    const seen: string[] = [];
    const watcher = watch(dir, { recursive: true }, (_event, name) => {
      if (name) seen.push(String(name).split(sep).pop()!);
    });
    try {
      const page = (await (await jsonRequest(app, "POST", "/api/pages", { title: "Note", content: "Hello." })).json()) as { id: string; updated: string };
      await jsonRequest(app, "PUT", `/api/pages/${encodeURIComponent(page.id)}`, { content: "Hello again.", expectedUpdated: page.updated });
      const board = (await (await jsonRequest(app, "POST", "/api/boards", { title: "Sketch" })).json()) as { meta: { id: string } };
      const loaded = store.getBoard(board.meta.id);
      await store.updateBoard(board.meta.id, {
        board: { ...loaded.board, nodes: [{ id: "a", type: "text", text: "Hi", x: 0, y: 0, width: 100, height: 40 }] } as never,
        expectedUpdated: loaded.meta.updated,
      });
      const base = (await (await jsonRequest(app, "POST", "/api/bases", { title: "Tasks", source: { folder: "" } })).json()) as { meta: { id: string; updated: string } };
      const doc = await getJson<{ config: unknown; meta: { updated: string } }>(app, `/api/bases/${encodeURIComponent(base.meta.id)}`);
      await jsonRequest(app, "PUT", `/api/bases/${encodeURIComponent(base.meta.id)}`, { config: doc.config, expectedUpdated: doc.meta.updated });
      expect((await jsonRequest(app, "PUT", "/api/properties/due", { type: "date" })).status).toBe(200);
      expect((await jsonRequest(app, "PUT", "/api/graph/settings", { groups: [{ query: "a", color: "#00aa55" }] })).status).toBe(200);
      expect((await jsonRequest(app, "PUT", "/api/mcp/settings", { access: "append" })).status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 150));
    } finally {
      watcher.close();
    }

    const temps = seen.filter((name) => name.endsWith(".tmp"));
    // Seen while writing: only the new, hidden form; never `<file>.<pid>.<ms>.tmp`.
    expect(temps.length).toBeGreaterThan(0);
    expect(temps.filter((name) => !isGumplyTempName(name))).toEqual([]);
    // And nothing left behind.
    expect((await allFiles(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("a temp file a crash left behind (#e9hs2zgq)", () => {
  it("is invisible: not a page, not a linkable file, no rescan", async () => {
    const { app, store, dir } = await createTestServer();
    await writeFile(join(dir, "Note.md"), "Hello.\n", "utf8");
    await store.rescan();
    let rescans = 0;
    const internal = store as unknown as { scheduleRescan: () => void };
    const original = internal.scheduleRescan.bind(store);
    internal.scheduleRescan = () => {
      rescans += 1;
      original();
    };
    store.startWatching();
    try {
      await writeFile(join(dir, ".~gumply-123-1700000000000-1.tmp"), "Hello, half written", "utf8");
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(rescans).toBe(0);
    } finally {
      store.stopWatching();
    }
    await store.rescan();
    expect(store.list().map((page) => page.id)).toEqual(["Note"]);
    const linkable = await getJson<unknown[]>(app, "/api/files/linkable");
    expect(JSON.stringify(linkable)).not.toContain(".~gumply");
  });

  it("is swept after a day, not before; other tools' files and other names never", async () => {
    const { dir } = await createTestServer();
    const ours = [".~gumply-1-2-3.tmp", "Projects/.~gumply-4-5-6.tmp", ".gumply/history/Note/.~gumply-7-8-9.tmp", ".gumply/.~gumply-1-1-1.tmp", ".obsidian/.~gumply-2-2-2.tmp"];
    const theirs = [
      ".~other.tmp",
      ".~gumply-notes.tmp",
      ".~gumply-1-2.tmp",
      ".~gumply-1-2-3.tmp.md",
      "~$report.tmp",
      ".syncthing.Note.md.tmp",
      "~syncthing~Note.md.tmp",
      "Note.md.123.1700000000000.tmp",
      ".trash/abc/.~gumply-9-9-9.tmp",
      ".obsidian/plugins/x/.~gumply-3-3-3.tmp",
      "node_modules/.~gumply-4-4-4.tmp",
      "Note.md",
    ];
    for (const name of [...ours, ...theirs]) {
      await mkdir(join(dir, name, ".."), { recursive: true });
      await writeFile(join(dir, name), "x", "utf8");
      await age(join(dir, name), 2 * DAY);
    }
    // A directory and a symlink with our name are never removed.
    await mkdir(join(dir, "Dir/.~gumply-5-5-5.tmp"), { recursive: true });
    await symlink(join(dir, "Note.md"), join(dir, ".~gumply-6-6-6.tmp"));
    // Ours, but only 23 hours old.
    await writeFile(join(dir, "Projects/.~gumply-7-7-7.tmp"), "x", "utf8");
    await age(join(dir, "Projects/.~gumply-7-7-7.tmp"), 23 * 60 * 60 * 1000);

    const removed = (await sweepTempFiles(dir)).map((path) => relative(dir, path).split(sep).join("/")).sort();
    expect(removed).toEqual([...ours].sort());
    const left = await allFiles(dir);
    for (const name of theirs) expect(left).toContain(name);
    expect(left).toContain("Projects/.~gumply-7-7-7.tmp");
    expect(left).toContain(".~gumply-6-6-6.tmp");
    expect(await readFile(join(dir, "Note.md"), "utf8")).toBe("x");
  });

  it("is swept when a vault opens", async () => {
    const { dir } = await createTestServer();
    await writeFile(join(dir, ".~gumply-1-2-3.tmp"), "x", "utf8");
    await age(join(dir, ".~gumply-1-2-3.tmp"), 2 * DAY);
    const store = new VaultStore(dir);
    await store.init();
    expect((await store.tempSweep).map((path) => relative(dir, path))).toEqual([".~gumply-1-2-3.tmp"]);
    expect(await allFiles(dir)).not.toContain(".~gumply-1-2-3.tmp");
    createApp({ vaultPath: dir, store });
  });
});
