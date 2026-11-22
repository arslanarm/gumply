import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CanvasBoard } from "@gumply/core";
import { createApp } from "../src/app";
import { VaultStore } from "../src/vault-store";
import { cleanupVaults, createTestServer, encodeId, jsonRequest } from "./helpers";

/**
 * #3c86ify2 (D37): a rename rewrites `[[links]]` in frontmatter values too,
 * changing only those values; a board that links to the page changes only the
 * affected node strings, in the file's own layout (MCP `add_to_board` adds one
 * node the same way).
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

const read = (dir: string, path: string) => readFile(join(dir, path), "utf8");
const renamePage = (app: Awaited<ReturnType<typeof vault>>["app"], id: string, title: string) =>
  jsonRequest(app, "PUT", `/api/pages/${encodeId(id)}`, { title });

const PROPS = [
  "---",
  'related: "[[Alpha]]" # the main one',
  "quoted: '[[Alpha|it''s]]'",
  "plain: see [[Alpha]] first",
  "list:",
  '  - "[[Alpha]]"',
  "  - '[[Gamma]]'",
  "  - plain [[Alpha#Goals]]",
  'flow: ["[[Alpha]]", other]',
  "block: |",
  "  [[Alpha]] stays: block scalars are text",
  "tags: [alpha]",
  'untouched: "[[Gamma]]"',
  "status: done",
  "---",
  "",
  "Body without links.",
  "",
].join("\n");

/** Spaces, a final newline and a `\u` escape: nothing like Obsidian's tab layout. */
const SPACED_BOARD = [
  "{",
  '  "nodes": [',
  '    {"id": "a", "type": "text", "text": "See [[Alpha]]", "x": 0, "y": 0, "width": 200, "height": 100},',
  '    {"id": "b", "type": "text", "text": "Caf\\u00e9 [[Gamma]]", "x": 0, "y": 200, "width": 200, "height": 100},',
  '    {"id": "c", "type": "file", "file": "Projects/Alpha.md", "x": 300, "y": 0, "width": 400, "height": 300}',
  "  ],",
  '  "edges": []',
  "}",
  "",
].join("\n");
const TAB_BOARD = '{\n\t"nodes":[\n\t\t{"id":"t","type":"text","text":"[[Alpha]] and [[Gamma]]","x":0,"y":0,"width":200,"height":100}\n\t],\n\t"edges":[]\n}';
const MINIFIED_BOARD = '{"nodes":[{"id":"m","type":"text","text":"Go to [[Alpha]]","x":0,"y":0,"width":10,"height":10}],"edges":[],"x-custom":{"keep":1}}';
const CRLF_BOARD = '{\r\n  "nodes": [\r\n    {"id": "r", "type": "text", "text": "[[Alpha]]", "x": 0, "y": 0, "width": 1, "height": 1}\r\n  ],\r\n  "edges": []\r\n}\r\n';

const files = {
  "Projects/Alpha.md": "## Goals\n\nShip it.\n",
  "Gamma.md": "Gamma.\n",
  "Props.md": PROPS,
  "Crlf.md": '---\r\nrel: "[[Alpha]]"\r\n---\r\nText',
  "Untouched.md": '---\nrel: "[[Gamma]]"\n---\nNothing about it.\n',
  "Spaced.canvas": SPACED_BOARD,
  "Tabs.canvas": TAB_BOARD,
  "Minified.canvas": MINIFIED_BOARD,
  "Crlf.canvas": CRLF_BOARD,
};

