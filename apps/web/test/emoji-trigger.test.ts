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
