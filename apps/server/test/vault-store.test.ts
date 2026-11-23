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
    // Verbatim, as in Obsidian (#bayuasqq).
    expect(store.get("my-note").title).toBe("my-note");
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
    expect(written).toBe(original.replace("old", updated.updated));
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
    expect(restored.restored.map((meta) => meta.id)).toEqual(["A", "A/Child"]);
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

// A ceiling, not a wait: it returns as soon as the predicate holds. 4 s was
// too tight for the watcher under parallel load (#9a393rp5).
async function waitFor(predicate: () => boolean, timeout = 15_000): Promise<void> {
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

describe("D20 follow-ups (#73xpk354)", () => {
  async function storeWith(files: Record<string, string>): Promise<{ dir: string; store: VaultStore }> {
    const fs = await import("node:fs/promises");
    const dir = await tempVault(async (root) => {
      for (const [path, text] of Object.entries(files)) {
        await fs.mkdir(join(root, path, ".."), { recursive: true });
        await writeFile(join(root, path), text, "utf8");
      }
    });
    const store = new VaultStore(dir);
    await store.init();
    return { dir, store };
  }

  it("a note without frontmatter stays without it and keeps its file name", async () => {
    const { dir, store } = await storeWith({ "plain-note.md": "Just text.\n" });
    const page = await store.update("plain-note", { content: "Just text, edited." });
    expect(page.id).toBe("plain-note");
    await expect(readFile(join(dir, "plain-note.md"), "utf8")).resolves.toBe(
      "Just text, edited.\n",
    );
    // Its version is the file time, so the next conditional save works.
    const again = await store.update("plain-note", {
      content: "Third.",
      expectedUpdated: page.updated,
    });
    await expect(readFile(join(dir, "plain-note.md"), "utf8")).resolves.toBe("Third.\n");
    expect(again.updated >= page.updated).toBe(true);
  });

  it("a plain note gains frontmatter only for an icon, tags or a title the name can't hold", async () => {
    const { dir, store } = await storeWith({ "Shopping.md": "Milk\n" });

    // A title the file name can express: renamed, still plain.
    const renamed = await store.update("Shopping", { title: "Shopping list" });
    expect(renamed.id).toBe("Shopping list");
    await expect(readFile(join(dir, "Shopping list.md"), "utf8")).resolves.toBe("Milk\n");

    // An icon needs a block.
    await store.update("Shopping list", { icon: "🛒" });
    const withIcon = await readFile(join(dir, "Shopping list.md"), "utf8");
    expect(withIcon).toMatch(/^---\ntitle: Shopping list\nicon: 🛒\n/);
    expect(withIcon).toContain("Milk");

    // A title with characters the file name drops needs a `title:` key.
    const { dir: dir2, store: store2 } = await storeWith({ "Plan.md": "Body\n" });
    const odd = await store2.update("Plan", { title: "Plan: Q1?" });
    expect(odd.id).toBe("Plan Q1");
    await expect(readFile(join(dir2, "Plan Q1.md"), "utf8")).resolves.toContain(
      'title: "Plan: Q1?"',
    );
  });

  it("link rewrites keep plain notes plain", async () => {
    const { dir, store } = await storeWith({
      "Target.md": "---\ntitle: Target\n---\nT\n",
      "links-here.md": "See [[Target]].\n",
    });
    await store.update("Target", { title: "Goal" });
    await expect(readFile(join(dir, "links-here.md"), "utf8")).resolves.toBe("See [[Goal]].\n");
  });

  it("keeps the layout after `---` (no blank line added to a tight file)", async () => {
    const tight = "---\ntitle: Tight\nupdated: 2026-01-01T00:00:00.000Z\n---\nBody\n";
    const { dir, store } = await storeWith({ "Tight.md": tight });
    await store.update("Tight", { content: "Body 2" });
    await expect(readFile(join(dir, "Tight.md"), "utf8")).resolves.toMatch(
      /^---\ntitle: Tight\nupdated: .*\n---\nBody 2\n$/,
    );
  });

  it("a body save never renames a slug-named file; a title change does", async () => {
    const { dir, store } = await storeWith({ "untitled-7.md": "---\ntitle: Notes\n---\n\nA\n" });
    const saved = await store.update("untitled-7", { content: "B" });
    expect(saved.id).toBe("untitled-7");
    const renamed = await store.update("untitled-7", { title: "Notes 2026" });
    expect(renamed.id).toBe("Notes 2026");
    await expect(readFile(join(dir, "Notes 2026.md"), "utf8")).resolves.toContain("B");
  });

  it("duplicate titles are compared case-insensitively and use ' 2' suffixes", async () => {
    const { store } = await storeWith({ "Alpha.md": "---\ntitle: Alpha\n---\nA\n" });
    expect((await store.create({ title: "alpha" })).id).toBe("alpha 2");
    expect((await store.create({ title: "Alpha" })).id).toBe("Alpha 3");
    // Case-only rename keeps the file (no suffix).
    const page = await store.create({ title: "Beta" });
    expect((await store.update(page.id, { title: "BETA" })).id).toBe("BETA");
  });

  it("renaming a page with sub-pages never merges into an existing folder", async () => {
    const { dir, store } = await storeWith({
      "Projects.md": "---\ntitle: Projects\n---\nP\n",
      "Projects/Roadmap.md": "---\ntitle: Roadmap\n---\nR\n",
      // A folder without its own page (no Work.md).
      "Work/Loose.md": "---\ntitle: Loose\n---\nL\n",
    });
    const renamed = await store.update("Projects", { title: "Work" });
    expect(renamed.id).toBe("Work 2");
    expect(store.get("Work 2/Roadmap").content).toContain("R");
    await expect(readFile(join(dir, "Work", "Loose.md"), "utf8")).resolves.toContain("L");
  });

  describe("syncFilenames", () => {
    it("dry run matches apply, and a second run is a no-op", async () => {
      const { dir, store } = await storeWith({
        "dup-a.md": "---\ntitle: Dup\n---\nA\n",
        "dup-b.md": "---\ntitle: Dup\n---\nB\n",
        "Alpha.md": "---\ntitle: Alpha\n---\nA\n",
        "Alpha 2.md": "---\ntitle: Alpha\n---\nA2\n",
      });
      const dry = await store.syncFilenames(false);
      expect(dry).toEqual([
        { from: "dup-a", to: "Dup" },
        { from: "dup-b", to: "Dup 2" },
      ]);
      expect(await store.syncFilenames(true)).toEqual(dry);
      expect((await readdir(dir)).sort()).toEqual(["Alpha 2.md", "Alpha.md", "Dup 2.md", "Dup.md"]);

      expect(await store.syncFilenames(false)).toEqual([]);
      expect(await store.syncFilenames(true)).toEqual([]);

      // Also stable for a fresh process reading the result.
      const reopened = new VaultStore(dir);
      await reopened.init();
      expect(await reopened.syncFilenames(false)).toEqual([]);
      reopened.stopWatching();
    });

    it("never renames notes without an explicit title", async () => {
      const { dir, store } = await storeWith({
        "plain-note.md": "Linked from Obsidian as [[plain-note]].\n",
        "meeting-notes.md": "---\ntags: [work]\n---\nNo title key.\n",
      });
      expect(await store.syncFilenames(true)).toEqual([]);
      expect((await readdir(dir)).sort()).toEqual(["meeting-notes.md", "plain-note.md"]);
    });

    it("moves sub-pages with their parent and handles folders without a page", async () => {
      const { dir, store } = await storeWith({
        "old-plan.md": "---\ntitle: Old Plan\n---\nP\n",
        "old-plan/child-page.md": "---\ntitle: Child Page\n---\nC\n",
        "Archive/old-note.md": "---\ntitle: Old note\n---\nN\n",
      });
      const dry = await store.syncFilenames(false);
      expect(dry).toEqual([
        { from: "old-plan", to: "Old Plan" },
        { from: "Archive/old-note", to: "Archive/Old note" },
        { from: "old-plan/child-page", to: "Old Plan/Child Page" },
      ]);
      expect(await store.syncFilenames(true)).toEqual(dry);
      expect(store.list().map((page) => page.id).sort()).toEqual([
        "Archive",
        "Archive/Old note",
        "Old Plan",
        "Old Plan/Child Page",
      ]);
      await expect(readFile(join(dir, "Old Plan", "Child Page.md"), "utf8")).resolves.toContain("C");
      expect(await store.syncFilenames(false)).toEqual([]);
    });
  });
});

describe("D20 redirects", () => {
  it("a page that takes a previously redirected id is served, not the redirect", async () => {
    const dir = await tempVault();
    const store = new VaultStore(dir);
    await store.init();
    const a = await store.create({ title: "Gamma" });
    await store.update(a.id, { title: "Gamma two" });
    expect(store.get("Gamma").id).toBe("Gamma two");

    // A new page renamed onto "Gamma" owns that id again.
    const b = await store.create({ title: "Draft" });
    await store.update(b.id, { title: "Gamma" });
    expect(store.get("Gamma").id).toBe("Gamma");
    expect(store.get("Draft").id).toBe("Gamma");
    expect(store.get("Gamma two").id).toBe("Gamma two");
  });
});

describe("D23: attachment links follow the note's folder (#gma39xw2)", () => {
  async function vaultWith(files: Record<string, string>): Promise<{ dir: string; store: VaultStore }> {
    const fs = await import("node:fs/promises");
    const dir = await tempVault(async (root) => {
      for (const [path, text] of Object.entries(files)) {
        await fs.mkdir(join(root, path, ".."), { recursive: true });
        await writeFile(join(root, path), text, "utf8");
      }
    });
    const store = new VaultStore(dir);
    await store.init();
    return { dir, store };
  }

  const PIC = { "attachments/pic.png": "png", "attachments/my doc.pdf": "pdf" };

  it("Move to… rewrites the moved page's links, and its sub-pages'", async () => {
    const { dir, store } = await vaultWith({
      ...PIC,
      "Inbox.md": "---\ntitle: Inbox\n---\nI\n",
      "Projects.md": "---\ntitle: Projects\n---\nP\n",
      "Projects/Plan.md":
        "---\ntitle: Plan\n---\n![pic](../attachments/pic.png) [doc](../attachments/my%20doc.pdf \"Doc\") ![[pic.png]] `![x](../attachments/pic.png)`\n",
      "Projects/Plan/Step.md": "---\ntitle: Step\n---\n![s](../../attachments/pic.png)\n",
    });

    // Deeper: Projects/Plan → Inbox/Plan … same depth, links unchanged.
    await store.move("Projects/Plan", "Inbox");
    expect(store.get("Inbox/Plan").content).toContain("](../attachments/pic.png)");

    // To the top level: one level up.
    await store.move("Inbox/Plan", null);
    const plan = await readFile(join(dir, "Plan.md"), "utf8");
    expect(plan).toContain("![pic](attachments/pic.png)");
    expect(plan).toContain('[doc](attachments/my%20doc.pdf "Doc")');
    expect(plan).toContain("![[pic.png]]");
    // Code is never touched.
    expect(plan).toContain("`![x](../attachments/pic.png)`");
    await expect(readFile(join(dir, "Plan", "Step.md"), "utf8")).resolves.toContain(
      "![s](../attachments/pic.png)",
    );
    expect(store.get("Plan/Step").content).toContain("](../attachments/pic.png)");

    // And down two levels.
    await store.move("Plan", "Projects");
    await expect(readFile(join(dir, "Projects", "Plan", "Step.md"), "utf8")).resolves.toContain(
      "![s](../../attachments/pic.png)",
    );
  });

  it("keeps a plain note plain while relinking it", async () => {
    const { dir, store } = await vaultWith({
      ...PIC,
      "Projects.md": "---\ntitle: Projects\n---\nP\n",
      "Projects/Sketch.md": "![p](../attachments/pic.png)\n",
    });
    await store.move("Projects/Sketch", null);
    await expect(readFile(join(dir, "Sketch.md"), "utf8")).resolves.toBe(
      "![p](attachments/pic.png)\n",
    );
  });

  it("renaming a parent reports relinked sub-pages as rewritten", async () => {
    const { store } = await vaultWith({
      ...PIC,
      "Projects.md": "---\ntitle: Projects\n---\nP\n",
      // Legacy vault-root link from before D23: resolved, then made relative.
      "Projects/Plan.md": "---\ntitle: Plan\n---\n![pic](attachments/pic.png)\n",
    });
    const renamed = await store.update("Projects", { title: "Work" });
    expect(renamed.id).toBe("Work");
    expect(renamed.rewrittenPages).toContain("Work/Plan");
    expect(store.get("Work/Plan").content).toContain("![pic](../attachments/pic.png)");
  });

  it("relinks a file moved outside Gumply, keeping links the other tool fixed", async () => {
    const { dir, store } = await vaultWith({
      ...PIC,
      "Note.md": "---\ntitle: Note\n---\n![a](attachments/pic.png)\n",
      "Fixed.md": "---\ntitle: Fixed\n---\n![b](attachments/pic.png)\n",
      "Archive/Keep.md": "---\ntitle: Keep\n---\nK\n",
    });
    store.startWatching();
    try {
      const fs = await import("node:fs/promises");
      await fs.rename(join(dir, "Note.md"), join(dir, "Archive", "Note.md"));
      await waitFor(() => store.list().some((page) => page.id === "Archive/Note"));
      await waitFor(() => store.get("Archive/Note").content.includes("../attachments/pic.png"));
      await expect(readFile(join(dir, "Archive", "Note.md"), "utf8")).resolves.toContain(
        "![a](../attachments/pic.png)",
      );

      // Another tool moved and fixed the link already: leave the file alone.
      const fixed = "---\ntitle: Fixed\n---\n![b](../attachments/pic.png)\n";
      await fs.rm(join(dir, "Fixed.md"));
      await writeFile(join(dir, "Archive", "Fixed.md"), fixed, "utf8");
      await waitFor(() => store.list().some((page) => page.id === "Archive/Fixed"));
      await new Promise((resolve) => setTimeout(resolve, 300));
      await expect(readFile(join(dir, "Archive", "Fixed.md"), "utf8")).resolves.toBe(fixed);
    } finally {
      store.stopWatching();
    }
  });
});

describe("watcher after the app's own atomic saves (#3ugdxhzu, Node 20/22)", () => {
  it("still sees an outside edit to a page Gumply saved, in a folder created later, and to a board", async () => {
    const dir = await tempVault();
    const store = new VaultStore(dir);
    await store.init();
    store.startWatching();
    try {
      const page = await store.create({ title: "P" });
      // An app save replaces the file atomically (temp file + rename).
      await store.update(page.id, { content: "Base edited by app" });
      await new Promise((resolve) => setTimeout(resolve, 200));
      await writeFile(join(dir, "P.md"), `${await readFile(join(dir, "P.md"), "utf8")}\nOutside line\n`);
      await waitFor(() => store.get(page.id).content.includes("Outside line"));

      // A folder that appears after the watcher started is watched too.
      const parent = await store.create({ title: "Projects" });
      const child = await store.create({ title: "Plan", parentId: parent.id });
      await store.update(child.id, { content: "Saved by the app" });
      await new Promise((resolve) => setTimeout(resolve, 200));
      await writeFile(join(dir, "Projects", "Plan.md"), "---\ntitle: Plan\n---\nChanged in Obsidian\n");
      await waitFor(() => store.get(child.id).content.includes("Changed in Obsidian"));

      // Boards are saved atomically as well.
      const board = await store.createBoard({ title: "Map" });
      await store.updateBoard(board.meta.id, { board: { nodes: [], edges: [] } });
      await new Promise((resolve) => setTimeout(resolve, 200));
      await writeFile(join(dir, "Map.canvas"), JSON.stringify({ nodes: [{ id: "a", type: "text", text: "From outside", x: 0, y: 0, width: 100, height: 50 }], edges: [] }));
      await waitFor(() => store.search("From outside").length === 1);
    } finally {
      // Drain before afterEach deletes the vault: an outside change's history
      // version can still be on its way (ENOTEMPTY on .gumply/history, #9a393rp5).
      // A rescan joins the serial write queue, so it returns after what's pending.
      store.stopWatching();
      await store.flushHistory();
      await store.rescan();
    }
  });
});
