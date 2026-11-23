import { describe, expect, it } from "vitest";
import { applyCombobox, COMBOBOX_ATTRIBUTES, listboxIdFrom, optionId } from "../src/lib/editor-combobox";

/** A minimal element: just the attribute calls the helper makes. */
function fakeElement(initial: Record<string, string> = {}) {
  const attrs = new Map(Object.entries(initial));
  return {
    attrs,
    setAttribute: (name: string, value: string) => void attrs.set(name, value),
    removeAttribute: (name: string) => void attrs.delete(name),
    getAttribute: (name: string) => attrs.get(name) ?? null,
  };
}

describe("the editor as a combobox while a suggestion menu is open (#5nykir64)", () => {
  it("open: combobox, expanded, controls the listbox, and points at the keyboard's option", () => {
    const element = fakeElement({ "aria-label": "Page content", class: "gumply-editor" });
    const listboxId = listboxIdFrom(":r3:", "slash");
    applyCombobox(element, { listboxId, activeId: optionId(listboxId, 2) });
    expect(Object.fromEntries(element.attrs)).toEqual({
      "aria-label": "Page content",
      class: "gumply-editor",
      role: "combobox",
      "aria-expanded": "true",
      "aria-controls": "r3-slash-listbox",
      "aria-activedescendant": "r3-slash-listbox-option-2",
      "aria-autocomplete": "list",
      "aria-haspopup": "listbox",
    });
  });

  it("an empty list: no active option", () => {
    const element = fakeElement();
    applyCombobox(element, { listboxId: "l", activeId: optionId("l", 0) });
    applyCombobox(element, { listboxId: "l", activeId: null });
    expect(element.attrs.has("aria-activedescendant")).toBe(false);
    expect(element.attrs.get("aria-expanded")).toBe("true");
  });

  it("closed: every combobox attribute is removed, the editor's own ones stay", () => {
    const element = fakeElement({ "aria-label": "Page content" });
    applyCombobox(element, { listboxId: "l", activeId: "l-option-0" });
    applyCombobox(element, null);
    expect(Object.fromEntries(element.attrs)).toEqual({ "aria-label": "Page content" });
    for (const name of COMBOBOX_ATTRIBUTES) expect(element.attrs.has(name)).toBe(false);
  });

  it("a textarea (board card text) keeps its textbox role and gets only textbox-valid attributes", () => {
    const element = fakeElement({ "data-testid": "board-text-editor" });
    applyCombobox(element, { listboxId: "b", activeId: optionId("b", 1) }, { textbox: true });
    expect(Object.fromEntries(element.attrs)).toEqual({
      "data-testid": "board-text-editor",
      "aria-controls": "b",
      "aria-activedescendant": "b-option-1",
      "aria-autocomplete": "list",
    });
    applyCombobox(element, null, { textbox: true });
    expect(Object.fromEntries(element.attrs)).toEqual({ "data-testid": "board-text-editor" });
  });
});
