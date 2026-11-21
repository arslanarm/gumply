import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PageMeta } from "@gumply/core";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupVaults, createPage, createTestServer, encodeId, getJson, jsonRequest } from "./helpers";

/** v0.7 C (#5hrsrqsj): page templates and daily notes, Obsidian-compatible. */

afterEach(cleanupVaults);

async function write(dir: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), text, "utf8");
  }
}

const daily = (app: Parameters<typeof jsonRequest>[0], date: string) => jsonRequest(app, "POST", "/api/daily", { date });

describe("daily notes", () => {
  it("defaults: Daily/YYYY-MM-DD, a plain empty note, the same note on the second ask", async () => {
    const { app, dir } = await createTestServer();
    expect(await getJson(app, "/api/daily/settings")).toEqual({ folder: "Daily", format: "YYYY-MM-DD", template: "" });
    const first = await daily(app, "2026-03-06");
    expect(first.status).toBe(201);
    expect((await first.json()) as { page: PageMeta }).toMatchObject({ created: true, page: { id: "Daily/2026-03-06", parentId: "Daily" } });
    expect(await readFile(join(dir, "Daily/2026-03-06.md"), "utf8")).toBe("");
    const again = await daily(app, "2026-03-06");
    expect(again.status).toBe(200);
    expect((await again.json()) as { created: boolean }).toMatchObject({ created: false, page: { id: "Daily/2026-03-06" } });
    // The folder is a D33 plain folder; nothing else was written.
    const list = await getJson<PageMeta[]>(app, "/api/pages");
    expect(list.find((meta) => meta.id === "Daily")?.kind).toBe("folder");
    expect((await readdir(dir)).filter((name) => !name.startsWith(".")).sort()).toEqual(["Daily"]);
  });

  it("follows Obsidian's settings and daily template, and never writes into .obsidian", async () => {
    const { app, dir, store } = await createTestServer();
    await write(dir, {
      ".obsidian/daily-notes.json": JSON.stringify({ folder: "Journal", format: "YYYY/MM/DD ddd", template: "Templates/Daily.md" }),
      ".obsidian/templates.json": JSON.stringify({ folder: "Templates", dateFormat: "DD.MM.YYYY", timeFormat: "HH:mm" }),
      "Templates/Daily.md": "---\ntags: [journal]\nmood: # how was it\n---\n# {{title}}\n\nWritten on {{date}}, a {{date:dddd}}.\n",
    });
    await store.rescan();
    const before = await readdir(join(dir, ".obsidian"));
    expect(await getJson(app, "/api/daily/settings")).toEqual({ folder: "Journal", format: "YYYY/MM/DD ddd", template: "Templates/Daily" });

    const made = (await (await daily(app, "2026-03-06")).json()) as { page: PageMeta };
    expect(made.page).toMatchObject({ id: "Journal/2026/03/06 Fri", tags: ["journal"] });
    expect(await readFile(join(dir, "Journal/2026/03/06 Fri.md"), "utf8")).toBe(
      "---\ntags: [journal]\nmood: # how was it\n---\n# 06 Fri\n\nWritten on 06.03.2026, a Friday.\n",
    );
    expect(await readdir(join(dir, ".obsidian"))).toEqual(before);
    // An Obsidian settings file without a folder means the vault root.
    await writeFile(join(dir, ".obsidian/daily-notes.json"), JSON.stringify({ format: "YYYY-MM-DD" }));
    expect(((await (await daily(app, "2026-03-07")).json()) as { page: PageMeta }).page.id).toBe("2026-03-07");
  });

  it("reads .gumply settings when there's no Obsidian config; rejects bad dates", async () => {
    const { app, dir } = await createTestServer();
    await write(dir, { ".gumply/daily-notes.json": JSON.stringify({ folder: "Days", format: "D MMMM YYYY" }) });
    expect(((await (await daily(app, "2026-03-06")).json()) as { page: PageMeta }).page.id).toBe("Days/6 March 2026");
    expect((await daily(app, "2026-02-31")).status).toBe(400);
    expect((await daily(app, "today")).status).toBe(400);
  });
});

describe("page templates", () => {
  async function withTemplates() {
    const server = await createTestServer();
    await write(server.dir, {
      "Templates/Meeting.md":
        "---\n# kept comment\nstatus: draft\ncreated: {{date}}\ntags: [meeting]\n---\n\n# {{title}}\n\nAt {{time:HH}}h\n\n- [ ] Agenda\n",
      "Templates/Plain.md": "Just {{title}}\n",
      "Notes.md": "Not a template",
    });
    await server.store.rescan();
    return server;
  }

  it("lists the pages in the templates folder", async () => {
    const { app } = await withTemplates();
    const result = await getJson<{ folder: string; templates: PageMeta[] }>(app, "/api/templates");
    expect(result.folder).toBe("Templates");
    expect(result.templates.map((meta) => meta.id)).toEqual(["Templates/Meeting", "Templates/Plain"]);
  });

  it("a new page from a template keeps the template's frontmatter and fills its variables", async () => {
    const { app, dir } = await withTemplates();
    const page = await createPage(app, { title: "Weekly sync", template: "Templates/Meeting" } as never);
    expect(page).toMatchObject({ id: "Weekly sync", title: "Weekly sync", tags: ["meeting"] });
    const text = await readFile(join(dir, "Weekly sync.md"), "utf8");
    const today = new Date();
    const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    expect(text).toMatch(new RegExp(`^---\\n# kept comment\\nstatus: draft\\ncreated: ${ymd}\\ntags: \\[meeting\\]\\n`));
    expect(text).toContain("title: Weekly sync");
    expect(text).toMatch(/\n\n# Weekly sync\n\nAt \d{2}h\n\n- \[ \] Agenda\n$/);
    expect((page as { content: string }).content).toMatch(/^# Weekly sync\n\nAt \d{2}h\n\n- \[ \] Agenda$/);
  });

  it("a template without frontmatter makes a normal page; an unknown template is 404", async () => {
    const { app } = await withTemplates();
    const page = await createPage(app, { title: "Hello", template: "Templates/Plain" } as never);
    expect((page as { content: string }).content).toBe("Just Hello");
    const missing = await jsonRequest(app, "POST", "/api/pages", { title: "X", template: "Templates/Nope" });
    expect(missing.status).toBe(404);
  });

  it("applies a template to an empty page: body filled, new keys added, existing ones kept; never to a page with text", async () => {
    const { app, dir, store } = await withTemplates();
    await write(dir, { "Draft.md": "---\nstatus: final\n---\n" });
    await store.rescan();
    const response = await jsonRequest(app, "POST", `/api/pages/${encodeId("Draft")}/template`, { template: "Templates/Meeting" });
    expect(response.status).toBe(200);
    const text = await readFile(join(dir, "Draft.md"), "utf8");
    expect(text).toMatch(/^---\nstatus: final\n/);
    expect(text).toMatch(/created: \d{4}-\d{2}-\d{2}/);
    expect(text).toContain("meeting");
    expect(text).toMatch(/# Draft\n\nAt \d{2}h\n\n- \[ \] Agenda\n$/);

    const busy = await jsonRequest(app, "POST", `/api/pages/${encodeId("Notes")}/template`, { template: "Templates/Meeting" });
    expect(busy.status).toBe(409);
  });
});
