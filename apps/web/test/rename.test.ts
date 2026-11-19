import { describe, expect, it } from "vitest";
import { openPageNeedsReload } from "../src/lib/rename.js";

describe("openPageNeedsReload", () => {
  it("reloads when the open page had links rewritten", () => {
    expect(openPageNeedsReload(["source", "other"], "source", "target")).toBe(true);
  });

  it("does not reload unrelated open pages", () => {
    expect(openPageNeedsReload(["source"], "unrelated", "target")).toBe(false);
  });

  it("never reloads the page being renamed", () => {
    expect(openPageNeedsReload(["target"], "target", "target")).toBe(false);
  });

  it("does nothing when no page is open", () => {
    expect(openPageNeedsReload(["source"], null, "target")).toBe(false);
  });

  it("falls back to reloading when the server omits rewrittenPages", () => {
    expect(openPageNeedsReload(undefined, "source", "target")).toBe(true);
    expect(openPageNeedsReload(undefined, null, "target")).toBe(false);
  });
});
