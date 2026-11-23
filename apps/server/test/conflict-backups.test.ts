import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conflictBackupName, VaultStore } from "../src/vault-store";

/**
 * #reynggre (spec/file-format §3.3): Keep mine's backup in `.gumply/conflicts/`
 * keeps a readable name in any script and the disk version's exact bytes.
 */
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function store(files: Record<string, string | Buffer> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "gumply-conflicts-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body);
  const vault = new VaultStore(dir);
  await vault.init();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  return { dir, vault };
}

const later = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("conflictBackupName", () => {
  it("keeps letters and digits in any script; other runs become one -", () => {
    expect(conflictBackupName("Заметки", "page", 1)).toBe("Заметки-1.md");
    expect(conflictBackupName("Projects/План на 2026: Q1?", "page", 7)).toBe("Projects-План-на-2026-Q1-7.md");
    expect(conflictBackupName("日本語 ノート", "page", 1)).toBe("日本語-ノート-1.md");
    expect(conflictBackupName("snake_case-name", "page", 1)).toBe("snake_case-name-1.md");
  });

  it("boards and bases: the id's own extension isn't repeated", () => {
    expect(conflictBackupName("Map.canvas", "whiteboard", 5)).toBe("Map-5.canvas");
    expect(conflictBackupName("Tasks/Board.canvas", "whiteboard", 5)).toBe("Tasks-Board-5.canvas");
    expect(conflictBackupName("Tasks.base", "base", 5)).toBe("Tasks-5.base");
  });

  it("is NFC, capped at 120 characters (never splitting one), never empty or a Windows device name", () => {
    expect(conflictBackupName("Café", "page", 1)).toBe("Café-1.md");
    const long = conflictBackupName("😀".repeat(200), "page", 1);
    // Emoji aren't letters or digits: one run, one "-", trimmed, so a fallback name.
    expect(long).toBe("page-1.md");
    const longText = conflictBackupName("я".repeat(300), "page", 1);
    expect(longText).toBe(`${"я".repeat(120)}-1.md`);
    expect(conflictBackupName("???", "page", 1)).toBe("page-1.md");
    expect(conflictBackupName("CON", "page", 1)).toBe("page-CON-1.md");
    expect(conflictBackupName("aux", "page", 1)).toBe("page-aux-1.md");
    expect(conflictBackupName("lpt9", "page", 1)).toBe("page-lpt9-1.md");
    // Only the whole name is a device name: these are fine as they are.
    expect(conflictBackupName("Console", "page", 1)).toBe("Console-1.md");
    for (const name of [long, longText, conflictBackupName('a<b>c:d"e|f?g*h\\i', "page", 1)]) {
      expect(name).not.toMatch(/[<>:"/\\|?*\x00-\x1f]/);
    }
  });
});

describe("Keep mine backs up the disk version, byte for byte", () => {
  it("a page with a Russian name: Заметки-<ms>.md with the external bytes", async () => {
    const { dir, vault } = await store();
    const page = await vault.create({ title: "Заметки", content: "мой текст" });
    expect(page.id).toBe("Заметки");
    await later();
    const external = Buffer.from("---\ntitle: Заметки\n---\nчужой текст\r\n", "utf8");
    await writeFile(join(dir, "Заметки.md"), external);
    const forced = await vault.update(page.id, { content: "мой текст 2", expectedUpdated: page.updated, force: true });
    expect(forced.conflictBackup).toMatch(/^\.gumply\/conflicts\/Заметки-\d+\.md$/);
    expect(Buffer.compare(await readFile(join(dir, forced.conflictBackup!)), external)).toBe(0);
  });

  it("a page file with invalid UTF-8 and a BOM: the backup is the exact disk bytes", async () => {
    const { dir, vault } = await store();
    const page = await vault.create({ title: "Bytes", content: "mine" });
    await later();
    const external = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("theirs "), Buffer.from([0xff, 0xfe, 0xc3, 0x28]), Buffer.from("\n")]);
    await writeFile(join(dir, "Bytes.md"), external);
    const forced = await vault.update(page.id, { content: "mine 2", expectedUpdated: page.updated, force: true });
    expect(Buffer.compare(await readFile(join(dir, forced.conflictBackup!)), external)).toBe(0);
  });

  it("a board: Map-<ms>.canvas with the external bytes", async () => {
    const { dir, vault } = await store({ "Map.canvas": '{"nodes":[],"edges":[]}' });
    const loaded = vault.getBoard("Map.canvas");
    await later();
    const external = Buffer.from('{\n\t"nodes":[{"id":"x","type":"text","text":"From Obsidian","x":0,"y":0,"width":10,"height":10}],\n\t"edges":[]\n}');
    await writeFile(join(dir, "Map.canvas"), external);
    const forced = await vault.updateBoard("Map.canvas", { board: loaded.board, force: true });
    expect(forced.conflictBackup).toMatch(/^\.gumply\/conflicts\/Map-\d+\.canvas$/);
    expect(Buffer.compare(await readFile(join(dir, forced.conflictBackup!)), external)).toBe(0);
  });

  it("two backups of one page in the same millisecond don't overwrite each other", async () => {
    const { dir, vault } = await store();
    const page = await vault.create({ title: "Twice", content: "a" });
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    await later();
    await writeFile(join(dir, "Twice.md"), "first external\n");
    await vault.update(page.id, { content: "b", force: true });
    await later();
    await writeFile(join(dir, "Twice.md"), "second external\n");
    await vault.update(page.id, { content: "c", force: true });
    const names = (await readdir(join(dir, ".gumply", "conflicts"))).sort();
    expect(names).toEqual(["Twice-1700000000000-2.md", "Twice-1700000000000.md"]);
    expect(await readFile(join(dir, ".gumply", "conflicts", "Twice-1700000000000.md"), "utf8")).toBe("first external\n");
    expect(await readFile(join(dir, ".gumply", "conflicts", "Twice-1700000000000-2.md"), "utf8")).toBe("second external\n");
  });
});
