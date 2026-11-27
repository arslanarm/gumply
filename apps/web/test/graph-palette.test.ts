import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FALLBACK_GRAPH_PALETTE } from "../src/graph/graph-model";
import { nextGroupColor } from "../src/graph/graph-settings";

/**
 * #yy347xgi (9): the graph's tag colours read apart: every pair differs by at least a set ΔE (CIE76 in Lab), light
 * and dark, so neighbouring topics (#garden/#travel, #daily/#cooking in the hunt) don't look alike. And (6): a new
 * group takes a colour no group or tag uses yet.
 */

function lab(hex: string): [number, number, number] {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [1, 3, 5].map((i) => lin(Number.parseInt(hex.slice(i, i + 2), 16))) as [number, number, number];
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
const deltaE = (a: string, b: string) => Math.hypot(...lab(a).map((value, i) => value - lab(b)[i]!));
const closest = (palette: readonly string[]) => {
  let min = Number.POSITIVE_INFINITY;
  for (let i = 0; i < palette.length; i += 1) for (let j = i + 1; j < palette.length; j += 1) min = Math.min(min, deltaE(palette[i]!, palette[j]!));
  return min;
};
function themePalette(theme: "light" | "dark"): string[] {
  const css = readFileSync(join(__dirname, "../src/styles.css"), "utf8");
  const blocks = [...css.matchAll(/--graph-(\d): (#[0-9a-f]{6});/gi)].map((match) => [Number(match[1]), match[2]!] as const);
  const first = blocks.slice(0, 10);
  const second = blocks.slice(10, 20);
  return (theme === "light" ? first : second).sort((a, b) => a[0] - b[0]).map(([, hex]) => hex.toLowerCase());
}

describe("graph tag colours read apart (#yy347xgi (9))", () => {
  it("light: every pair at least ΔE 25 apart (it was 18.5: #3f7a34 against #6b7a2a)", () => {
    expect(themePalette("light")).toEqual(FALLBACK_GRAPH_PALETTE.map((hex) => hex.toLowerCase()));
    expect(closest(FALLBACK_GRAPH_PALETTE)).toBeGreaterThanOrEqual(25);
  });

  it("dark: every pair at least ΔE 22 apart (it was 21.9)", () => {
    expect(themePalette("dark")).toHaveLength(10);
    expect(closest(themePalette("dark"))).toBeGreaterThanOrEqual(22);
  });
});

describe("a new group's colour (#yy347xgi (6))", () => {
  it("skips the colours groups and tags already use", () => {
    const palette = FALLBACK_GRAPH_PALETTE;
    expect(nextGroupColor([], palette)).toBe(palette[0]);
    // A tag colours with palette[0] (and a group has palette[1]): the new group takes palette[2].
    expect(nextGroupColor([palette[1]!, palette[0]!], palette)).toBe(palette[2]);
  });
});