describe("renaming a page (#3c86ify2)", () => {
  it("rewrites links in frontmatter values in their own quoting; every other byte is kept", async () => {
    const { app, dir } = await vault(files);
    const untouched = await stat(join(dir, "Untouched.md"));
    const response = await renamePage(app, "Projects/Alpha", "Beta");
    expect(response.status).toBe(200);
    const { rewrittenPages } = (await response.json()) as { rewrittenPages: string[] };
    expect(rewrittenPages).toEqual(expect.arrayContaining(["Props", "Crlf"]));
    expect(rewrittenPages).not.toContain("Untouched");

    expect(await read(dir, "Props.md")).toBe(
      PROPS.replace('related: "[[Alpha]]"', 'related: "[[Beta]]"')
        .replace("'[[Alpha|it''s]]'", "'[[Beta|it''s]]'")
        .replace("plain: see [[Alpha]] first", "plain: see [[Beta]] first")
        .replace('  - "[[Alpha]]"', '  - "[[Beta]]"')
        .replace("  - plain [[Alpha#Goals]]", "  - plain [[Beta#Goals]]")
        .replace('flow: ["[[Alpha]]", other]', 'flow: ["[[Beta]]", other]'),
    );
    // CRLF, no final newline, no `updated:` added (v1.16).
    expect(await read(dir, "Crlf.md")).toBe('---\r\nrel: "[[Beta]]"\r\n---\r\nText');
    // D37: no matching link, no write.
    expect((await stat(join(dir, "Untouched.md"))).mtimeMs).toBe(untouched.mtimeMs);
  });

  it("quotes a plain value that needs it now, and escapes a quote in a double-quoted one", async () => {
    const { app, dir } = await vault({
      "Alpha.md": "x\n",
      "P.md": '---\nnote: see [[Alpha]]\nq: "[[Alpha]]"\n---\n',
      // Not valid YAML (a flow list followed by text): the block is never touched.
      "Bad.md": "---\nplain: [[Alpha]] then text\n---\nBody\n",
    });
    expect((await renamePage(app, "Alpha", 'Q3: "big" plan')).status).toBe(200);
    const meta = (await (await app.request("/api/pages")).json()) as Array<{ id: string; title: string }>;
    const renamed = meta.find((page) => page.title === 'Q3: "big" plan')!;
    const link = `[[${renamed.id}|Q3: "big" plan]]`;
    expect(await read(dir, "P.md")).toBe(
      `---\nnote: ${JSON.stringify(`see ${link}`)}\nq: ${JSON.stringify(link)}\n---\n`,
    );
    expect(await read(dir, "Bad.md")).toBe("---\nplain: [[Alpha]] then text\n---\nBody\n");
  });

  it("boards change only the affected strings, in their own layout (spaces, tabs, one line, CRLF)", async () => {
    const { app, dir } = await vault(files);
    expect((await renamePage(app, "Projects/Alpha", "Beta")).status).toBe(200);
    expect(await read(dir, "Spaced.canvas")).toBe(
      SPACED_BOARD.replace('"See [[Alpha]]"', '"See [[Beta]]"').replace('"Projects/Alpha.md"', '"Projects/Beta.md"'),
    );
    expect(await read(dir, "Tabs.canvas")).toBe(TAB_BOARD.replace("[[Alpha]] and", "[[Beta]] and"));
    expect(await read(dir, "Minified.canvas")).toBe(MINIFIED_BOARD.replace("[[Alpha]]", "[[Beta]]"));
    expect(await read(dir, "Crlf.canvas")).toBe(CRLF_BOARD.replace("[[Alpha]]", "[[Beta]]"));
  });
});

describe("folder moves and heading renames (#3c86ify2)", () => {
  it("a folder rename rewrites path links in frontmatter values", async () => {
    const { app, dir } = await vault({
      "Projects/Alpha.md": "x\n",
      "P.md": '---\nrel: "[[Projects/Alpha]]" # keep\nother: x\n---\nAnd [[Projects/Alpha|a]].\n',
    });
    expect((await renamePage(app, "Projects", "Work")).status).toBe(200);
    expect(await read(dir, "P.md")).toBe('---\nrel: "[[Work/Alpha]]" # keep\nother: x\n---\nAnd [[Work/Alpha|a]].\n');
  });

  it("a heading rename rewrites [[Page#Old]] in frontmatter values", async () => {
    const { app, dir } = await vault({
      "Alpha.md": "## Goals\n\nShip.\n",
      "P.md": "---\nsec: '[[Alpha#Goals]]'\nlist:\n  - \"[[Alpha#Goals|g]]\"\n---\n",
    });
    const response = await jsonRequest(app, "PUT", `/api/pages/${encodeId("Alpha")}`, { content: "## Aims\n\nShip.\n" });
    expect(response.status).toBe(200);
    expect(await read(dir, "P.md")).toBe("---\nsec: '[[Alpha#Aims]]'\nlist:\n  - \"[[Alpha#Aims|g]]\"\n---\n");
  });
});

describe("MCP add_to_board writes only the new node (#3c86ify2)", () => {
  it("appends in the file's own layout; the rest keeps its bytes", async () => {
    const { store, dir } = await vault({ "Spaced.canvas": SPACED_BOARD, "Minified.canvas": MINIFIED_BOARD });
    const node = { id: "n1", type: "text", text: "New", x: 0, y: 400, width: 300, height: 120 } as CanvasBoard["nodes"][number];
    for (const id of ["Spaced.canvas", "Minified.canvas"]) {
      const doc = store.getBoard(id);
      await store.updateBoard(id, { board: { ...doc.board, nodes: [...doc.board.nodes, node] }, expectedUpdated: doc.meta.updated, minimal: true });
    }
    const added = JSON.stringify(node);
    expect(await read(dir, "Spaced.canvas")).toBe(
      SPACED_BOARD.replace('"height": 300}\n', `"height": 300},\n    ${added}\n`),
    );
    expect(await read(dir, "Minified.canvas")).toBe(MINIFIED_BOARD.replace(',"height":10}]', `,"height":10},${added}]`));
  });

  it("without `minimal` (the editor's own saves) a board is still written in Obsidian's layout", async () => {
    const { store, dir } = await vault({ "Minified.canvas": MINIFIED_BOARD });
    const doc = store.getBoard("Minified.canvas");
    await store.updateBoard("Minified.canvas", { board: doc.board, expectedUpdated: doc.meta.updated });
    expect(await read(dir, "Minified.canvas")).toContain('\n\t"nodes":[');
  });
});
