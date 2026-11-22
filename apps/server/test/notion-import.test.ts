import { mkdir, readFile, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync, type Zippable } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { NOTION_IMPORT_LIMITS, NotionImports, cleanupStaleImports, readNotionZip, unsafeEntryName, zipSymlinks } from "../src/notion-import";
import { addMissingTypes } from "../src/properties";
import { cleanupVaults, createTestServer } from "./helpers";

afterEach(cleanupVaults);

const CORE_FIXTURES = fileURLToPath(new URL("../../../packages/core/test/fixtures/notion/", import.meta.url));

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    if ((await stat(path)).isDirectory()) out.push(...(await walk(path)));
    else out.push(path);
  }
  return out;
}

/** A core fixture (default: the lorem one) zipped as Notion delivers it. */
async function fixtureZip(name = "basic"): Promise<Uint8Array> {
  const base = join(CORE_FIXTURES, name);
  const files: Zippable = {};
  for (const path of await walk(base)) files[relative(base, path).split("\\").join("/")] = new Uint8Array(await readFile(path));
  return zipSync(files);
}

/** Every file in the vault (except Gumply's own `.gumply/`), as path → bytes. */
async function snapshot(dir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const path of await walk(dir)) {
    const rel = relative(dir, path).split("\\").join("/");
    if (!rel.startsWith(".gumply/")) files.set(rel, (await readFile(path)).toString("base64"));
  }
  return files;
}

describe("Notion import jobs (#znyztw3t)", () => {
  it("imports the lorem fixture: exactly the golden files, nothing else, and the pages are indexed", async () => {
    const { store, dir } = await createTestServer();
    const imports = new NotionImports(store);
    const job = await imports.settled(imports.start(await fixtureZip(), null).id);
    expect(job.state, job.error).toBe("done");
    expect(job.folder).toBe("Notion import");

    const expected = join(CORE_FIXTURES, "basic.expected");
    const golden = new Map<string, string>();
    for (const path of await walk(expected)) golden.set(relative(expected, path).split("\\").join("/"), (await readFile(path)).toString("base64"));
    expect(await snapshot(dir)).toEqual(golden);
    expect(store.list().map((meta) => meta.id)).toContain("Notion import/Private & Shared/Test page");
    // The temp folder is gone.
    expect(await readdir(join(dir, ".gumply/import")).catch(() => [])).toEqual([]);
  });

  it("re-importing makes Notion import 2 and leaves the first import byte-identical", async () => {
    const { store, dir } = await createTestServer();
    const imports = new NotionImports(store);
    const zip = await fixtureZip();
    await imports.settled(imports.start(zip, null).id);
    const before = await snapshot(dir);
    const second = await imports.settled(imports.start(zip, null).id);
    expect(second.state, second.error).toBe("done");
    expect(second.folder).toBe("Notion import 2");
    const after = await snapshot(dir);
    for (const [path, data] of before) expect(after.get(path), path).toBe(data);
    expect([...after.keys()].some((path) => path.startsWith("attachments/Notion import 2/"))).toBe(true);
  });

  it("imports into a folder the user picked", async () => {
    const { store, dir } = await createTestServer();
    await mkdir(join(dir, "Work"));
    await writeFile(join(dir, "Work/Plan.md"), "Plan\n");
    await store.rescan();
    const imports = new NotionImports(store);
    const job = await imports.settled(imports.start(await fixtureZip(), "Work").id);
    expect(job.folder).toBe("Work/Notion import");
    expect(await readFile(join(dir, "Work/Notion import/Private & Shared/Test page.md"), "utf8")).toContain(
      "![image.png](../../../attachments/Notion%20import/image.png)",
    );
  });

  it("a folder that appears between planning and the move is never merged into: the import re-plans to a new name", async () => {
    const { store, dir } = await createTestServer();
    let raced = false;
    const imports = new NotionImports(store, async (folder) => {
      if (raced) return;
      raced = true;
      await mkdir(join(dir, folder));
      await writeFile(join(dir, folder, "mine.md"), "Someone else's file\n");
    });
    const job = await imports.settled(imports.start(await fixtureZip(), null).id);
    expect(job.state, job.error).toBe("done");
    expect(job.folder).toBe("Notion import 2");
    expect(await readdir(join(dir, "Notion import"))).toEqual(["mine.md"]);
    expect(await readFile(join(dir, "Notion import/mine.md"), "utf8")).toBe("Someone else's file\n");
  });

  it("a failure before the move leaves the vault untouched and cleans up", async () => {
    const { store, dir } = await createTestServer();
    await writeFile(join(dir, "Keep.md"), "Keep\n");
    const before = await snapshot(dir);
    const imports = new NotionImports(store, async () => {
      throw new Error("disk full");
    });
    const job = await imports.settled(imports.start(await fixtureZip(), null).id);
    expect(job.state).toBe("failed");
    expect(job.error).toBe("disk full");
    expect(await snapshot(dir)).toEqual(before);
    expect(await readdir(join(dir, ".gumply/import")).catch(() => [])).toEqual([]);
  });

  it("one import at a time: a second one gets a 409 naming the running job", async () => {
    const { store } = await createTestServer();
    const imports = new NotionImports(store);
    const zip = await fixtureZip();
    const first = imports.start(zip, null);
    expect(() => imports.start(zip, null)).toThrow(new RegExp(first.id));
    await imports.settled(first.id);
    // Free again afterwards.
    await imports.settled(imports.start(zip, null).id);
  });

  it("removes job folders a restarted server left behind, after an hour", async () => {
    const { dir } = await createTestServer();
    const old = join(dir, ".gumply/import/old-job");
    const fresh = join(dir, ".gumply/import/fresh-job");
    await mkdir(old, { recursive: true });
    await mkdir(fresh, { recursive: true });
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(old, twoHoursAgo, twoHoursAgo);
    await cleanupStaleImports(dir);
    expect(await readdir(join(dir, ".gumply/import"))).toEqual(["fresh-job"]);
  });
});

