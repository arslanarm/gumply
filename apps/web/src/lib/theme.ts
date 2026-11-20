/**
 * Theme preference: follow the system by default, or force light/dark.
 * The inline script in index.html uses the same storage key so the first
 * paint is already correct (spec/ux §12).
 */

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "gumply:theme";

const ORDER: readonly ThemePreference[] = ["system", "light", "dark"];

export interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function parseThemePreference(value: string | null | undefined): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

/** System → Light → Dark → System (the topbar toggle order). */
export function nextThemePreference(current: ThemePreference): ThemePreference {
  const index = ORDER.indexOf(current);
  return ORDER[(index + 1) % ORDER.length] ?? "system";
}

export function resolveTheme(
  preference: ThemePreference,
  prefersDark: boolean,
): ResolvedTheme {
  if (preference === "system") return prefersDark ? "dark" : "light";
  return preference;
}

export function themeLabel(preference: ThemePreference): string {
  const name = preference === "system" ? "System" : preference === "light" ? "Light" : "Dark";
  return `Theme: ${name}`;
}

export function loadThemePreference(
  storage: ThemeStorage | null | undefined,
): ThemePreference {
  try {
    return parseThemePreference(storage?.getItem(THEME_STORAGE_KEY) ?? null);
  } catch {
    return "system";
  }
}

export function saveThemePreference(
  storage: ThemeStorage | null | undefined,
  preference: ThemePreference,
): void {
  try {
    if (!storage) return;
    if (preference === "system") storage.removeItem(THEME_STORAGE_KEY);
    else storage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Private mode / blocked storage: the theme still works for this session.
  }
}

export interface ThemeRoot {
  dataset: { theme?: string };
  style: { colorScheme: string };
}

/** Resolve and write `data-theme`; returns the concrete theme applied. */
export function applyThemePreference(
  preference: ThemePreference,
  prefersDark: boolean,
  root: ThemeRoot = document.documentElement,
): ResolvedTheme {
  const resolved = resolveTheme(preference, prefersDark);
  root.dataset.theme = resolved;
  // Keep the inline pre-paint color-scheme in sync for native controls.
  root.style.colorScheme = resolved;
  return resolved;
}

export function browserStorage(): ThemeStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : false;
}
