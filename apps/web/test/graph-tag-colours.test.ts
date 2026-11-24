import { describe, expect, it } from "vitest";
import type { GraphData, PageMeta } from "@gumply/core";
import { ATTACHMENT_PALETTE_INDEX, buildGraphModel, colouringTags, firstTagCounts, firstTagCountsKey, nodeColor, paletteIndex, tagColorSlots, tagColorSlotsFromCounts, tagSlot, FALLBACK_GRAPH_PALETTE } from "../src/graph/graph-model";

/** #cp7xvwjc: the tags in a graph get distinct colours (a plain hash collided). */
const pages = (spec: Record<string, number>) =>
  Object.entries(spec).flatMap(([tag, count]) => Array.from({ length: count }, () => ({ tags: [tag, "other"] })));

describe("tagColorSlots", () => {
  it("gives up to 10 tags distinct slots, including two that hash alike", () => {
    // Find two tags with the same hash slot, as #money and #reading had.
    const names = Array.from({ length: 200 }, (_, i) => `tag${i}`);
    const a = names[0]!;
    const b = names.find((name) => name !== a && paletteIndex(name) === paletteIndex(a))!;
    const tags = [a, b, ...names.filter((name) => name !== a && name !== b).slice(0, 8)];
    const slots = tagColorSlots(pages(Object.fromEntries(tags.map((tag) => [tag, 3]))));
    const used = tags.map((tag) => slots.get(tag));
    expect(new Set(used).size).toBe(10);
    expect(slots.get(a)).not.toBe(slots.get(b));
  });

  it("keeps a tag's own hash slot when it's free, and uses the attachments' slot last", () => {
    const names = Array.from({ length: 200 }, (_, i) => `t${i}`);
    const free = names.find((name) => paletteIndex(name) !== ATTACHMENT_PALETTE_INDEX)!;
    expect(tagColorSlots(pages({ [free]: 2 })).get(free)).toBe(paletteIndex(free));
    const onAttachment = names.find((name) => paletteIndex(name) === ATTACHMENT_PALETTE_INDEX)!;
    expect(tagColorSlots(pages({ [onAttachment]: 2 })).get(onAttachment)).not.toBe(ATTACHMENT_PALETTE_INDEX);
    // Nine tags never take it; a tenth does.
    const nine = names.slice(0, 9);
    expect([...tagColorSlots(pages(Object.fromEntries(nine.map((tag) => [tag, 1])))).values()]).not.toContain(ATTACHMENT_PALETTE_INDEX);
    const ten = names.slice(0, 10);
    expect([...tagColorSlots(pages(Object.fromEntries(ten.map((tag) => [tag, 1])))).values()].sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("is stable: the same pages in any order give the same slots", () => {
    const spec = { money: 4, reading: 3, work: 5, travel: 1, ideas: 2 };
    const forward = tagColorSlots(pages(spec));
    const shuffled = tagColorSlots([...pages(spec)].reverse());
    expect([...shuffled.entries()].sort()).toEqual([...forward.entries()].sort());
  });

  it("only the 10 most used tags are kept apart; the rest keep their hash slot", () => {
    const spec = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, 20 - i]));
    const slots = tagColorSlots(pages(spec));
    expect(new Set(Array.from({ length: 10 }, (_, i) => slots.get(`k${i}`))).size).toBe(10);
    expect(slots.get("k11")).toBe(paletteIndex("k11"));
  });

  it("counts first tags only, case-insensitively", () => {
    const slots = tagColorSlots([{ tags: ["Work", "money"] }, { tags: ["work"] }]);
    expect([...slots.keys()]).toEqual(["work"]);
    expect(tagSlot("WORK", slots)).toBe(slots.get("work"));
  });
});

