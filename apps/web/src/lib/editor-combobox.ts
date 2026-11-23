/**
 * #5nykir64 (a11y): while a suggestion listbox is open (slash, `[[` / `![[`,
 * `:` emoji), the editor's contenteditable is a combobox (WAI-ARIA 1.2
 * pattern): it says it's expanded, which listbox it controls and which option
 * the keyboard is on, so screen readers announce the options as the user
 * arrows through them. Focus stays in the text. When the menu closes,
 * everything is removed again.
 */

export interface ComboboxState {
  /** The open listbox's id. */
  listboxId: string;
  /** The keyboard's option, or null when there's none (an empty list). */
  activeId: string | null;
}

/** The attributes this module owns on the editor root. */
export const COMBOBOX_ATTRIBUTES = ["role", "aria-expanded", "aria-controls", "aria-activedescendant", "aria-autocomplete", "aria-haspopup"] as const;

export type ComboboxAttribute = (typeof COMBOBOX_ATTRIBUTES)[number];

/** An option's id in a listbox. */
export function optionId(listboxId: string, index: number): string {
  return `${listboxId}-option-${index}`;
}

/** A listbox id from React's `useId` (its colons would need escaping in selectors). */
export function listboxIdFrom(base: string, menu: string): string {
  return `${base.replace(/[^A-Za-z0-9_-]/g, "")}-${menu}-listbox`;
}

export interface ComboboxOptions {
  /**
   * A `<textarea>` (a board card's text): HTML allows it no role but textbox,
   * so it keeps that role and gets only what a textbox may carry
   * (`aria-autocomplete`, `aria-controls`, `aria-activedescendant`), which is
   * what makes a screen reader read the active option (#pujmbsyz).
   */
  textbox?: boolean;
}

/** What the editor root's combobox attributes are for `state` (null: removed). */
export function comboboxAttributes(state: ComboboxState | null, options: ComboboxOptions = {}): Record<ComboboxAttribute, string | null> {
  if (!state) return { role: null, "aria-expanded": null, "aria-controls": null, "aria-activedescendant": null, "aria-autocomplete": null, "aria-haspopup": null };
  if (options.textbox) {
    return {
      role: null,
      "aria-expanded": null,
      "aria-controls": state.listboxId,
      "aria-activedescendant": state.activeId,
      "aria-autocomplete": "list",
      "aria-haspopup": null,
    };
  }
  return {
    role: "combobox",
    "aria-expanded": "true",
    "aria-controls": state.listboxId,
    "aria-activedescendant": state.activeId,
    "aria-autocomplete": "list",
    "aria-haspopup": "listbox",
  };
}

/** Set (or remove) them on the editor root. ProseMirror ignores attribute changes on its root. */
export function applyCombobox(
  element: Pick<Element, "setAttribute" | "removeAttribute" | "getAttribute">,
  state: ComboboxState | null,
  options: ComboboxOptions = {},
): void {
  for (const [name, value] of Object.entries(comboboxAttributes(state, options))) {
    if (value === null) element.removeAttribute(name);
    else if (element.getAttribute(name) !== value) element.setAttribute(name, value);
  }
}
