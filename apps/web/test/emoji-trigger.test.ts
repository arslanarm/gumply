import { describe, expect, it } from "vitest";
import { findEmojiQuery } from "../src/editor/emoji/trigger.js";

describe("emoji `:` trigger (#6v8tyxfd)", () => {
  it("opens after two characters at a word start", () => {
    expect(findEmojiQuery(":ro")).toEqual({ query: "ro", colon: 0 });
    expect(findEmojiQuery("launch :rocket")).toEqual({ query: "rocket", colon: 7 });
    expect(findEmojiQuery("(:+1")).toEqual({ query: "+1", colon: 1 });
    expect(findEmojiQuery("“:tada")).toEqual({ query: "tada", colon: 1 });
  });

  it("waits for the second character", () => {
    expect(findEmojiQuery(":")).toBeNull();
    expect(findEmojiQuery("hi :r")).toBeNull();
  });

  it("ignores times, URLs and words with colons", () => {
    expect(findEmojiQuery("meet at 12:30")).toBeNull();
    expect(findEmojiQuery("see http:")).toBeNull();
    expect(findEmojiQuery("https://example.com/a:bc")).toBeNull();
    expect(findEmojiQuery("key:value")).toBeNull();
    expect(findEmojiQuery("C::std")).toBeNull();
  });

  it("stops at spaces and odd characters", () => {
    expect(findEmojiQuery(":not this")).toBeNull();
    expect(findEmojiQuery(":ro.")).toBeNull();
    expect(findEmojiQuery(":rocket:")).toBeNull();
  });
});

describe("emoji suggestions ranking", () => {
  it("puts recently used emoji first, keeping search order otherwise", async () => {
    const { rankEmoji } = await import("../src/editor/emoji/extension.js");
    const entry = (emoji: string) => ({ emoji, name: emoji, keywords: [], shortcodes: [], category: "objects", version: 1 }) as never;
    const results = [entry("a"), entry("b"), entry("c"), entry("d")];
    expect(rankEmoji(results, ["c", "z", "b"]).map((e: { emoji: string }) => e.emoji)).toEqual(["c", "b", "a", "d"]);
    expect(rankEmoji(results, [], 2).map((e: { emoji: string }) => e.emoji)).toEqual(["a", "b"]);
  });
});

describe("emoji suggestions use the real data", () => {
  it(":part offers 🎉 before 〽️, :rocket gives 🚀 first, :+1 gives 👍", async () => {
    const { rankEmoji } = await import("../src/editor/emoji/extension.js");
    const { loadEmojiData, searchEmoji } = await import("../src/lib/emoji/data.js");
    const entries = await loadEmojiData();
    const first = (q: string) => rankEmoji(searchEmoji(entries, q, 40), [])[0]?.emoji;
    const part = rankEmoji(searchEmoji(entries, "part", 40), []).map((e) => e.emoji);
    expect(part.indexOf("🎉")).toBeLessThan(part.indexOf("〽️"));
    expect(first("rocket")).toBe("🚀");
    expect(first("+1")).toBe("👍");
  });
});
