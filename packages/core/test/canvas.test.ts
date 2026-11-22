import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CanvasParseError,
  canvasAttachments,
  canvasBounds,
  canvasId,
  canvasLinks,
  canvasMeta,
  canvasNodeKind,
  canvasText,
  emptyCanvas,
  gumplyNodeData,
  isPresetColor,
  parseCanvas,
  rewriteCanvas,
  rewriteLinksToPage,
  serializeCanvas,
  withCanvasMeta,
  type CanvasBoard,
  type CanvasNode,
  type PageMeta,
} from "../src/index";

// The fixtures were written by Obsidian's own canvas writer (extracted from
// Obsidian 1.x's app bundle), so they are byte-for-byte what Obsidian saves.
function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/canvas/${name}`, import.meta.url), "utf8");
}

const FIXTURES = ["obsidian-basic.canvas", "gumply-extras.canvas", "obsidian-empty.canvas"];

function node(board: CanvasBoard, id: string): CanvasNode {
  const found = board.nodes.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no node ${id}`);
  return found;
}

describe("parseCanvas / serializeCanvas", () => {
  it.each(FIXTURES)("round-trips %s byte for byte", (name) => {
    const source = fixture(name);
    expect(serializeCanvas(parseCanvas(source))).toBe(source);
  });

  it("is stable: serialising twice gives the same text", () => {
    const once = serializeCanvas(parseCanvas(fixture("gumply-extras.canvas")));
    expect(serializeCanvas(parseCanvas(once))).toBe(once);
  });

  it("keeps unknown keys, unknown node types, node order and colour notation", () => {
    const board = parseCanvas(fixture("gumply-extras.canvas"));
    expect(board.nodes.map((n) => n.id)).toEqual([
      "f00dfeed00000001",
      "f00dfeed00000002",
      "f00dfeed00000003",
      "f00dfeed00000004",
      "f00dfeed00000005",
    ]);
    expect(node(board, "f00dfeed00000004").styleAttributes).toEqual({ shape: "pill", border: null });
    expect(node(board, "f00dfeed00000005")).toMatchObject({ type: "x-mindmap", topic: "Future node type" });
    expect(board.edges[0]?.styleAttributes).toEqual({ path: "dotted" });
    expect(board.metadata).toEqual({ version: "1.0-1.0", frontmatter: {} });

    const basic = parseCanvas(fixture("obsidian-basic.canvas"));
    expect(node(basic, "a1b2c3d4e5f60718").color).toBe("1");
    expect(node(basic, "9a8b7c6d5e4f3a2b").color).toBe("#ff8800");
    expect(basic.edges[2]?.color).toBe("#7a5af8");
  });

  it("writes Obsidian's layout: primitive-only objects on one line, tabs, no trailing newline", () => {
    const board: CanvasBoard = {
      nodes: [{ id: "n1", type: "text", text: "Hi", x: 0, y: 0, width: 10, height: 10 }],
      edges: [],
    };
    expect(serializeCanvas(board)).toBe(
      '{\n\t"nodes":[\n\t\t{"id":"n1","type":"text","text":"Hi","x":0,"y":0,"width":10,"height":10}\n\t],\n\t"edges":[]\n}',
    );
  });

  it("skips undefined values like JSON.stringify", () => {
    const board: CanvasBoard = {
      nodes: [{ id: "n1", type: "text", text: "", x: 0, y: 0, width: 1, height: 1, color: undefined }],
      edges: [],
      gumply: { icon: undefined, tags: ["a"] },
    };
    const text = serializeCanvas(board);
    expect(text).not.toContain("color");
    expect(text).not.toContain("icon");
    expect(JSON.parse(text)).toEqual({
      nodes: [{ id: "n1", type: "text", text: "", x: 0, y: 0, width: 1, height: 1 }],
      edges: [],
      gumply: { tags: ["a"] },
    });
  });

  it("reads compact or differently indented JSON and rewrites it in the canonical layout", () => {
    const compact = JSON.stringify(JSON.parse(fixture("obsidian-basic.canvas")));
    expect(serializeCanvas(parseCanvas(compact))).toBe(fixture("obsidian-basic.canvas"));
    const spaced = JSON.stringify(JSON.parse(fixture("gumply-extras.canvas")), null, 2);
    expect(serializeCanvas(parseCanvas(spaced))).toBe(fixture("gumply-extras.canvas"));
  });

  it("treats an empty file or `{}` as an empty board", () => {
    expect(parseCanvas("")).toEqual({ nodes: [], edges: [] });
    expect(parseCanvas("  \n")).toEqual({ nodes: [], edges: [] });
    expect(parseCanvas("{}")).toEqual({ nodes: [], edges: [] });
    expect(serializeCanvas(parseCanvas("{}"))).toBe(fixture("obsidian-empty.canvas"));
  });

  it("keeps the file's top-level key order and adds missing nodes/edges", () => {
    const board = parseCanvas('{"gumply":{"icon":"🧭"},"edges":[]}');
    expect(Object.keys(board)).toEqual(["gumply", "edges", "nodes"]);
  });

  it("rejects invalid JSON and non-object canvases", () => {
    expect(() => parseCanvas("{nodes:")).toThrow(CanvasParseError);
    expect(() => parseCanvas("[]")).toThrow(CanvasParseError);
    expect(() => parseCanvas("42")).toThrow(/top level must be an object/);
    expect(() => parseCanvas('{"nodes":{}}')).toThrow(/`nodes` must be an array/);
    expect(() => parseCanvas('{"nodes":[],"edges":"x"}')).toThrow(/`edges` must be an array/);
  });

  it("drops entries that can't be drawn and defaults broken geometry", () => {
    const board = parseCanvas(
      JSON.stringify({
        nodes: [
          { id: "a", type: "text", text: "A", x: 1, y: 2, width: 3, height: 4 },
          { id: "a", type: "text", text: "duplicate", x: 0, y: 0, width: 1, height: 1 },
          { type: "text", text: "no id" },
          "not an object",
          { id: "b", type: "text", text: "B", x: "10", y: null, height: 50 },
        ],
        edges: [
          { id: "e1", fromNode: "a", toNode: "b" },
          { id: "e2", fromNode: "a", toNode: "missing" },
          { id: "e1", fromNode: "b", toNode: "a" },
          { fromNode: "a", toNode: "b" },
        ],
      }),
    );
    expect(board.nodes.map((n) => n.text)).toEqual(["A", "B"]);
    const b = node(board, "b");
    expect([b.x, b.y, b.width, b.height]).toEqual([0, 0, 100, 50]);
    // Defaulted keys stay where they were; a missing one is appended.
    expect(Object.keys(b)).toEqual(["id", "type", "text", "x", "y", "height", "width"]);
    expect(board.edges.map((e) => e.id)).toEqual(["e1"]);
  });

  it("does not copy nodes whose geometry is already valid", () => {
    const board = parseCanvas(fixture("obsidian-basic.canvas"));
    const again = parseCanvas(serializeCanvas(board));
    expect(again).toEqual(board);
  });
});

