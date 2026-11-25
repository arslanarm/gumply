import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { VaultStore } from "../src/vault-store";
import { cleanupVaults, createTestServer, encodeId, jsonRequest, trackStore } from "./helpers";

/** v0.8 C2 (#u84ebtf3): renaming a heading rewrites [[Page#Old]] across the vault. */

afterEach(cleanupVaults);

async function vault(files: Record<string, string>) {
  const server = await createTestServer();
  for (const [path, body] of Object.entries(files)) {
    await mkdir(join(server.dir, path, ".."), { recursive: true });
    await writeFile(join(server.dir, path), body, "utf8");
  }
  const store = trackStore(new VaultStore(server.dir));
  await store.init();
  return { dir: server.dir, store, app: createApp({ vaultPath: server.dir, store }) };
}

const PLAN = "# Plan\n\n## Goals\n\nShip it.\n\n## Risks\n\nNone.\n";
const BOARD = JSON.stringify({
  nodes: [
    { id: "a", type: "text", text: "See [[Plan#Goals]]", x: 0, y: 0, width: 200, height: 100 },
    { id: "b", type: "text", text: "Unrelated", x: 0, y: 200, width: 200, height: 100 },
  ],
  edges: [],
});

const files = {
  "Projects/Plan.md": PLAN,
  "Notes.md": "Read [[Plan#Goals]] and [[Plan#Goals|the goals]].\n![[Plan#Goals]]\n[[Plan#Risks]] [[Plan#^blk]] `[[Plan#Goals]]`\n",
  // An Obsidian note: no frontmatter, CRLF; it must keep both.
  "Daily.md": "Today: [[Projects/Plan#Goals#Sub]]\r\n",
  "Untouched.md": "---\ntitle: Untouched\n---\nLinks [[Plan]] and [[Plan#Risks]] only.\n",
  "Map.canvas": BOARD,
};

const rename = (app: Awaited<ReturnType<typeof vault>>["app"], content: string) =>
  jsonRequest(app, "PUT", `/api/pages/${encodeId("Projects/Plan")}`, { content });

