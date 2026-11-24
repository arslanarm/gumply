import { describe, expect, it, vi } from "vitest";
import { focusMainRegion, isFocusReturnTarget } from "../src/lib/focus-fallback.js";

/*
 * #fw97pkjh: focus never goes back to <body>. Run on small stand-ins for the
 * DOM (the unit setup has none); modal-focus.spec checks it in the app.
 */
const body = { tag: "BODY" };
const doc = { body };

function element(options: { connected?: boolean; tabindex?: string | null } = {}) {
  const attrs = new Map<string, string>();
  if (options.tabindex !== undefined && options.tabindex !== null) attrs.set("tabindex", options.tabindex);
  return {
    isConnected: options.connected ?? true,
    ownerDocument: doc,
    get tabIndex() {
      return attrs.has("tabindex") ? Number(attrs.get("tabindex")) : -1;
    },
    hasAttribute: (name: string) => attrs.has(name),
    setAttribute: (name: string, value: string) => void attrs.set(name, value),
    getAttribute: (name: string) => attrs.get(name) ?? null,
    focus: vi.fn(),
  };
}

describe("where focus may go back to", () => {
  it("an element still on the page, never <body> or nothing", () => {
    expect(isFocusReturnTarget(element() as never)).toBe(true);
    expect(isFocusReturnTarget(element({ connected: false }) as never)).toBe(false);
    const bodyElement = { isConnected: true, ownerDocument: doc, focus: () => {} };
    (doc as { body: unknown }).body = bodyElement;
    expect(isFocusReturnTarget(bodyElement as never)).toBe(false);
    (doc as { body: unknown }).body = body;
    expect(isFocusReturnTarget(null)).toBe(false);
  });
});

describe("the main region fallback", () => {
  it("focuses the view's heading, made focusable without joining Tab order", () => {
    const heading = element();
    const main = { querySelector: () => heading };
    const fake = { querySelector: (selector: string) => (selector === "main.content" ? main : null) };
    expect(focusMainRegion(fake as never)).toBe(true);
    expect(heading.getAttribute("tabindex")).toBe("-1");
    expect(heading.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("with no heading, the region itself; an element already focusable keeps its tabindex", () => {
    const main = Object.assign(element({ tabindex: "0" }), { querySelector: () => null });
    const fake = { querySelector: () => main };
    expect(focusMainRegion(fake as never)).toBe(true);
    expect(main.getAttribute("tabindex")).toBe("0");
    expect(main.focus).toHaveBeenCalled();
  });

  it("no main region (nothing open): false, nothing focused", () => {
    expect(focusMainRegion({ querySelector: () => null } as never)).toBe(false);
  });
});
