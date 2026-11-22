import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page, PageMentions } from "@gumply/core";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupVaults, createTestServer, getJson, jsonRequest } from "./helpers";

/**
 * #ippqkgus (D39): Obsidian 1.14.4 reads the keys `tags` and `aliases` in any
 * case (plural only); with two spellings in one note, only the first counts.
 * Gumply reads and writes the note's own key, keeping its spelling, and never
 * adds a second one.
 */

afterEach(cleanupVaults);

async function vault(files: Record<string, string>) {
  const server = await createTestServer();
  for (const [name, text] of Object.entries(files)) await writeFile(join(server.dir, name), text);
  await server.store.rescan();
  const read = (name: string) => readFile(join(server.dir, name), "utf8");
  const tags = async () =>
    Object.fromEntries(
      (await getJson<Array<{ tag: string; pages: string[] }>>(server.app, "/api/tags")).map((entry) => [entry.tag, [...entry.pages].sort()]),
    );
  return { ...server, read, tags };
}

const CAPS = "---\nTags: [capT]\nstatus: draft # mine\n---\n\nBody.\n";
const ALLCAPS = "---\nTAGS:\n  - allcaps\n---\n\nBody.\n";
const SINGULAR = "---\ntag: [singular]\nTag: capsingular\n---\n\nBody.\n";
const BOTH = "---\ntags: [lower]\nTags: [upper]\n---\n\nBody.\n";

describe("`tags` in any case is the page's tags (#ippqkgus)", () => {
  it("reads `Tags:` and `TAGS:` as tags; `tag:` / `Tag:` stay ordinary properties", async () => {
    const { app, tags } = await vault({ "Caps.md": CAPS, "AllCaps.md": ALLCAPS, "Singular.md": SINGULAR });
    expect(await tags()).toEqual({ capT: ["Caps"], allcaps: ["AllCaps"] });
    expect((await getJson<Page>(app, "/api/pages/Caps")).tags).toEqual(["capT"]);
    // The property shows under its own spelling, with the tags type.
    const props = (await getJson<Page>(app, "/api/pages/Caps")).properties ?? [];
    expect(props.find((property) => property.key === "Tags")?.type).toBe("tags");
    const singular = (await getJson<Page>(app, "/api/pages/Singular")).properties ?? [];
    expect(singular.find((property) => property.key === "tag")?.type).not.toBe("tags");
  });

  it("with both `tags:` and `Tags:`, only the first counts, and only it is ever written", async () => {
    const { app, read, tags } = await vault({ "Both.md": BOTH });
    expect(await tags()).toEqual({ lower: ["Both"] });
    expect((await jsonRequest(app, "POST", "/api/tags/rename", { from: "lower", to: "renamed" })).status).toBe(200);
    expect(await read("Both.md")).toBe(BOTH.replace("tags: [lower]", "tags: [renamed]"));
  });

  it("the tag rename rewrites `Tags:` in place, keeping its spelling; nothing else changes", async () => {
    const { app, read, tags } = await vault({ "Caps.md": CAPS, "AllCaps.md": ALLCAPS });
    await jsonRequest(app, "POST", "/api/tags/rename", { from: "capT", to: "renamedT" });
    await jsonRequest(app, "POST", "/api/tags/rename", { from: "allcaps", to: "renamed-all" });
    expect(await read("Caps.md")).toBe(CAPS.replace("Tags: [capT]", "Tags: [renamedT]"));
    expect(await read("AllCaps.md")).toBe(ALLCAPS.replace("  - allcaps", "  - renamed-all"));
    expect(await tags()).toEqual({ renamedT: ["Caps"], "renamed-all": ["AllCaps"] });
  });

  it("a properties patch to `Tags` (and the API's `tags`) updates the one key, keeping its spelling", async () => {
    const { app, read } = await vault({ "Caps.md": CAPS });
    await jsonRequest(app, "PUT", "/api/pages/Caps", { properties: { set: { Tags: ["capT", "more"] } } });
    let text = await read("Caps.md");
    expect(text.match(/^tags:/gim)).toHaveLength(1);
    expect(text).toContain("Tags: [capT, more]");
    expect((await getJson<Page>(app, "/api/pages/Caps")).tags).toEqual(["capT", "more"]);
    // The API's own `tags` field lands on the same key.
    await jsonRequest(app, "PUT", "/api/pages/Caps", { tags: ["only"] });
    text = await read("Caps.md");
    expect(text.match(/^tags:/gim)).toHaveLength(1);
    expect(text).toContain("Tags: [only]");
    expect(text).toContain("status: draft # mine");
  });
});

describe("`aliases` in any case are the page's aliases (#ippqkgus)", () => {
  it("`Aliases:` makes unlinked mentions; with two spellings only the first counts", async () => {
    const { app } = await vault({
      "T1.md": "---\nAliases: [Capword]\n---\nT1.\n",
      "T2.md": "---\naliases: [Firstword]\nAliases: [Secondword]\n---\nT2.\n",
      "M.md": "This note says Capword, Firstword and Secondword.\n",
    });
    const mentioned = async (id: string) =>
      (await getJson<PageMentions[]>(app, `/api/pages/${id}/mentions`)).flatMap((entry) => entry.mentions.map((mention) => mention.text));
    expect(await mentioned("T1")).toEqual(["Capword"]);
    expect(await mentioned("T2")).toEqual(["Firstword"]);
  });
});