describe("reading the export safely (spec §2)", () => {
  it("quotes the shared limits in its messages", async () => {
    const { formatImportLimit } = await import("@gumply/core");
    expect(formatImportLimit(NOTION_IMPORT_LIMITS.uploadBytes)).toBe("1 GB");
    expect(formatImportLimit(NOTION_IMPORT_LIMITS.totalBytes)).toBe("2 GB");
    expect(formatImportLimit(NOTION_IMPORT_LIMITS.attachmentBytes)).toBe("25 MB");
  });

  const text = (value: string) => new TextEncoder().encode(value);

  it("refuses zip-slip names, symlinks and zip bombs, and writes nothing outside the target", async () => {
    expect(unsafeEntryName("../evil.md")).toMatch(/leaves/);
    expect(unsafeEntryName("a/../../evil.md")).toMatch(/leaves/);
    expect(unsafeEntryName("/etc/passwd")).toMatch(/absolute/);
    expect(unsafeEntryName("C:/x.md")).toMatch(/absolute/);
    expect(unsafeEntryName("Root/Page.md")).toBeNull();

    const zip = zipSync({
      "Root/Page aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.md": text("# Page\n\nHello"),
      "../evil.md": text("escape"),
      "Root/link": [text("/etc/passwd"), { os: 3, attrs: 0o120777 << 16 }],
      // 3 MB of zeros compress to a few KB: far beyond 200:1.
      "Root/bomb.bin": new Uint8Array(3 * 1024 * 1024),
    });
    expect(zipSymlinks(zip)).toEqual(new Set(["Root/link"]));
    const { entries, skipped } = readNotionZip(zip);
    expect(entries.map((entry) => entry.path)).toEqual(["Root/Page aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.md"]);
    expect(skipped.map((item) => item.path).sort()).toEqual(["../evil.md", "Root/bomb.bin", "Root/link"]);

    const { store, dir } = await createTestServer();
    const imports = new NotionImports(store);
    const job = await imports.settled(imports.start(zip, null).id);
    expect(job.state, job.error).toBe("done");
    expect(job.report?.skipped).toHaveLength(3);
    expect([...(await snapshot(dir)).keys()].sort()).toEqual(["Notion import/Import report.md", "Notion import/Root/Page.md"]);
  });

  it("enforces the entry-count, total-size and attachment limits", () => {
    const files: Zippable = {};
    for (let i = 0; i < 5; i += 1) files[`Root/p${i}.md`] = text("x");
    expect(() => readNotionZip(zipSync(files), { ...NOTION_IMPORT_LIMITS, entries: 3 })).toThrow(/more than 3 files/);
    expect(() => readNotionZip(zipSync(files), { ...NOTION_IMPORT_LIMITS, totalBytes: 3 })).toThrow(/larger than 3 bytes once unpacked/);
    const big = zipSync({ "Root/huge.png": crypto.getRandomValues(new Uint8Array(4096)) });
    const { skipped } = readNotionZip(big, { ...NOTION_IMPORT_LIMITS, attachmentBytes: 1000 });
    expect(skipped).toEqual([{ path: "Root/huge.png", reason: "larger than 1000 bytes", code: "tooLarge", params: { limit: "1000 bytes" } }]);
  });
});

