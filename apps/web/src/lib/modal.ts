/**
 * One focus rule for every modal dialog (#vefk9dwg, WCAG 2.4.3; audit
 * `ux/a11y-audit-v0-9` P2 1–3):
 *
 * - **on open** focus moves inside: the dialog's own choice (its effects
 *   focus a control) or else the first tabbable control, else the dialog;
 * - **while open** the rest of the page is `inert` and Tab / Shift+Tab cycle
 *   within the top-most dialog, so `aria-modal="true"` is true;
 * - **on close** focus goes back to what opened it, unless the dialog moved
 *   focus somewhere on purpose (Cmd+K opening a page focuses its editor).
 *
 * Escape stays with each dialog: some only close when idle, or let an inner
 * confirmation take it first.
 *
 * `modal: false` (the Settings popover) keeps only the focus-in / focus-back
 * part: a popover neither traps Tab nor makes the page inert. `ownsTab` is for
 * palettes whose own Tab handling already keeps focus on their input (Cmd+K,
 * Move to, the template pickers).
 */
import { useLayoutEffect, type RefObject } from "react";
import { focusMainRegion, isFocusReturnTarget } from "./focus-fallback.js";

const TABBABLE = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "[tabindex]",
  '[contenteditable="true"]',
].join(",");

/** The controls Tab can reach inside `root`, in document order. */
export function tabbables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter((element) => {
    // A radio group is one Tab stop: its checked radio (or its first, when none is).
    if (element instanceof HTMLInputElement && element.type === "radio" && element.name) {
      const group = [...root.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(element.name)}"]`)];
      const stop = group.find((radio) => radio.checked) ?? group[0];
      if (stop !== element) return false;
    }
    if (element.tabIndex < 0) return false;
    if ((element as HTMLButtonElement).disabled) return false;
    if (element.closest("[inert]") && !root.closest("[inert]")) return false;
    if (element.getAttribute("aria-hidden") === "true") return false;
    // Hidden (display:none, collapsed details, zero size) can't take focus.
    return element.getClientRects().length > 0;
  });
}

/**
 * Where Tab goes from `current` (an index into the dialog's tabbables, or -1
 * when focus is elsewhere): wrap at both ends.
 */
export function cycleTarget(count: number, current: number, backwards: boolean): number {
  if (count === 0) return -1;
  if (current === -1) return backwards ? count - 1 : 0;
  if (backwards) return current === 0 ? count - 1 : -1;
  return current === count - 1 ? 0 : -1;
}

interface Focusable {
  readonly isConnected: boolean;
}

/**
 * The element to give focus back to: the opener if it is still on the page,
 * else the newest one in the focus history that is (a menu item that opened
 * the dialog is gone by then; the button that opened the menu isn't).
 */
export function returnTarget<T extends Focusable>(opener: T | null, history: readonly T[], exclude: (item: T) => boolean): T | null {
  if (opener && opener.isConnected && !exclude(opener)) return opener;
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i]!;
    if (item.isConnected && !exclude(item)) return item;
  }
  return null;
}

/* ---------------- focus history ---------------- */

const HISTORY_SIZE = 12;
const focusHistory: HTMLElement[] = [];
let listening = false;

function trackFocus(): void {
  if (listening || typeof document === "undefined") return;
  listening = true;
  document.addEventListener(
    "focusin",
    (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || target === document.body) return;
      const at = focusHistory.indexOf(target);
      if (at !== -1) focusHistory.splice(at, 1);
      focusHistory.push(target);
      if (focusHistory.length > HISTORY_SIZE) focusHistory.shift();
    },
    true,
  );
}

// From the start, so the first dialog already knows what had focus before it
// (the ⋯ button behind a menu item that is gone by the time the dialog opens).
trackFocus();

/* ---------------- inert ---------------- */

/** Toasts, status lines and alerts: they must stay announced while a modal is open. */
const LIVE_REGION = '[aria-live]:not([aria-live="off"]),[role="status"],[role="alert"],[role="log"]';

/** The path from `<body>`'s child down to `element`, top first. */
function chainOf(element: Element): HTMLElement[] {
  const chain: HTMLElement[] = [];
  for (let node: Element | null = element; node && node !== document.body; node = node.parentElement) {
    if (node instanceof HTMLElement) chain.unshift(node);
  }
  return chain;
}

/**
 * Make everything outside `dialog` inert: each sibling on the way up to
 * `<body>`. `inert` also hides content from assistive tech, so live regions
 * (a toast, the save status) are cut out of it: the inert container is split
 * around them, now and for any that appear while the dialog is open.
 * Returns the undo, which only touches what this call changed, so nested
 * dialogs restore in order.
 */
