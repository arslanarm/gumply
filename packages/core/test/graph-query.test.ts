import { describe, expect, it } from "vitest";
import {
  DEFAULT_GRAPH_FORCES,
  DEFAULT_GRAPH_SETTINGS,
  fromObsidianGraph,
  GRAPH_FORCE_RANGES,
  graphItemPath,
  isDefaultGraphForces,
  matchesGraphQuery,
  mergeGraphSettings,
  normalizeGraphForces,
  normalizeGraphSettings,
  obsidianColor,
  parseGraphQuery,
  type GraphQueryItem,
} from "../src/index";

/** v0.8 E1: the graph's query language (Obsidian's search subset) and settings. */

const plan: GraphQueryItem = { title: "Q1 Plan", path: "Projects/Work/Q1 plan.md", tags: ["work/client", "Urgent"] };
const diary: GraphQueryItem = { title: "Дневник", path: "Личное/Дневник.md", tags: ["личное"] };
const map: GraphQueryItem = { title: "Map", path: "Boards/Map.canvas", tags: [] };
const matches = (query: string, item: GraphQueryItem) => matchesGraphQuery(parseGraphQuery(query), item);

describe("parseGraphQuery / matchesGraphQuery", () => {
  it("an empty query matches everything", () => {
    expect(parseGraphQuery("  ")).toEqual([]);
    expect(matches("", plan)).toBe(true);
  });

  it("tag: with or without #, nested tags included, case-insensitive", () => {
    expect(matches("tag:#work", plan)).toBe(true);
    expect(matches("tag:work", plan)).toBe(true);
    expect(matches("tag:#work/client", plan)).toBe(true);
    expect(matches("tag:#wor", plan)).toBe(false);
    expect(matches("tag:#urgent", plan)).toBe(true);
    expect(matches("tag:#client", plan)).toBe(false);
    expect(matches("tag:#Личное", diary)).toBe(true);
  });

  it("path: and file:", () => {
    expect(matches("path:Projects/Work", plan)).toBe(true);
    expect(matches("path:projects", plan)).toBe(true);
    expect(matches("path:Boards", plan)).toBe(false);
    expect(matches("file:plan", plan)).toBe(true);
    expect(matches("file:.canvas", map)).toBe(true);
    expect(matches("file:Projects", plan)).toBe(false);
  });

  it("plain words match the title or the file name; several must all match", () => {
    expect(matches("plan", plan)).toBe(true);
    expect(matches("q1 plan", plan)).toBe(true);
    expect(matches("q1 diary", plan)).toBe(false);
    expect(matches("дневник", diary)).toBe(true);
  });

  it("quoted phrases, negation and OR", () => {
    expect(matches('"q1 plan"', plan)).toBe(true);
    expect(matches('"plan q1"', plan)).toBe(false);
    expect(matches("-tag:#work", plan)).toBe(false);
    expect(matches("-tag:#work", diary)).toBe(true);
    expect(matches("tag:#work OR tag:#личное", diary)).toBe(true);
    expect(matches("tag:#work OR tag:#личное", map)).toBe(false);
    expect(matches('path:"Projects/Work" -file:draft', plan)).toBe(true);
  });

  it("an unknown op: is plain text, as written", () => {
    expect(parseGraphQuery("line:foo")).toEqual([[{ op: "text", value: "line:foo", negate: false }]]);
    expect(parseGraphQuery("-TAG:#X")).toEqual([[{ op: "tag", value: "x", negate: true }]]);
  });

  it("graph item paths: pages get .md, boards keep their extension", () => {
    expect(graphItemPath("Projects/Plan", "page")).toBe("Projects/Plan.md");
    expect(graphItemPath("Map.canvas", "whiteboard")).toBe("Map.canvas");
    expect(graphItemPath("Map.canvas.md", "page")).toBe("Map.canvas.md");
  });
});