describe("node kinds and Gumply extras", () => {
  const extras = parseCanvas(fixture("gumply-extras.canvas"));
  const basic = parseCanvas(fixture("obsidian-basic.canvas"));

  it("classifies every node", () => {
    expect(extras.nodes.map(canvasNodeKind)).toEqual(["sticky", "shape", "ink", "text", "unknown"]);
    expect(basic.nodes.map(canvasNodeKind)).toEqual(["group", "text", "page", "page", "image", "link", "board"]);
  });

  it("validates gumply data and falls back to the JSON Canvas type", () => {
    expect(gumplyNodeData(node(extras, "f00dfeed00000002"))).toEqual({ kind: "shape", shape: "diamond" });
    const ink = gumplyNodeData(node(extras, "f00dfeed00000003"));
    expect(ink?.kind === "ink" && ink.points.length).toBe(4);

    const base = { id: "x", type: "text" as const, text: "t", x: 0, y: 0, width: 1, height: 1 };
    expect(canvasNodeKind({ ...base, gumply: { kind: "shape", shape: "hexagon" } as never })).toBe("text");
    expect(canvasNodeKind({ ...base, gumply: { kind: "ink", points: [["a", 1]], width: 2 } as never })).toBe("text");
    expect(canvasNodeKind({ ...base, gumply: { kind: "ink", points: [[1, 2]], width: 2 } })).toBe("ink");
    expect(canvasNodeKind({ ...base, gumply: { kind: "laser" } as never })).toBe("text");
    expect(canvasNodeKind({ ...base, gumply: "sticky" as never })).toBe("text");
    // Gumply data on a non-text node is ignored.
    expect(canvasNodeKind({ id: "g", type: "group", x: 0, y: 0, width: 1, height: 1, gumply: { kind: "sticky" } })).toBe(
      "group",
    );
  });

  it("knows the preset colours", () => {
    expect(["1", "6"].every(isPresetColor)).toBe(true);
    expect(["0", "7", "#ff0000", 1, undefined].some(isPresetColor)).toBe(false);
  });
});

