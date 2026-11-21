import { describe, expect, it } from "vitest";
import { paint, parseCssColor } from "../src/board/export/color";

describe("export colours for any SVG viewer (#yewapn9k)", () => {
  it("parses the forms computed styles produce", () => {
    expect(parseCssColor("rgb(10, 20, 30)")).toEqual({ r: 10, g: 20, b: 30, a: 1 });
    expect(parseCssColor("rgba(10, 20, 30, 0.5)")).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
    expect(parseCssColor("rgb(10 20 30 / 6%)")).toEqual({ r: 10, g: 20, b: 30, a: 0.06 });
    expect(parseCssColor("#ff8800")).toEqual({ r: 255, g: 136, b: 0, a: 1 });
    expect(parseCssColor("#f80")).toEqual({ r: 255, g: 136, b: 0, a: 1 });
    expect(parseCssColor("transparent")?.a).toBe(0);
    // What `color-mix()` computes to: the default frame fill that librsvg drew black.
    const mixed = parseCssColor("color(srgb 0.168627 0.164706 0.14902 / 0.035)")!;
    expect(Math.round(mixed.r)).toBe(43);
    expect(Math.round(mixed.g)).toBe(42);
    expect(Math.round(mixed.b)).toBe(38);
    expect(mixed.a).toBeCloseTo(0.035);
    expect(parseCssColor("oklch(0.7 0.1 200)")).toBeNull();
  });

  it("writes plain rgb() with a separate opacity, never CSS Color 4 syntax", () => {
    expect(paint("fill", "color(srgb 0.168627 0.164706 0.14902 / 0.035)")).toBe(' fill="rgb(43, 42, 38)" fill-opacity="0.035"');
    expect(paint("stroke", "rgba(0, 0, 0, 0.5)", 0.5)).toBe(' stroke="rgb(0, 0, 0)" stroke-opacity="0.25"');
    expect(paint("fill", "rgb(1, 2, 3)")).toBe(' fill="rgb(1, 2, 3)"');
    expect(paint("fill", "transparent")).toBe(' fill="none"');
    expect(paint("fill", "none")).toBe(' fill="none"');
    expect(paint("stroke", "url(#gradient)")).toBe(' stroke="none"');
  });
});
