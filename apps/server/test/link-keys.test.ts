import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PageMentions, PageMeta } from "@gumply/core";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { VaultStore } from "../src/vault-store";
import { cleanupVaults, createTestServer, encodeId, getJson, jsonRequest } from "./helpers";

/**
 * #7xbdttxy (D39): a whole-value `"[[Alpha]]"` under `tags`, `aliases` or
 * `cssclasses` is a link in Obsidian 1.14.4 (graph edge, backlink, rewritten
 * on rename) and never a tag or an alias.
 */

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

const NOTE = [
  "---",
  'tags: ["[[Alpha]]", project]',
  "Tags2: x",
  "aliases:",
  '  - "[[Alpha]]"',
  "  - Al",
  "cssclasses: ['[[Alpha]]']",
  "---",
  "Nothing in the body.",
  "",
].join("\n");
const TAGS_STRING = '---\ntags: "[[Alpha]]"\n---\nBody.\n';
const CAPITAL = '---\nTags: ["[[Alpha]]"] # keep\n---\nBody.\n';

type GraphData = { links: Array<{ source: string; target: string }> };
type Backlink = { page: { id: string }; snippet: string };

describe("tags, aliases and cssclasses links (#7xbdttxy)", () => {
  it("are graph edges and backlinks, and never tags or aliases", async () => {
    const { app } = await vault({ "Alpha.md": "Alpha page.\n", "Note.md": NOTE, "Str.md": TAGS_STRING, "Cap.md": CAPITAL });
    const graph = await getJson<GraphData>(app, "/api/graph");
    for (const source of ["Note", "Str", "Cap"]) {
      expect(graph.links.filter((link) => link.source === source).map((link) => link.target), source).toEqual(["Alpha"]);
    }
    const backlinks = await getJson<Backlink[]>(app, `/api/pages/${encodeId("Alpha")}/backlinks`);
    expect(backlinks.map((item) => item.page.id).sort()).toEqual(["Cap", "Note", "Str"]);

    // Never a tag: the note keeps only its real tag; the others have none.
    const pages = await getJson<PageMeta[]>(app, "/api/pages");
    const tagsOf = (id: string) => pages.find((page) => page.id === id)!.tags;
    expect(tagsOf("Note")).toEqual(["project"]);
    expect(tagsOf("Str")).toEqual([]);
    expect(tagsOf("Cap")).toEqual([]);
    const tags = await getJson<Array<{ tag: string }>>(app, "/api/tags");
    expect(tags.map((entry) => entry.tag)).not.toContain("[[Alpha]]");
    expect(tags.some((entry) => entry.tag.includes("[["))).toBe(false);
  });

  it("an alias that is a link isn't a mention term: only the real alias finds mentions", async () => {
    const { app } = await vault({
      "Alpha.md": "---\naliases:\n  - \"[[Beta]]\"\n  - Al\n---\nAlpha.\n",
      "Beta.md": "Beta.\n",
      "Text.md": "Talking about Al today, and about Beta too.\n",
    });
    const mentions = await getJson<PageMentions[]>(app, `/api/pages/${encodeId("Alpha")}/mentions`);
    const terms = mentions.flatMap((entry) => entry.mentions.map((mention) => mention.term));
    expect(terms).toEqual(["Al"]);
  });

  it("a rename rewrites them in place, byte-exact otherwise (D37)", async () => {
    const { app, dir } = await vault({ "Alpha.md": "Alpha page.\n", "Note.md": NOTE, "Str.md": TAGS_STRING, "Cap.md": CAPITAL });
    const response = await jsonRequest(app, "PUT", `/api/pages/${encodeId("Alpha")}`, { title: "Gamma" });
    expect(response.status).toBe(200);
    expect(await readFile(join(dir, "Note.md"), "utf8")).toBe(NOTE.replaceAll("[[Alpha]]", "[[Gamma]]"));
    expect(await readFile(join(dir, "Str.md"), "utf8")).toBe(TAGS_STRING.replace("[[Alpha]]", "[[Gamma]]"));
    expect(await readFile(join(dir, "Cap.md"), "utf8")).toBe(CAPITAL.replace("[[Alpha]]", "[[Gamma]]"));
  });
});