describe("graph settings", () => {
  it("normalises untrusted JSON: bad values to defaults, bad groups skipped", () => {
    expect(normalizeGraphSettings(null)).toEqual(DEFAULT_GRAPH_SETTINGS);
    const settings = normalizeGraphSettings({
      groups: [
        { query: "tag:#a", color: "#AABBCC" },
        { query: "tag:#b", color: "red" },
        { query: 5, color: "#000000" },
        "nope",
      ],
      filters: { search: "x", showTags: "yes", showOrphans: false, extra: 1 },
      extra: true,
    });
    expect(settings).toEqual({
      groups: [{ query: "tag:#a", color: "#aabbcc" }],
      filters: { search: "x", showTags: false, showAttachments: false, hideUnresolved: false, showOrphans: false },
      forces: { center: 1, repel: 1, linkStrength: 1, linkDistance: 1 },
    });
    const many = normalizeGraphSettings({ groups: Array.from({ length: 80 }, () => ({ query: "q".repeat(900), color: "#000000" })) });
    expect(many.groups).toHaveLength(50);
    expect(many.groups[0]!.query).toHaveLength(500);
  });

  it("reads Obsidian's graph.json: {rgb, a} colours and its filters", () => {
    expect(obsidianColor({ a: 1, rgb: 14701138 })).toBe("#e05252");
    expect(obsidianColor({ a: 1, rgb: 0 })).toBe("#000000");
    expect(obsidianColor({ rgb: -1 })).toBeNull();
    expect(
      fromObsidianGraph({
        "collapse-filter": true,
        search: "path:Projects",
        showTags: true,
        showAttachments: false,
        hideUnresolved: true,
        showOrphans: false,
        colorGroups: [
          { query: "tag:#work", color: { a: 1, rgb: 14701138 } },
          { query: "path:Daily", color: { a: 1, rgb: 5431473 } },
          { query: "broken", color: "#fff" },
        ],
        scale: 1.2,
        // #nadk3urm: Obsidian's own forces (another engine, another scale) are not read.
        centerStrength: 0.1,
        repelStrength: 20,
        linkStrength: 0.2,
        linkDistance: 400,
      }),
    ).toEqual({
      groups: [
        { query: "tag:#work", color: "#e05252" },
        { query: "path:Daily", color: "#52e0b1" },
      ],
      filters: { search: "path:Projects", showTags: true, showAttachments: false, hideUnresolved: true, showOrphans: false },
      forces: { center: 1, repel: 1, linkStrength: 1, linkDistance: 1 },
    });
  });

  it("#nadk3urm: forces are multipliers, clamped to their ranges; a bad or missing one is the default (1)", () => {
    expect(normalizeGraphForces(undefined)).toEqual(DEFAULT_GRAPH_FORCES);
    expect(normalizeGraphForces({ center: -1, repel: 99, linkStrength: Number.NaN, linkDistance: 0.1, other: 5 })).toEqual({
      center: GRAPH_FORCE_RANGES.center.min,
      repel: GRAPH_FORCE_RANGES.repel.max,
      linkStrength: 1,
      linkDistance: GRAPH_FORCE_RANGES.linkDistance.min,
    });
    expect(isDefaultGraphForces(DEFAULT_GRAPH_FORCES)).toBe(true);
    expect(isDefaultGraphForces({ ...DEFAULT_GRAPH_FORCES, center: 0 })).toBe(false);
    // The defaults sit inside every range, so a slider can show them.
    for (const [key, range] of Object.entries(GRAPH_FORCE_RANGES)) {
      const value = DEFAULT_GRAPH_FORCES[key as keyof typeof DEFAULT_GRAPH_FORCES];
      expect(value).toBeGreaterThanOrEqual(range.min);
      expect(value).toBeLessThanOrEqual(range.max);
    }
  });

  it("#nadk3urm: a save writes `forces` only once they're changed or already in the file, keeping unknown keys", () => {
    const base = { groups: [], filters: DEFAULT_GRAPH_SETTINGS.filters };
    expect(mergeGraphSettings({ zoom: 1 }, { ...base, forces: DEFAULT_GRAPH_FORCES })).not.toHaveProperty("forces");
    expect(mergeGraphSettings({}, { ...base, forces: { ...DEFAULT_GRAPH_FORCES, center: 0 } }).forces).toEqual({ ...DEFAULT_GRAPH_FORCES, center: 0 });
    expect(mergeGraphSettings({ forces: { center: 0, gravity: 2 } }, { ...base, forces: DEFAULT_GRAPH_FORCES }).forces).toEqual({ ...DEFAULT_GRAPH_FORCES, gravity: 2 });
  });
});
