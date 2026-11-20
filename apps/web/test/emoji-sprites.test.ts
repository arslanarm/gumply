import { describe, expect, it } from "vitest";
import { emojiNodeSize, emojiSprite, normaliseIcon } from "../src/graph/emoji-sprites";

describe("graph page icons (#emmyabbj)", () => {
  it("uses the icon's first grapheme, keeping ZWJ and flag sequences whole", () => {
    expect(normaliseIcon("🚀")).toBe("🚀");
    expect(normaliseIcon(" 👩‍💻 ")).toBe("👩‍💻");
    expect(normaliseIcon("🇳🇱")).toBe("🇳🇱");
    expect(normaliseIcon("❤️")).toBe("❤️");
    expect(normaliseIcon("🚀🔥")).toBe("🚀");
  });

  it("treats a missing or blank icon as no icon", () => {
    expect(normaliseIcon(undefined)).toBeNull();
    expect(normaliseIcon(null)).toBeNull();
    expect(normaliseIcon("   ")).toBeNull();
  });

  it("draws emoji nodes bigger than their dot, still growing with links", () => {
    expect(emojiNodeSize(4)).toBe(14);
    expect(emojiNodeSize(9)).toBe(24);
    expect(emojiNodeSize(9)).toBeGreaterThan(emojiNodeSize(4));
  });

  it("has no sprite without a DOM (falls back to the dot)", () => {
    expect(emojiSprite("🚀")).toBeNull();
  });
});