describe("PUT /api/pages/:id renaming a heading", () => {
  it("rewrites links, aliases, embeds and board text; keeps every other byte; lists the pages", async () => {
    const { app, dir } = await vault(files);
    const untouchedBefore = await stat(join(dir, "Untouched.md"));
    const response = await rename(app, PLAN.replace("## Goals", "## Objectives"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { rewrittenPages: string[] };
    expect(body.rewrittenPages).toEqual(["Daily", "Map.canvas", "Notes"]);

    expect(await readFile(join(dir, "Notes.md"), "utf8")).toBe(
      "Read [[Plan#Objectives]] and [[Plan#Objectives|the goals]].\n![[Plan#Objectives]]\n[[Plan#Risks]] [[Plan#^blk]] `[[Plan#Goals]]`\n",
    );
    expect(await readFile(join(dir, "Daily.md"), "utf8")).toBe("Today: [[Projects/Plan#Objectives#Sub]]\r\n");
    const board = JSON.parse(await readFile(join(dir, "Map.canvas"), "utf8")) as { nodes: Array<{ text: string }> };
    expect(board.nodes.map((node) => node.text)).toEqual(["See [[Plan#Objectives]]", "Unrelated"]);

    // D37: a file with no matching link is never written.
    const untouchedAfter = await stat(join(dir, "Untouched.md"));
    expect(untouchedAfter.mtimeMs).toBe(untouchedBefore.mtimeMs);
    expect(await readFile(join(dir, "Untouched.md"), "utf8")).toBe(files["Untouched.md"]);
    // The page itself is exactly what was saved.
    expect(await readFile(join(dir, "Projects/Plan.md"), "utf8")).toBe(PLAN.replace("## Goals", "## Objectives"));
  });

  it("leaves links alone when headings were added or duplicated", async () => {
    const { app, dir } = await vault(files);
    const added = await rename(app, PLAN.replace("## Goals", "## Objectives").replace("## Risks", "## Risks\n\n## Extra"));
    expect(((await added.json()) as { rewrittenPages?: string[] }).rewrittenPages ?? []).toEqual([]);
    expect(await readFile(join(dir, "Notes.md"), "utf8")).toBe(files["Notes.md"]);
  });

  it("a title rename and a heading rename in one save: both follow", async () => {
    const { app, dir } = await vault(files);
    const response = await jsonRequest(app, "PUT", `/api/pages/${encodeId("Projects/Plan")}`, {
      title: "Roadmap",
      content: PLAN.replace("## Goals", "## Objectives"),
    });
    expect(response.status).toBe(200);
    const notes = await readFile(join(dir, "Notes.md"), "utf8");
    expect(notes).toContain("[[Roadmap#Objectives]]");
    expect(notes).toContain("[[Roadmap#Objectives|the goals]]");
    expect(notes).toContain("[[Roadmap#Risks]]");
  });

  it("an outside edit (Obsidian renaming the heading) never sets off Gumply writes", async () => {
    const { dir, store } = await vault(files);
    const before = new Map<string, { text: string; mtime: number }>();
    for (const name of ["Notes.md", "Daily.md", "Untouched.md", "Map.canvas"]) {
      before.set(name, { text: await readFile(join(dir, name), "utf8"), mtime: (await stat(join(dir, name))).mtimeMs });
    }
    await writeFile(join(dir, "Projects/Plan.md"), PLAN.replace("## Goals", "## Objectives"));
    // Both ways the store sees outside edits: an explicit rescan, and the watcher.
    expect(await store.rescan()).toBe(true);
    store.startWatching();
    await writeFile(join(dir, "Projects/Plan.md"), PLAN.replace("## Goals", "## Aims"));
    await new Promise((resolve) => setTimeout(resolve, 400));
    store.stopWatching();
    expect(store.get("Projects/Plan").content).toContain("## Aims");
    for (const [name, was] of before) {
      expect(await readFile(join(dir, name), "utf8"), name).toBe(was.text);
      expect((await stat(join(dir, name))).mtimeMs, name).toBe(was.mtime);
    }
  });

  // @opus-hunter's repro (vault-c2*): a second `Target.md` in a folder.
  describe("a second page with the same file name (#u84ebtf3)", () => {
    const TARGET = "# Target\n\n## Old heading\n\nText.\n";
    const sameName = {
      "Target.md": TARGET,
      "Other/Target.md": "# Other\n\n## Old heading\n\nAlso here.\n",
      "Links.md":
        "[[Target#Old heading]] [[Target#Old heading|alias]] ![[Target#Old heading]]\n" +
        "| t | [[Target#Old heading\\|piped]] |\n" +
        "[[Other/Target#Old heading]] \\[[Target#Old heading]]\n",
      "Cards.canvas": JSON.stringify({
        nodes: [
          { id: "f", type: "file", file: "Target.md", subpath: "#Old heading", x: 0, y: 0, width: 200, height: 100 },
          { id: "o", type: "file", file: "Other/Target.md", subpath: "#Old heading", x: 0, y: 200, width: 200, height: 100 },
          { id: "t", type: "text", text: "See [[Target#Old heading]]", x: 300, y: 0, width: 200, height: 100 },
        ],
        edges: [],
      }),
    };

    for (const order of ["root first", "folder first"] as const) {
      it(`rewrites every link that resolves to the renamed page, never the other file's (${order})`, async () => {
        const files = order === "root first" ? sameName : Object.fromEntries(Object.entries(sameName).reverse());
        const { app, dir } = await vault(files);
        const response = await jsonRequest(app, "PUT", `/api/pages/${encodeId("Target")}`, {
          content: TARGET.replace("## Old heading", "## New heading"),
        });
        expect(response.status).toBe(200);
        expect(((await response.json()) as { rewrittenPages: string[] }).rewrittenPages).toEqual(["Cards.canvas", "Links"]);
        expect(await readFile(join(dir, "Links.md"), "utf8")).toBe(
          "[[Target#New heading]] [[Target#New heading|alias]] ![[Target#New heading]]\n" +
            "| t | [[Target#New heading\\|piped]] |\n" +
            // Path-qualified to the other file, and an escaped `\[[` (text): left alone.
            "[[Other/Target#Old heading]] \\[[Target#Old heading]]\n",
        );
        const board = JSON.parse(await readFile(join(dir, "Cards.canvas"), "utf8")) as {
          nodes: Array<{ id: string; subpath?: string; text?: string }>;
        };
        const byId = Object.fromEntries(board.nodes.map((node) => [node.id, node]));
        expect(byId.f?.subpath).toBe("#New heading");
        expect(byId.o?.subpath).toBe("#Old heading");
        expect(byId.t?.text).toBe("See [[Target#New heading]]");
        expect(await readFile(join(dir, "Other/Target.md"), "utf8")).toBe(sameName["Other/Target.md"]);
      });
    }

    it("renaming the heading in the folder page rewrites only path-qualified links to it", async () => {
      const { app, dir } = await vault(sameName);
      const response = await jsonRequest(app, "PUT", `/api/pages/${encodeId("Other/Target")}`, {
        content: sameName["Other/Target.md"].replace("## Old heading", "## Moved"),
      });
      expect(((await response.json()) as { rewrittenPages: string[] }).rewrittenPages).toEqual(["Cards.canvas", "Links"]);
      const links = await readFile(join(dir, "Links.md"), "utf8");
      expect(links).toContain("[[Other/Target#Moved]]");
      expect(links).toContain("[[Target#Old heading]] [[Target#Old heading|alias]]");
      const board = JSON.parse(await readFile(join(dir, "Cards.canvas"), "utf8")) as { nodes: Array<{ id: string; subpath?: string }> };
      expect(board.nodes.map((node) => node.subpath)).toEqual(["#Old heading", "#Moved", undefined]);
    });
  });
});
