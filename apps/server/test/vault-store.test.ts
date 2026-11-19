import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VaultStore } from "../src/vault-store";

const dirs: string[] = [];

async function tempVault(seed?: (dir: string) => Promise<void>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gumply-store-"));
  dirs.push(dir);
  if (seed) await seed(dir);
  return dir;
}

afterEach(async () => {
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

  it("ignores .trash on start and restores entries after a restart", async () => {
    const dir = await tempVault();
    const store = new VaultStore(dir);
    await store.init();
    await store.create({ title: "A", content: "keep me" });
    await store.create({ title: "Child", parentId: "a" });

    const result = await store.remove("a");
    expect(store.list()).toEqual([]);

    // A new process only sees the vault: .trash must stay invisible…
    const reopened = new VaultStore(dir);
    await reopened.init();
    expect(reopened.list()).toEqual([]);
    expect(reopened.search("keep me")).toEqual([]);
    expect(reopened.graph().nodes).toEqual([]);

    // …but its entries remain restorable from disk.
    const restored = await reopened.restore(result.trashId);
    expect(restored.map((meta) => meta.id)).toEqual(["a", "a/child"]);
    expect(reopened.get("a").content).toBe("keep me");
    expect(reopened.get("a").childCount).toBe(1);
  });
});
