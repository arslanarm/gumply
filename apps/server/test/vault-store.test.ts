import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VaultStore } from "../src/vault-store";

const dirs: string[] = [];

async function tempVault(seed?: (dir: string) => Promise<void>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gumply-store-"));
  dirs.push(dir);
  if (seed) await seed(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("VaultStore index on start", () => {
  it("scans existing Markdown, frontmatter and inline tags", async () => {
    const dir = await tempVault(async (root) => {
      await writeFile(
        join(root, "hand-written.md"),
        ["---", "title: Hand Written", "icon: ✍️", "tags:", "  - imported", "---", "", "Body #inline and [[Other]]"].join("\n"),
        "utf8",
      );
      await writeFile(join(root, "other.md"), "Other page", "utf8");
    });

    const store = new VaultStore(dir);
    await store.init();

    const pages = store.list();
    expect(pages.map((page) => page.id)).toEqual(["hand-written", "other"]);

    const page = store.get("hand-written");
    expect(page.title).toBe("Hand Written");
    expect(page.icon).toBe("✍️");
    expect(page.tags.sort()).toEqual(["imported", "inline"]);
    expect(store.backlinks("other")).toHaveLength(1);
  });

  it("uses the file name as the title when frontmatter has none", async () => {
    const dir = await tempVault(async (root) => {
      await writeFile(join(root, "my-note.md"), "Hello", "utf8");
    });

    const store = new VaultStore(dir);
    await store.init();
    expect(store.get("my-note").title).toBe("My note");
  });

  it("flattens parents that have no page of their own", async () => {
    const dir = await tempVault(async (root) => {
      await import("node:fs/promises").then((fs) => fs.mkdir(join(root, "folder"), { recursive: true }));
      await writeFile(join(root, "folder", "child.md"), "Child", "utf8");
      await writeFile(join(root, "folder.md"), "Folder", "utf8");
    });

    const store = new VaultStore(dir);
    await store.init();
    expect(store.get("folder/child").parentId).toBe("folder");
    expect(store.get("folder").parentId).toBeNull();
  });

  it("serialises concurrent creates without id clashes", async () => {
    const dir = await tempVault();
    const store = new VaultStore(dir);
    await store.init();

    const pages = await Promise.all(
      Array.from({ length: 8 }, (_, index) => store.create({ title: `Page ${index}` })),
    );
    expect(new Set(pages.map((page) => page.id)).size).toBe(8);
    expect(store.list()).toHaveLength(8);
  });

  it("keeps created time and bumps updated on writes", async () => {
    const dir = await tempVault();
    const store = new VaultStore(dir);
    await store.init();

    const created = await store.create({ title: "Timed" });
    const updated = await store.update(created.id, { content: "changed" });
    expect(updated.created).toBe(created.created);
    expect(new Date(updated.updated).getTime()).toBeGreaterThanOrEqual(
      new Date(created.updated).getTime(),
    );
  });

  it("preserves unknown frontmatter byte-for-byte on a body edit", async () => {
    const original = [
      "---",
      "# Obsidian-managed",
      "title: Imported",
      "aliases:",
      "  - One",
      "cssclasses: [wide, cards]   # keep flow",
      "date: 2026-01-02",
      "tags: [x, y]",
      "updated: 2026-01-01T00:00:00.000Z",
      "---",
      "",
      "Old body.",
      "",
    ].join("\n");
    const dir = await tempVault(async (root) => {
      await writeFile(join(root, "imported.md"), original, "utf8");
    });
    const store = new VaultStore(dir);
    await store.init();

    const updated = await store.update("imported", { content: "New body." });
    const written = await readFile(join(dir, `${updated.id}.md`), "utf8");
    expect(written).toBe(
      original
        .replace("Old body.", "New body.")
        .replace("2026-01-01T00:00:00.000Z", updated.updated),
    );
  });

  it("keeps unknown keys, order, comments and flow tags when the title changes", async () => {
    const original = [
      "---",
      "title: Imported",
      "aliases: [One, Two]",
      "cssclasses: [wide, cards]   # keep flow",
      "date: 2026-01-02",
      "tags: [x, y]",
      "---",
      "",
      "Body.",
      "",
    ].join("\n");
    const dir = await tempVault(async (root) => {
      await writeFile(join(root, "imported.md"), original, "utf8");
    });
    const store = new VaultStore(dir);
    await store.init();

    const updated = await store.update("imported", { title: "Renamed", content: "Body." });
    const written = await readFile(join(dir, `${updated.id}.md`), "utf8");
    expect(written).toContain("title: Renamed");
    expect(written).toContain("aliases: [One, Two]");
    expect(written).toContain("cssclasses: [wide, cards]   # keep flow");
    expect(written).toContain("date: 2026-01-02");
    expect(written).toContain("tags: [x, y]");
    expect(written.indexOf("title:")).toBeLessThan(written.indexOf("aliases:"));
    expect(written.indexOf("aliases:")).toBeLessThan(written.indexOf("date:"));
  });

  it("preserves CRLF and a missing final newline", async () => {
    const original = "---\r\ntitle: Win\r\nupdated: old\r\n---\r\nBody";
    const dir = await tempVault(async (root) => {
      await writeFile(join(root, "win.md"), original, "utf8");
    });
    const store = new VaultStore(dir);
    await store.init();

    const updated = await store.update("win", { content: "Body" });
    const written = await readFile(join(dir, `${updated.id}.md`), "utf8");
    expect(written).toBe(
      original.replace("old", updated.updated).replace("---\r\nBody", "---\r\n\r\nBody"),
    );
    expect(written.endsWith("\n")).toBe(false);
  });

  it("ignores .trash on start and restores entries after a restart", async () => {
    const dir = await tempVault();
    const store = new VaultStore(dir);
    await store.init();
    const parent = await store.create({ title: "A", content: "keep me" });
    await store.create({ title: "Child", parentId: parent.id });

    const result = await store.remove(parent.id);
    expect(store.list()).toEqual([]);

    // A new process only sees the vault: .trash must stay invisible…
    const reopened = new VaultStore(dir);
    await reopened.init();
    expect(reopened.list()).toEqual([]);
    expect(reopened.search("keep me")).toEqual([]);
    expect(reopened.graph().nodes).toEqual([]);

    // …but its entries remain restorable from disk.
    const restored = await reopened.restore(result.trashId);
    expect(restored.map((meta) => meta.id)).toEqual(["A", "A/Child"]);
    expect(reopened.get("A").content).toBe("keep me");
    expect(reopened.get("A").childCount).toBe(1);
  });

  it("renames the file with the title and moves the child folder", async () => {
    const dir = await tempVault();
    const store = new VaultStore(dir);
    await store.init();
    const parent = await store.create({ title: "Old title" });
    const child = await store.create({ title: "Child", parentId: parent.id });

    const renamed = await store.update(parent.id, { title: "Q1 plan" });
    expect(renamed.id).toBe("Q1 plan");
    expect(store.get("Q1 plan").title).toBe("Q1 plan");
    expect(store.get("Q1 plan/Child").parentId).toBe("Q1 plan");
    expect(store.get("Q1 plan/Child").id).toBe("Q1 plan/Child");
    expect(store.get(child.id).id).toBe("Q1 plan/Child");
    expect(store.get(parent.id).id).toBe("Q1 plan");

    await expect(readFile(join(dir, "Q1 plan.md"), "utf8")).resolves.toContain("title: Q1 plan");
    await expect(readFile(join(dir, "Q1 plan", "Child.md"), "utf8")).resolves.toContain(
      "title: Child",
    );
  });

  it("keeps unsafe characters out of the file name", async () => {
    const dir = await tempVault();
    const store = new VaultStore(dir);
    await store.init();
    const page = await store.create({ title: "Plan: Q1? <draft>" });
    expect(page.id).toBe("Plan Q1 draft");
    await expect(readFile(join(dir, "Plan Q1 draft.md"), "utf8")).resolves.toContain(
      'title: "Plan: Q1? <draft>"',
    );
  });

  it("migrates legacy slug file names with syncFilenames", async () => {
    const dir = await tempVault(async (root) => {
      await writeFile(join(root, "old-plan.md"), "---\ntitle: Old Plan\n---\nBody\n", "utf8");
      await import("node:fs/promises").then((fs) =>
        fs.mkdir(join(root, "old-plan"), { recursive: true }),
      );
      await writeFile(
        join(root, "old-plan", "child-page.md"),
        "---\ntitle: Child Page\n---\nBody\n",
        "utf8",
      );
    });
    const store = new VaultStore(dir);
    await store.init();

    const dry = await store.syncFilenames(false);
    expect(dry).toEqual([
      { from: "old-plan", to: "Old Plan" },
      { from: "old-plan/child-page", to: "Old Plan/Child Page" },
    ]);
    // Dry run writes nothing.
    await expect(readFile(join(dir, "old-plan.md"), "utf8")).resolves.toBeTruthy();
    await expect(readFile(join(dir, "Old Plan.md"), "utf8")).rejects.toThrow();

    const applied = await store.syncFilenames(true);
    expect(applied.map((plan) => plan.to)).toEqual(dry.map((plan) => plan.to));
    expect(applied[0]).toEqual({ from: "old-plan", to: "Old Plan" });
    const files = await readdir(dir);
    expect(files).toContain("Old Plan.md");
    expect(files).not.toContain("old-plan.md");
    expect(store.list().map((page) => page.id).sort()).toEqual([
      "Old Plan",
      "Old Plan/Child Page",
    ]);
    expect(store.get("old-plan").id).toBe("Old Plan");
  });

  it("treats a page whose file is already gone as deleted instead of throwing", async () => {
    const dir = await tempVault();
    const store = new VaultStore(dir);
    await store.init();
    const page = await store.create({ title: "Gone", content: "already removed" });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    // Simulate index/file drift: GET /pages still lists it, but the .md is gone.
    await rm(join(dir, `${page.id}.md`), { force: true });
    const result = await store.remove(page.id);

    expect(result.deleted).toEqual([page.id]);
    expect(result.trashId).toBe("");
    expect(store.list().map((meta) => meta.id)).toEqual([]);
    expect(store.search("already removed")).toEqual([]);
    expect(store.graph().nodes).toEqual([]);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("dropping stale index entry");
  });

  it("still surfaces a real filesystem error and keeps the page", async () => {
    const dir = await tempVault();
    const store = new VaultStore(dir);
    await store.init();
    const page = await store.create({ title: "Keep" });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    // A file where `.trash/` should be makes the trash mkdir fail with ENOTDIR.
    await writeFile(join(dir, ".trash"), "not a directory", "utf8");

    await expect(store.remove(page.id)).rejects.toMatchObject({ code: "ENOTDIR" });
    expect(store.list().map((meta) => meta.id)).toEqual([page.id]);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const log = String(errorSpy.mock.calls[0]?.[0]);
    expect(log).toContain(`delete ${page.id} failed`);
    expect(log).toContain("ENOTDIR");
    expect(log).toContain(`${page.id}.md`);
  });
});

async function waitFor(predicate: () => boolean, timeout = 4000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for the vault watcher");
}

describe("external vault changes", () => {
  it("watches created, changed and deleted Markdown files", async () => {
    const dir = await tempVault();
    const store = new VaultStore(dir);
    await store.init();
    store.startWatching();
    try {
      const external = join(dir, "external.md");
      await writeFile(external, "External body", "utf8");
      await waitFor(() => store.list().some((page) => page.id === "external"));
      expect(store.get("external").content).toContain("External body");

      await writeFile(external, "External changed", "utf8");
      await waitFor(() => store.get("external").content.includes("External changed"));

      await rm(external);
      await waitFor(() => !store.list().some((page) => page.id === "external"));
    } finally {
      store.stopWatching();
    }
  });

  it("rejects a stale conditional save and allows Keep mine", async () => {
    const dir = await tempVault();
    const store = new VaultStore(dir);
    await store.init();
    const page = await store.create({ title: "Conflict", content: "original" });

    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeFile(join(dir, `${page.id}.md`), "external body", "utf8");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      store.update(page.id, { content: "mine", expectedUpdated: page.updated }),
    ).rejects.toMatchObject({ status: 409 });

    await store.rescan();
    expect(store.get(page.id).content).toContain("external body");

    const forced = await store.update(page.id, {
      content: "mine",
      expectedUpdated: page.updated,
      force: true,
    });
    expect(forced.content).toBe("mine");
    expect(forced.conflictBackup).toMatch(/^\.gumply\/conflicts\//);

    const backups = await readdir(join(dir, ".gumply", "conflicts"));
    expect(backups).toHaveLength(1);
    expect(await readFile(join(dir, ".gumply", "conflicts", backups[0]!), "utf8")).toContain(
      "external body",
    );
    warnSpy.mockRestore();
  });

  it("writes atomically without leaving temporary files", async () => {
    const dir = await tempVault();
    const store = new VaultStore(dir);
    await store.init();
    const page = await store.create({ title: "Atomic", content: "one" });
    await store.update(page.id, { content: "two" });
    const files = await readdir(dir);
    expect(files.some((file) => file.endsWith(".tmp"))).toBe(false);
    expect(await readFile(join(dir, `${page.id}.md`), "utf8")).toContain("two");
  });

  it("picks up several external files in one rescan", async () => {
    const dir = await tempVault();
    const store = new VaultStore(dir);
    await store.init();
    store.startWatching();
    try {
      await Promise.all(
        ["bulk-a", "bulk-b", "bulk-c"].map((id) =>
          writeFile(join(dir, `${id}.md`), `# ${id}`, "utf8"),
        ),
      );
      await waitFor(() =>
        ["bulk-a", "bulk-b", "bulk-c"].every((id) =>
          store.list().some((page) => page.id === id),
        ),
      );
      expect(store.list().filter((page) => page.id.startsWith("bulk-"))).toHaveLength(3);
    } finally {
      store.stopWatching();
    }
  });
});