describe("POST /api/import/notion + GET /api/import/:job", () => {
  it("accepts the zip, reports progress, and finishes with the report", async () => {
    const { app } = await createTestServer();
    const form = new FormData();
    form.set("file", new File([await fixtureZip()], "export.zip", { type: "application/zip" }));
    const started = await app.request("/api/import/notion", { method: "POST", body: form });
    expect(started.status).toBe(202);
    const { id } = (await started.json()) as { id: string };
    let job: { state: string; report?: { pages: number; databases: number; rows: number } } = { state: "reading" };
    for (let i = 0; i < 200 && job.state !== "done" && job.state !== "failed"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      job = (await (await app.request(`/api/import/${id}`)).json()) as typeof job;
    }
    expect(job.state).toBe("done");
    expect(job.report).toMatchObject({ pages: 1, databases: 3, rows: 7 });
    expect((await app.request("/api/import/no-such-job")).status).toBe(404);
    expect((await app.request("/api/import/notion", { method: "POST", body: new FormData() })).status).toBe(400);
  });
});

describe("Notion databases: property types (B3, #cwi22mc6)", () => {
  it("types.json: only new keys are added, every existing byte stays (D37)", () => {
    // Obsidian's own layout, with another top-level key.
    const obsidian = '{\n  "types": {\n    "Price": "number",\n    "aliases": "aliases"\n  },\n  "other": true\n}';
    expect(addMissingTypes(obsidian, { Price: "text", Due: "date", Done: "checkbox" })).toBe(
      '{\n  "types": {\n    "Price": "number",\n    "aliases": "aliases",\n    "Due": "date",\n    "Done": "checkbox"\n  },\n  "other": true\n}',
    );
    // Tabs and a final newline.
    expect(addMissingTypes('{\n\t"types": {\n\t\t"a": "text"\n\t}\n}\n', { b: "number" })).toBe('{\n\t"types": {\n\t\t"a": "text",\n\t\t"b": "number"\n\t}\n}\n');
    // One line, compact.
    expect(addMissingTypes('{"types":{"a":"text"}}', { b: "date" })).toBe('{"types":{"a":"text","b":"date"}}');
    // An empty `types`, and none at all.
    expect(addMissingTypes('{\n  "types": {}\n}\n', { b: "date" })).toBe('{\n  "types": {\n    "b": "date"\n  }\n}\n');
    expect(addMissingTypes('{\n  "other": 1\n}\n', { b: "date" })).toBe('{\n  "other": 1,\n  "types": {\n    "b": "date"\n  }\n}\n');
    // Strings that look like keys don't confuse it.
    expect(addMissingTypes('{\n  "note": "types: {",\n  "types": {\n    "x}": "text"\n  }\n}', { y: "number" })).toBe(
      '{\n  "note": "types: {",\n  "types": {\n    "x}": "text",\n    "y": "number"\n  }\n}',
    );
    // A key that differs only in case is the same Obsidian property: never a second entry (B5).
    expect(addMissingTypes('{"types":{"due":"text"}}', { Due: "date" })).toBeNull();
    expect(addMissingTypes('{"types":{"due":"text"}}', { Due: "date", Size: "number" })).toBe('{"types":{"due":"text","Size":"number"}}');
    // Nothing new: no write. No file: a fresh one in the standard format.
    expect(addMissingTypes('{"types":{"a":"text"}}', { a: "number" })).toBeNull();
    expect(addMissingTypes(null, { a: "number" })).toBe('{\n  "types": {\n    "a": "number"\n  }\n}\n');
    expect(() => addMissingTypes("{ broken", { a: "number" })).toThrow();
  });

  it("an import adds its keys to Obsidian's types.json and keeps the vault's own types; a re-import adds nothing", async () => {
    const { store, dir } = await createTestServer();
    await mkdir(join(dir, ".obsidian"), { recursive: true });
    const original = '{\n  "types": {\n    "Price": "number"\n  }\n}\n';
    await writeFile(join(dir, ".obsidian/types.json"), original);
    const imports = new NotionImports(store);
    const zip = await fixtureZip("databases");
    const job = await imports.settled(imports.start(zip, null).id);
    expect(job.state, job.error).toBe("done");
    const after = await readFile(join(dir, ".obsidian/types.json"), "utf8");
    expect(after.startsWith('{\n  "types": {\n    "Price": "number",\n')).toBe(true);
    expect(JSON.parse(after).types).toEqual({
      Price: "number",
      Due: "date",
      "Priority 1 5": "number",
      Done: "checkbox",
      Owner: "multitext",
      Estimate: "datetime",
      "created-notion": "datetime",
    });
    expect(job.report?.keptTypes).toEqual([{ key: "Price", type: "number", found: "text" }]);

    // The rows have typed properties; the .base is next to the page that held the database.
    const properties = await store.listProperties();
    expect(properties.find((info) => info.key === "Due")?.type).toBe("date");
    expect(await readFile(join(dir, "Notion import/Private & Shared/Projects/Tasks.base"), "utf8")).toContain("type: kanban");

    const second = await imports.settled(imports.start(zip, null).id);
    expect(second.state, second.error).toBe("done");
    expect(await readFile(join(dir, ".obsidian/types.json"), "utf8")).toBe(after);
  });

  it("names are matched case-insensitively, as Obsidian does: a vault `due: text` keeps its type for Notion's `Due` dates (B5)", async () => {
    const { store, dir } = await createTestServer();
    await mkdir(join(dir, ".obsidian"), { recursive: true });
    const original = '{\n  "types": {\n    "due": "text"\n  }\n}\n';
    await writeFile(join(dir, ".obsidian/types.json"), original);
    const imports = new NotionImports(store);
    const job = await imports.settled(imports.start(await fixtureZip("databases"), null).id);
    expect(job.state, job.error).toBe("done");
    const after = await readFile(join(dir, ".obsidian/types.json"), "utf8");
    // The existing bytes stay; other keys are added after them; no `Due` beside `due`.
    expect(after.startsWith('{\n  "types": {\n    "due": "text",\n')).toBe(true);
    expect(Object.keys(JSON.parse(after).types).filter((key) => key.toLowerCase().startsWith("due"))).toEqual(["due"]);
    expect(job.report?.keptTypes).toContainEqual({ key: "Due", type: "text", found: "date" });
    // Within the database, the `due` column next to `Due` became its own key.
    expect(job.report?.renamedKeys).toContainEqual({ database: "Tasks", from: "due", to: "due 2" });
  });
});

