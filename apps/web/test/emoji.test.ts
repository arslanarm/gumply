import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMOJI_CATEGORIES,
  findEmoji,
  firstEmoji,
  loadEmojiData,
  searchEmoji,
  type EmojiEntry,
} from "../src/lib/emoji/data";
import { moveInGrid } from "../src/lib/emoji/grid-nav";
import { getRecentEmoji, pushRecentEmoji, RECENT_EMOJI_LIMIT } from "../src/lib/emoji/recent";

let all: EmojiEntry[];

beforeEach(async () => {
  all = await loadEmojiData();
});

const top = (query: string, n = 1) =>
  searchEmoji(all, query)
    .slice(0, n)
    .map((entry) => entry.emoji);

describe("emoji data", () => {
  it("has the full standard set in every category", () => {
    expect(all.length).toBeGreaterThan(1800);
    for (const category of EMOJI_CATEGORIES) {
      expect(all.some((entry) => entry.category === category.id)).toBe(true);
    }
    expect(new Set(all.map((entry) => entry.emoji)).size).toBe(all.length);
    // No bare skin-tone swatches or regional-indicator letters.
    expect(all.some((entry) => entry.emoji === "🏽")).toBe(false);
    expect(all.some((entry) => entry.name.startsWith("regional indicator"))).toBe(false);
  });

  it("keeps the standard order (smileys first, flags last)", () => {
    expect(all[0]?.emoji).toBe("😀");
    expect(all[0]?.category).toBe("smileys");
    expect(all.at(-1)?.category).toBe("flags");
  });

  it("finds an emoji with or without the presentation selector", () => {
    expect(findEmoji(all, "❤️")?.name).toBe("red heart");
    expect(findEmoji(all, "❤")?.name).toBe("red heart");
  });
});

describe("searchEmoji", () => {
  it("finds by name", () => {
    expect(top("rocket")).toEqual(["🚀"]);
    expect(top("heart")).toEqual(["❤️"]);
    expect(top("thumbs up")).toEqual(["👍"]);
  });

  it("finds by shortcode, with or without colons", () => {
    expect(top(":+1:")).toEqual(["👍"]);
    expect(top("tada")).toEqual(["🎉"]);
    expect(top(":fire")).toEqual(["🔥"]);
  });

  it("finds by keyword and prefix", () => {
    expect(searchEmoji(all, "launch").map((entry) => entry.emoji)).toContain("🚀");
    expect(top("roc", 5)).toContain("🚀");
    expect(searchEmoji(all, "pizz").map((entry) => entry.emoji)).toContain("🍕");
  });

  it("requires every word and is case-insensitive", () => {
    expect(top("RED HEART")).toEqual(["❤️"]);
    expect(searchEmoji(all, "rocket banana")).toEqual([]);
  });

  it("returns nothing for empty or unmatched queries", () => {
    expect(searchEmoji(all, "   ")).toEqual([]);
    expect(searchEmoji(all, "zzqqxx")).toEqual([]);
  });

  it("honours the limit", () => {
    expect(searchEmoji(all, "face", 5)).toHaveLength(5);
  });
});

describe("firstEmoji", () => {
  it("returns a whole grapheme, including ZWJ, skin tone, flag and keycap", () => {
    expect(firstEmoji("🚀")).toBe("🚀");
    expect(firstEmoji(" 👩🏽‍💻 rest")).toBe("👩🏽‍💻");
    expect(firstEmoji("🇯🇵")).toBe("🇯🇵");
    expect(firstEmoji("1️⃣")).toBe("1️⃣");
    expect(firstEmoji("❤️")).toBe("❤️");
  });

  it("rejects plain text, digits and symbols", () => {
    expect(firstEmoji("hello")).toBeNull();
    expect(firstEmoji("1")).toBeNull();
    expect(firstEmoji("#")).toBeNull();
    expect(firstEmoji("")).toBeNull();
    expect(firstEmoji("a🚀")).toBeNull();
  });
});

describe("moveInGrid", () => {
  // Two sections: 12 items (rows of 5: 5,5,2) then 7 items (5,2).
  const sizes = [12, 7];

  it("moves left/right across the whole list and clamps", () => {
    expect(moveInGrid(sizes, 5, 0, "ArrowLeft")).toBe(0);
    expect(moveInGrid(sizes, 5, 11, "ArrowRight")).toBe(12);
    expect(moveInGrid(sizes, 5, 18, "ArrowRight")).toBe(18);
  });

  it("moves down within a section and into the next one keeping the column", () => {
    expect(moveInGrid(sizes, 5, 3, "ArrowDown")).toBe(8);
    // Row 2 has only 2 items: column 3 clamps to the last item.
    expect(moveInGrid(sizes, 5, 8, "ArrowDown")).toBe(11);
    // From the short last row into section 2, same column.
    expect(moveInGrid(sizes, 5, 11, "ArrowDown")).toBe(13);
    expect(moveInGrid(sizes, 5, 17, "ArrowDown")).toBe(17);
  });

  it("moves up into the previous section's last row", () => {
    expect(moveInGrid(sizes, 5, 14, "ArrowUp")).toBe(11);
    expect(moveInGrid(sizes, 5, 12, "ArrowUp")).toBe(10);
    expect(moveInGrid(sizes, 5, 2, "ArrowUp")).toBe(2);
  });

  it("starts from the first item when nothing is active", () => {
    expect(moveInGrid(sizes, 5, -1, "ArrowDown")).toBe(0);
    expect(moveInGrid([], 5, -1, "ArrowDown")).toBe(-1);
  });
});

describe("recent emoji", () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the most recent first without duplicates", () => {
    pushRecentEmoji("🚀");
    pushRecentEmoji("🎉");
    pushRecentEmoji("🚀");
    expect(getRecentEmoji()).toEqual(["🚀", "🎉"]);
  });

  it("caps the list", () => {
    for (let i = 0; i < RECENT_EMOJI_LIMIT + 5; i += 1) pushRecentEmoji(String(i));
    expect(getRecentEmoji()).toHaveLength(RECENT_EMOJI_LIMIT);
  });

  it("survives corrupt storage", () => {
    store.set("gumply:recent-emoji", "{not json");
    expect(getRecentEmoji()).toEqual([]);
    store.set("gumply:recent-emoji", JSON.stringify([1, "🎉", null]));
    expect(getRecentEmoji()).toEqual(["🎉"]);
  });
});
