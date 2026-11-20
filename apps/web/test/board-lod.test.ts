import { describe, expect, it } from "vitest";
import { LOD_HYSTERESIS, lodLevel, textBucket } from "../src/board/lod";

describe("board level of detail (#bdzcggf5)", () => {
  it("buckets text by font size (13 / 16 / 20 / 24 / 28 px)", () => {
    expect(textBucket(10)).toBe("1");
    expect(textBucket(13)).toBe("1");
    expect(textBucket(15)).toBe("2");
    expect(textBucket(16)).toBe("2");
    expect(textBucket(20)).toBe("3");
    expect(textBucket(24)).toBe("4");
    expect(textBucket(28)).toBe("5");
    expect(textBucket(40)).toBe("5");
  });

  it("turns a bucket into bars once its largest text would be 4px or less on screen", () => {
    expect(lodLevel(1)).toBe(0);
    expect(lodLevel(0.4)).toBe(0);
    // 13px × 0.30 = 3.9px: bucket 1 goes; 16px × 0.30 = 4.8px stays.
    expect(lodLevel(0.3)).toBe(1);
    // 16px × 0.24 = 3.84px: bucket 2 too; 20px × 0.24 = 4.8px stays.
    expect(lodLevel(0.24)).toBe(2);
    // 24px × 0.15 = 3.6px: buckets 1–4; 28px × 0.15 = 4.2px stays.
    expect(lodLevel(0.15)).toBe(4);
    // 28px × 0.14 = 3.9px: everything is bars.
    expect(lodLevel(0.14)).toBe(5);
  });

  it("brings text back only once clearly legible (no flicker at the threshold)", () => {
    const threshold = 4 / 13;
    expect(lodLevel(threshold, 0)).toBe(1);
    // Just above the threshold: stays bars when it already was…
    expect(lodLevel(threshold * 1.05, 1)).toBe(1);
    // …but is real text when coming from further in.
    expect(lodLevel(threshold * 1.05, 0)).toBe(0);
    expect(lodLevel(threshold * LOD_HYSTERESIS * 1.01, 1)).toBe(0);
    // Zooming in from all bars steps back bucket by bucket.
    expect(lodLevel((4 / 28) * 1.05, 5)).toBe(5);
    expect(lodLevel((4 / 16) * 1.2, 5)).toBe(1);
  });
});
