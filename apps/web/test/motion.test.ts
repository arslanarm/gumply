import { afterEach, describe, expect, it, vi } from "vitest";
import { motionMs, prefersReducedMotion, scrollBehavior } from "../src/lib/motion";

describe("reduced motion for script-driven animation (#jchhjepb)", () => {
  afterEach(() => vi.unstubAllGlobals());
  const prefer = (reduce: boolean) =>
    vi.stubGlobal("window", { matchMedia: (query: string) => ({ matches: reduce && query.includes("reduce") }) });

  it("keeps durations and smooth scrolling by default", () => {
    prefer(false);
    expect(prefersReducedMotion()).toBe(false);
    expect(motionMs(250)).toBe(250);
    expect(scrollBehavior()).toBe("smooth");
  });

  it("drops them when the user asks for less motion", () => {
    prefer(true);
    expect(prefersReducedMotion()).toBe(true);
    expect(motionMs(250)).toBe(0);
    expect(scrollBehavior()).toBe("auto");
  });

  it("without a window (server, tests) there is no preference", () => {
    expect(prefersReducedMotion()).toBe(false);
  });
});