function inertOutside(dialog: HTMLElement): () => void {
  const changed = new Set<HTMLElement>();
  const makeInert = (element: Element) => {
    if (!(element instanceof HTMLElement) || element.inert) return;
    if (element.tagName === "SCRIPT" || element.tagName === "STYLE" || element.matches(LIVE_REGION)) return;
    element.inert = true;
    changed.add(element);
  };
  for (const node of chainOf(dialog)) {
    for (const sibling of node.parentElement?.children ?? []) if (sibling !== node) makeInert(sibling);
  }
  // Keep `region` exposed: lift the inert we set on its ancestor and make
  // that ancestor's other branches inert instead, level by level.
  const expose = (region: Element): boolean => {
    if (dialog.contains(region)) return false;
    const chain = chainOf(region);
    const top = chain.findIndex((node) => changed.has(node));
    if (top === -1) return false;
    chain[top]!.inert = false;
    changed.delete(chain[top]!);
    for (let level = top; level < chain.length - 1; level++) {
      for (const child of chain[level]!.children) if (child !== chain[level + 1]) makeInert(child);
    }
    return true;
  };
  // Splitting around one region can make another one's branch inert: repeat until stable.
  const exposeAll = (root: ParentNode) => {
    for (let pass = 0; pass < 10; pass++) {
      let moved = false;
      for (const region of root.querySelectorAll(LIVE_REGION)) moved = expose(region) || moved;
      if (!moved) return;
    }
  };
  exposeAll(document);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const added of record.addedNodes) {
        if (!(added instanceof Element)) continue;
        if (added.matches(LIVE_REGION) || added.querySelector(LIVE_REGION)) exposeAll(document);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  return () => {
    observer.disconnect();
    for (const element of changed) element.inert = false;
  };
}

/* ---------------- the stack of open modals ---------------- */

const stack: { dialog: HTMLElement; ownsTab: boolean }[] = [];

function onKeyDown(event: KeyboardEvent): void {
  if (event.key !== "Tab" || event.defaultPrevented) return;
  const entry = stack[stack.length - 1];
  if (!entry || entry.ownsTab || !entry.dialog.isConnected) return;
  const top = entry.dialog;
  const items = tabbables(top);
  if (items.length === 0) {
    event.preventDefault();
    top.focus();
    return;
  }
  const active = document.activeElement as HTMLElement | null;
  const index = active && top.contains(active) ? items.indexOf(active) : -1;
  // Inside, not at an end (or on a control the list doesn't count): let the browser move.
  if (active && top.contains(active) && index === -1) {
    if (active !== top) return;
  }
  const next = cycleTarget(items.length, index, event.shiftKey);
  if (next === -1) return;
  event.preventDefault();
  items[next]!.focus();
}

/**
 * Wire `ref` (the element with `role="dialog"`) as a modal while `active`.
 * Call it in the dialog component; when the component mounts only while
 * open, leave `active` at its default.
 */
export function useModal(
  ref: RefObject<HTMLElement | null>,
  { active = true, modal = true, ownsTab = false }: { active?: boolean; modal?: boolean; ownsTab?: boolean } = {},
): void {
  useLayoutEffect(() => {
    if (!active) return;
    const dialog = ref.current;
    if (!dialog) return;
    trackFocus();
    const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    const history = [...focusHistory];
    const undoInert = modal ? inertOutside(dialog) : () => {};
    if (modal) {
      stack.push({ dialog, ownsTab });
      if (stack.length === 1) document.addEventListener("keydown", onKeyDown, true);
    }
    // After the dialog's own effects have had their say about initial focus.
    queueMicrotask(() => {
      if (!dialog.isConnected || dialog.contains(document.activeElement)) return;
      const [first] = tabbables(dialog);
      if (first) first.focus();
      else {
        if (!dialog.hasAttribute("tabindex")) dialog.tabIndex = -1;
        dialog.focus();
      }
    });
    return () => {
      // Runs before React removes the dialog: focus is still where the user left it.
      const focus = document.activeElement;
      const handBack = !focus || focus === document.body || dialog.contains(focus);
      undoInert();
      if (modal) {
        for (let at = stack.length - 1; at >= 0; at--) {
          if (stack[at]!.dialog !== dialog) continue;
          stack.splice(at, 1);
          break;
        }
        if (stack.length === 0) document.removeEventListener("keydown", onKeyDown, true);
      }
      if (!handBack) return;
      const target = returnTarget(opener, history, (item) => dialog.contains(item) || item.closest("[inert]") !== null);
      if (target) target.focus({ preventScroll: true });
      // Nothing to go back to (opened with focus on <body>, or its opener is gone): the main
      // region, never <body> (#fw97pkjh). After the dialog is removed, so it doesn't count as inside.
      else queueMicrotask(() => {
        if (!isFocusReturnTarget(document.activeElement) || dialog.contains(document.activeElement)) focusMainRegion();
      });
    };
  }, [active, modal, ownsTab, ref]);
}