describe("board meta", () => {
  it("reads icon and tags", () => {
    expect(canvasMeta(parseCanvas(fixture("gumply-extras.canvas")))).toEqual({ icon: "🧭", tags: ["planning", "q1"] });
    expect(canvasMeta(emptyCanvas())).toEqual({ icon: null, tags: [] });
    expect(canvasMeta({ nodes: [], edges: [], gumply: { icon: " ", tags: ["a", 3] as never } })).toEqual({
      icon: null,
      tags: ["a"],
    });
  });

  it("updates meta immutably, keeps other gumply keys and drops an empty object", () => {
    const board = parseCanvas(fixture("gumply-extras.canvas"));
    const next = withCanvasMeta(board, { icon: "🗺️" });
    expect(next.gumply).toEqual({ icon: "🗺️", tags: ["planning", "q1"] });
    expect(board.gumply?.icon).toBe("🧭");
    expect(Object.keys(next)).toEqual(Object.keys(board));

    const cleared = withCanvasMeta(withCanvasMeta(board, { icon: null }), { tags: [] });
    expect(cleared.gumply).toEqual({ tags: [] });
    expect(withCanvasMeta(emptyCanvas({ icon: "x" }), { icon: null })).toEqual({ nodes: [], edges: [] });
  });
});

describe("canvasLinks / canvasAttachments", () => {
  it("lists page and board cards plus [[links]] in text, skipping code", () => {
    const links = canvasLinks(parseCanvas(fixture("obsidian-basic.canvas")));
    expect(
      links.map((link) => (link.kind === "file" ? `file:${link.path}${link.subpath ?? ""}` : `wiki:${link.link.targetTitle}`)),
    ).toEqual([
      "wiki:Roadmap",
      "wiki:Graph View",
      "file:Projects/Q1 plan.md",
      "file:Projects/Q1 plan.md#Risks",
      "file:Boards/Project map.canvas",
    ]);
    const alias = links[1];
    expect(alias?.kind === "wikilink" && alias.link.alias).toBe("the graph");
    expect(alias?.nodeId).toBe("a1b2c3d4e5f60718");
  });

  it("finds links in stickies and shapes and ignores attachment embeds", () => {
    const board: CanvasBoard = {
      nodes: [
        { id: "s", type: "text", text: "[[Alice]] ![[pic.png]] ![[Embedded note]]", x: 0, y: 0, width: 1, height: 1, gumply: { kind: "sticky" } },
      ],
      edges: [],
    };
    // A note embed links to the note (#5dpxwac4), like Obsidian's backlinks.
    expect(canvasLinks(board).map((link) => link.kind === "wikilink" && link.link.targetTitle)).toEqual(["Alice", "Embedded note"]);
  });

  it("lists attachments once", () => {
    const board = parseCanvas(fixture("obsidian-basic.canvas"));
    board.nodes.push({ id: "dup", type: "file", file: "attachments/diagram.png", x: 0, y: 0, width: 1, height: 1 });
    board.nodes.push({ id: "pdf", type: "file", file: "attachments/spec.pdf", x: 0, y: 0, width: 1, height: 1 });
    expect(canvasAttachments(board)).toEqual(["attachments/diagram.png", "attachments/spec.pdf"]);
  });
});

