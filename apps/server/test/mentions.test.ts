import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PageMentions } from "@gumply/core";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { VaultStore } from "../src/vault-store";
import { cleanupVaults, createTestServer, encodeId, getJson, jsonRequest } from "./helpers";

/** v0.8 C1 (#sipu2nxn, spec/api-mentions): unlinked mentions, Link and Link all. */

afterEach(cleanupVaults);

async function vault(files: Record<string, string>) {
  const server = await createTestServer();
  for (const [path, body] of Object.entries(files)) {
    await mkdir(join(server.dir, path, ".."), { recursive: true });
    await writeFile(join(server.dir, path), body, "utf8");
  }
  const store = new VaultStore(server.dir);
  await store.init();
  return { dir: server.dir, store, app: createApp({ vaultPath: server.dir, store }) };
}

const files = {
  "Projects/Alpha.md": "---\naliases: [PA, Project Alpha]\n---\nThe Alpha page mentions Alpha itself.\n",
  // An Obsidian note: no frontmatter, CRLF.
  "Daily.md": "Worked on alpha today.\r\nPA review; see [[Alpha]] and `Alpha`.\r\nProject Alpha is late.\r\n",
  "Notes.md": "---\ntitle: Notes\n---\nAlphabet soup, https://x.example/Alpha, [Alpha](https://x.example).\n",
  "Other.md": "Nothing to see.\n",
};

const mentionsOf = (app: Awaited<ReturnType<typeof vault>>["app"]) => getJson<PageMentions[]>(app, `/api/pages/${encodeId("Projects/Alpha")}/mentions`);
const link = (app: Awaited<ReturnType<typeof vault>>["app"], body: unknown) =>
  jsonRequest(app, "POST", `/api/pages/${encodeId("Projects/Alpha")}/mentions/link`, body);

describe("GET /api/pages/:id/mentions", () => {
  it("lists plain-text mentions of the title and aliases, never the page itself, links, code or URLs", async () => {
    const { app } = await vault(files);
    const result = await mentionsOf(app);
    expect(result.map((entry) => entry.page.id)).toEqual(["Daily"]);
    const [daily] = result;
    expect(daily!.mentions.map((mention) => [mention.text, mention.term])).toEqual([
      ["alpha", "Alpha"],
      ["PA", "PA"],
      ["Project Alpha", "Project Alpha"],
    ]);
    const first = daily!.mentions[0]!;
    expect(first.snippet.text.slice(first.snippet.start, first.snippet.end)).toBe("alpha");
  });

  it("follows edits (the index is updated per changed page)", async () => {
    const { app, store } = await vault(files);
    expect((await mentionsOf(app)).map((entry) => entry.page.id)).toEqual(["Daily"]);
    await store.update("Other", { content: "Now Alpha is here.\n" });
    expect((await mentionsOf(app)).map((entry) => entry.page.id)).toEqual(["Daily", "Other"]);
    await store.update("Daily", { content: "No more.\n" });
    expect((await mentionsOf(app)).map((entry) => entry.page.id)).toEqual(["Other"]);
  });
});

describe("POST /api/pages/:id/mentions/link", () => {
  it("Link: one mention, only its bytes; the note keeps CRLF and gets no frontmatter", async () => {
    const { app, dir } = await vault(files);
    const notesBefore = await stat(join(dir, "Notes.md"));
    const [daily] = await mentionsOf(app);
    const pa = daily!.mentions.find((mention) => mention.text === "PA")!;
    const response = await link(app, { source: "Daily", expectedUpdated: daily!.updated, positions: [pa.index] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ linked: 1, rewrittenPages: ["Daily"] });
    expect(await readFile(join(dir, "Daily.md"), "utf8")).toBe(
      "Worked on alpha today.\r\n[[Alpha|PA]] review; see [[Alpha]] and `Alpha`.\r\nProject Alpha is late.\r\n",
    );
    // D37: nothing else written.
    expect((await stat(join(dir, "Notes.md"))).mtimeMs).toBe(notesBefore.mtimeMs);
  });

  it("Link all: every mention in that page", async () => {
    const { app, dir } = await vault(files);
    const [daily] = await mentionsOf(app);
    const response = await link(app, { source: "Daily", expectedUpdated: daily!.updated, all: true });
    expect(await response.json()).toEqual({ linked: 3, rewrittenPages: ["Daily"] });
    expect(await readFile(join(dir, "Daily.md"), "utf8")).toBe(
      "Worked on [[Alpha|alpha]] today.\r\n[[Alpha|PA]] review; see [[Alpha]] and `Alpha`.\r\n[[Alpha|Project Alpha]] is late.\r\n",
    );
    // The links count now: Daily is a backlink and no longer a mention.
    expect(await mentionsOf(app)).toEqual([]);
    const backlinks = await getJson<Array<{ page: { id: string } }>>(app, `/api/pages/${encodeId("Projects/Alpha")}/backlinks`);
    expect(backlinks.map((item) => item.page.id)).toContain("Daily");
  });

  it("conditional: a stale version, a changed file or a stale position is 409 and writes nothing", async () => {
    const { app, dir } = await vault(files);
    const [daily] = await mentionsOf(app);
    const original = await readFile(join(dir, "Daily.md"), "utf8");
    expect((await link(app, { source: "Daily", expectedUpdated: "2001-01-01T00:00:00.000Z", all: true })).status).toBe(409);
    expect((await link(app, { source: "Daily", expectedUpdated: daily!.updated, positions: [1] })).status).toBe(409);
    expect(await readFile(join(dir, "Daily.md"), "utf8")).toBe(original);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(join(dir, "Daily.md"), `${original}More alpha.\r\n`);
    expect((await link(app, { source: "Daily", expectedUpdated: daily!.updated, all: true })).status).toBe(409);
    expect((await link(app, { source: "Daily", all: true, positions: "x" })).status).toBe(409);
    expect((await link(app, { source: "Projects/Alpha", all: true })).status).toBe(400);
    expect((await link(app, { source: "Daily" })).status).toBe(400);
  });
});