describe("Import report.md in the app's language (#n86gnptg)", () => {
  it("an import started in Russian writes the Russian report (the per-language golden); English otherwise", async () => {
    const { store, dir } = await createTestServer();
    const imports = new NotionImports(store);
    const zip = await fixtureZip();
    const ru = await imports.settled(imports.start(zip, null, "ru").id);
    expect(ru.state, ru.error).toBe("done");
    expect(await readFile(join(dir, "Notion import/Import report.md"), "utf8")).toBe(await readFile(join(CORE_FIXTURES, "reports/basic.ru.md"), "utf8"));
    const en = await imports.settled(imports.start(zip, null).id);
    expect(await readFile(join(dir, `${en.folder}/Import report.md`), "utf8")).toMatch(/^# Notion import\n/);
  });

  it("zip refusals carry a code for the localised reports, and keep the English reason", () => {
    expect(unsafeEntryName("../evil.md")).toBe("a path that leaves the export");
    const { skipped } = readNotionZip(zipSync({ "a.md": new Uint8Array([1]) }), { ...NOTION_IMPORT_LIMITS, attachmentBytes: 0 });
    expect(skipped).toEqual([]);
    const big = readNotionZip(zipSync({ "x.png": new Uint8Array(10) }), { ...NOTION_IMPORT_LIMITS, attachmentBytes: 5 }).skipped;
    expect(big).toEqual([{ path: "x.png", code: "tooLarge", params: { limit: "5 bytes" }, reason: "larger than 5 bytes" }]);
  });
});