describe("the legend and the canvas agree", () => {
  it("the legend lists the tags that colour nodes, most first, and nodeColor draws each in its slot", () => {
    const nodes = pages({ money: 1, reading: 3, work: 2 });
    expect(colouringTags(nodes)).toEqual(["reading", "work", "money"]);
    const slots = tagColorSlots(nodes);
    for (const tag of ["money", "reading", "work"]) {
      expect(nodeColor({ tags: [tag] } as never, FALLBACK_GRAPH_PALETTE, "#000", slots)).toBe(FALLBACK_GRAPH_PALETTE[tagSlot(tag, slots)]);
    }
  });
});

/** A small seeded generator, so the vaults below are the same on every run. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

describe("tag colours stay put (#cp7xvwjc review)", () => {
  it("tagging one page with a new tag never changes an existing tag's colour (400 vaults)", () => {
    const next = random(7);
    const words = Array.from({ length: 60 }, (_, i) => `t${i.toString(36)}${Math.floor(next() * 1e6).toString(36)}`);
    let moved = 0;
    for (let vault = 0; vault < 400; vault += 1) {
      const count = 3 + Math.floor(next() * 5);
      const tags = [...new Set(Array.from({ length: count }, () => words[Math.floor(next() * words.length)]!))];
      const spec = Object.fromEntries(tags.map((tag) => [tag, 2 + Math.floor(next() * 8)]));
      const before = tagColorSlots(pages(spec));
      const fresh = words.find((word) => !(word in spec))!;
      const after = tagColorSlots(pages({ ...spec, [fresh]: 1 }));
      for (const tag of tags) if (after.get(tag) !== before.get(tag)) moved += 1;
    }
    expect(moved).toBe(0);
  });

  it("tags beyond the 10th never take the attachments' slot", () => {
    const names = Array.from({ length: 400 }, (_, i) => `tag${i}`);
    const onFiles = names.filter((name) => paletteIndex(name) === ATTACHMENT_PALETTE_INDEX).slice(0, 3);
    const others = names.filter((name) => !onFiles.includes(name)).slice(0, 10);
    // Ten well-used tags take the ten slots; the three that hash to the files' slot are used once each.
    const slots = tagColorSlots(pages({ ...Object.fromEntries(others.map((tag) => [tag, 5])), ...Object.fromEntries(onFiles.map((tag) => [tag, 1])) }));
    for (const tag of onFiles) expect(slots.get(tag)).not.toBe(ATTACHMENT_PALETTE_INDEX);
  });

  it("the counts' key changes only with the counts, not with the order of the pages", () => {
    const a = firstTagCounts([{ tags: ["x"] }, { tags: ["y"] }, { tags: ["x"] }]);
    const b = firstTagCounts([{ tags: ["y"] }, { tags: ["X"] }, { tags: ["x"] }]);
    expect(firstTagCountsKey(a)).toBe(firstTagCountsKey(b));
    expect(firstTagCountsKey(firstTagCounts([{ tags: ["x"] }]))).not.toBe(firstTagCountsKey(a));
  });

  it("the app's slots from the page list are the graph model's slots for the same vault", () => {
    const meta = (id: string, tags: string[], kind: PageMeta["kind"] = "page"): PageMeta => ({ id, kind, title: id, tags, parentId: null, childCount: 0, created: "", updated: "" });
    const list: PageMeta[] = [
      meta("A", ["Work", "x"]),
      meta("B", ["work"]),
      meta("C", ["money"]),
      meta("D", ["reading", "money"]),
      meta("E", []),
      meta("Plan.canvas", [], "whiteboard"),
      meta("Folder", [], "folder"),
    ];
    const data: GraphData = {
      nodes: list.filter((item) => item.kind !== "folder").map((item) => ({ ...item, linkCount: 0 })),
      links: [],
      tags: ["money", "reading", "Work", "work", "x"],
      unresolved: [],
    } as unknown as GraphData;
    const fromGraph = tagColorSlots(buildGraphModel(data).nodes);
    const fromList = tagColorSlotsFromCounts(firstTagCounts(list));
    expect([...fromList.entries()].sort()).toEqual([...fromGraph.entries()].sort());
  });
});