describe("rewriteCanvas (rename writer)", () => {
  function page(id: string, title: string): PageMeta {
    return { id, title, tags: [], parentId: null, childCount: 0, created: "", updated: "" };
  }

  it("rewrites file-node paths and [[links]] in text, keeping everything else", () => {
    const source = fixture("obsidian-basic.canvas");
    const board = parseCanvas(source);
    const renamed = page("Projects/Q1 roadmap", "Q1 roadmap");
    const roadmap = page("Roadmap 2027", "Roadmap 2027");
    const pages = [renamed, roadmap];

    const { board: next, count } = rewriteCanvas(board, {
      file: (path) => (path === "Projects/Q1 plan.md" ? "Projects/Q1 roadmap.md" : null),
      text: (markdown) =>
        rewriteLinksToPage(markdown, (link) => link.targetTitle === "Roadmap", roadmap, pages, "Roadmap").content,
    });

    expect(count).toBe(3);
    expect(node(next, "0f1e2d3c4b5a6978").file).toBe("Projects/Q1 roadmap.md");
    expect(node(next, "9a8b7c6d5e4f3a2b")).toMatchObject({ file: "Projects/Q1 roadmap.md", subpath: "#Risks" });
    expect(node(next, "a1b2c3d4e5f60718").text).toContain("[[Roadmap 2027]] to [[Graph View|the graph]]");
    expect(node(next, "a1b2c3d4e5f60718").text).toContain("`[[not a link]]`");

    // Only the three changed lines differ from the original file.
    const before = source.split("\n");
    const after = serializeCanvas(next).split("\n");
    expect(after.length).toBe(before.length);
    expect(after.filter((line, i) => line !== before[i]).length).toBe(3);
    // The input board is untouched.
    expect(serializeCanvas(board)).toBe(source);
  });

  it("rewrites a file node's subpath (C2, #u84ebtf3), alone or with its path", () => {
    const source = fixture("obsidian-basic.canvas");
    const board = parseCanvas(source);
    const onlySubpath = rewriteCanvas(board, { subpath: (subpath, n) => (n.file === "Projects/Q1 plan.md" && subpath === "#Risks" ? "#Threats" : null) });
    expect(onlySubpath.count).toBe(1);
    expect(node(onlySubpath.board, "9a8b7c6d5e4f3a2b")).toMatchObject({ file: "Projects/Q1 plan.md", subpath: "#Threats" });
    // A node without a subpath is never asked.
    expect(node(onlySubpath.board, "0f1e2d3c4b5a6978").subpath).toBeUndefined();
    const before = source.split("\n");
    const after = serializeCanvas(onlySubpath.board).split("\n");
    expect(after.filter((line, i) => line !== before[i]).length).toBe(1);

    const both = rewriteCanvas(board, {
      file: (path) => (path === "Projects/Q1 plan.md" ? "Projects/Q1 roadmap.md" : null),
      subpath: () => "#Threats",
    });
    expect(both.count).toBe(2);
    expect(node(both.board, "9a8b7c6d5e4f3a2b")).toMatchObject({ file: "Projects/Q1 roadmap.md", subpath: "#Threats" });
  });

  it("returns the same board when nothing matches", () => {
    const board = parseCanvas(fixture("gumply-extras.canvas"));
    const result = rewriteCanvas(board, { file: () => null, text: (markdown) => markdown });
    expect(result.count).toBe(0);
    expect(result.board).toBe(board);
  });
});

describe("canvasText", () => {
  it("collects text, frame labels, link URLs and connector labels", () => {
    const text = canvasText(parseCanvas(fixture("obsidian-basic.canvas")));
    expect(text.split("\n\n")[0]).toBe("Q1 planning");
    expect(text).toContain("Ship **whiteboards**");
    expect(text).toContain("https://jsoncanvas.org");
    expect(text.endsWith("details\n\nsee also")).toBe(true);
    expect(text).not.toContain("Projects/Q1 plan.md");
  });

  it("leaves out empty ink nodes", () => {
    const text = canvasText(parseCanvas(fixture("gumply-extras.canvas")));
    expect(text).toBe("Call [[Alice]] about **pricing**\n\nDecision\n\nStyled by a plugin");
  });
});

describe("helpers", () => {
  it("makes Obsidian-style ids", () => {
    const ids = new Set(Array.from({ length: 50 }, canvasId));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("computes bounds", () => {
    expect(canvasBounds([])).toBeNull();
    const board = parseCanvas(fixture("obsidian-basic.canvas"));
    expect(canvasBounds(board.nodes)).toEqual({ x: -420, y: -300, width: 1460, height: 800 });
  });
});
