/**
 * v0.9 F (#if236h9k): page font and width, and what opens on startup. Stored
 * per device under `gumply:*` keys, so the desktop app's UI-state mirror
 * (#c7fzzxk8) keeps them across launches; never in the vault (D37).
 */
import { browserStorage, type ThemeStorage } from "./theme.js";

export type PageFont = "default" | "serif" | "mono";
export type PageWidth = "normal" | "wide" | "full";
export type StartupMode = "last" | "page" | "daily";

export const PAGE_FONTS: readonly PageFont[] = ["default", "serif", "mono"];
export const PAGE_WIDTHS: readonly PageWidth[] = ["normal", "wide", "full"];
export const STARTUP_MODES: readonly StartupMode[] = ["last", "page", "daily"];

const FONT_KEY = "gumply:page-font";
const WIDTH_KEY = "gumply:page-width";
const STARTUP_KEY = "gumply:startup";
const STARTUP_PAGE_KEY = "gumply:startup-page";
const LAST_PAGE_KEY = "gumply:last-page";

function read(storage: ThemeStorage | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(storage: ThemeStorage | null, key: string, value: string | null): void {
  try {
    if (!storage) return;
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
  } catch {
    // Private mode / blocked storage: the choice still applies for this session.
  }
}

export function loadPageFont(storage: ThemeStorage | null = browserStorage()): PageFont {
  const value = read(storage, FONT_KEY);
  return value === "serif" || value === "mono" ? value : "default";
}

export function loadPageWidth(storage: ThemeStorage | null = browserStorage()): PageWidth {
  const value = read(storage, WIDTH_KEY);
  return value === "wide" || value === "full" ? value : "normal";
}

export function savePageFont(font: PageFont, storage: ThemeStorage | null = browserStorage()): void {
  write(storage, FONT_KEY, font === "default" ? null : font);
}

export function savePageWidth(width: PageWidth, storage: ThemeStorage | null = browserStorage()): void {
  write(storage, WIDTH_KEY, width === "normal" ? null : width);
}

/** Write the choices onto the document root; CSS applies them to page content only. */
export function applyPageAppearance(
  font: PageFont = loadPageFont(),
  width: PageWidth = loadPageWidth(),
  root: { dataset: DOMStringMap } = document.documentElement,
): void {
  root.dataset.pageFont = font;
  root.dataset.pageWidth = width;
}

/** Save and apply a font (Settings, Cmd+K #snuin2ja); the width stays as saved. */
export function choosePageFont(font: PageFont): void {
  savePageFont(font);
  applyPageAppearance(font, loadPageWidth());
}

/** Save and apply a page width; the font stays as saved. */
export function choosePageWidth(width: PageWidth): void {
  savePageWidth(width);
  applyPageAppearance(loadPageFont(), width);
}

export function loadStartupMode(storage: ThemeStorage | null = browserStorage()): StartupMode {
  const value = read(storage, STARTUP_KEY);
  return value === "page" || value === "daily" ? value : "last";
}

export function saveStartupMode(mode: StartupMode, storage: ThemeStorage | null = browserStorage()): void {
  write(storage, STARTUP_KEY, mode === "last" ? null : mode);
}

/** A page id per vault (keyed by the vault's path): a chosen page belongs to one vault. */
function readPerVault(storage: ThemeStorage | null, key: string): Record<string, string> {
  try {
    const parsed = JSON.parse(read(storage, key) ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return {};
  }
}

function writePerVault(storage: ThemeStorage | null, key: string, vault: string, id: string | null): void {
  const map = readPerVault(storage, key);
  if (id === null) delete map[vault];
  else map[vault] = id;
  // Keep the entry small: at most 20 vaults remembered.
  const entries = Object.entries(map).slice(-20);
  write(storage, key, entries.length > 0 ? JSON.stringify(Object.fromEntries(entries)) : null);
}

export function loadStartupPage(vault: string, storage: ThemeStorage | null = browserStorage()): string | null {
  return readPerVault(storage, STARTUP_PAGE_KEY)[vault] ?? null;
}

export function saveStartupPage(vault: string, id: string | null, storage: ThemeStorage | null = browserStorage()): void {
  writePerVault(storage, STARTUP_PAGE_KEY, vault, id);
}

export function loadLastPage(vault: string, storage: ThemeStorage | null = browserStorage()): string | null {
  return readPerVault(storage, LAST_PAGE_KEY)[vault] ?? null;
}

export function saveLastPage(vault: string, id: string, storage: ThemeStorage | null = browserStorage()): void {
  if (readPerVault(storage, LAST_PAGE_KEY)[vault] === id) return;
  writePerVault(storage, LAST_PAGE_KEY, vault, id);
}

/**
 * #chbpc9yb: `id` after the page `from` became `to` (a rename or a move; ids
 * are paths, so a sub-page's id changes with its parent's).
 */
export function remapPageId(id: string, from: string, to: string): string {
  if (id === from) return to;
  if (id.startsWith(`${from}/`)) return `${to}${id.slice(from.length)}`;
  return id;
}

/**
 * #chbpc9yb: the chosen startup page and the last opened page follow a rename
 * or move, as links do. Returns the startup page's id now (null when none).
 */
export function followPageInStorage(vault: string, from: string, to: string, storage: ThemeStorage | null = browserStorage()): string | null {
  const chosen = loadStartupPage(vault, storage);
  if (chosen !== null && remapPageId(chosen, from, to) !== chosen) saveStartupPage(vault, remapPageId(chosen, from, to), storage);
  const last = loadLastPage(vault, storage);
  if (last !== null && remapPageId(last, from, to) !== last) saveLastPage(vault, remapPageId(last, from, to), storage);
  return loadStartupPage(vault, storage);
}

/**
 * What to open when the app starts without a page in the URL (#if236h9k).
 * A new vault's welcome page wins; then the setting: today's daily note, the
 * chosen page (if it still exists, else the last one), the last opened page (if
 * it still exists); otherwise `fallback` (Welcome or the first page).
 */
export type StartupTarget = { kind: "page"; id: string } | { kind: "daily" } | { kind: "none" };

export function startupTarget(input: {
  ids: ReadonlySet<string>;
  newVaultPage: string | null;
  mode: StartupMode;
  chosen: string | null;
  last: string | null;
  fallback: string | null;
}): StartupTarget {
  if (input.newVaultPage && input.ids.has(input.newVaultPage)) return { kind: "page", id: input.newVaultPage };
  if (input.mode === "daily") return { kind: "daily" };
  if (input.mode === "page" && input.chosen && input.ids.has(input.chosen)) return { kind: "page", id: input.chosen };
  if (input.last && input.ids.has(input.last)) return { kind: "page", id: input.last };
  return input.fallback ? { kind: "page", id: input.fallback } : { kind: "none" };
}
