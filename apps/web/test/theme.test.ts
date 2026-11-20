import { describe, expect, it } from "vitest";
import {
  applyThemePreference,
  loadThemePreference,
  nextThemePreference,
  parseThemePreference,
  resolveTheme,
  saveThemePreference,
  THEME_STORAGE_KEY,
  themeLabel,
  type ThemePreference,
  type ThemeStorage,
} from "../src/lib/theme.js";

function fakeStorage(initial: Record<string, string> = {}): ThemeStorage & {
  values: Map<string, string>;
} {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

describe("theme preference", () => {
  it("defaults to system and ignores unknown saved values", () => {
    expect(parseThemePreference(null)).toBe("system");
    expect(parseThemePreference("")).toBe("system");
    expect(parseThemePreference("sepia")).toBe("system");
    expect(parseThemePreference("light")).toBe("light");
    expect(parseThemePreference("dark")).toBe("dark");
    expect(loadThemePreference(fakeStorage())).toBe("system");
  });

  it("cycles System → Light → Dark → System", () => {
    expect(nextThemePreference("system")).toBe("light");
    expect(nextThemePreference("light")).toBe("dark");
    expect(nextThemePreference("dark")).toBe("system");
  });

  it("resolves system against the OS preference and keeps explicit choices", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("persists light/dark and removes the key for system", () => {
    const storage = fakeStorage();
    saveThemePreference(storage, "light");
    expect(storage.values.get(THEME_STORAGE_KEY)).toBe("light");
    saveThemePreference(storage, "dark");
    expect(storage.values.get(THEME_STORAGE_KEY)).toBe("dark");
    saveThemePreference(storage, "system");
    expect(storage.values.has(THEME_STORAGE_KEY)).toBe(false);
    expect(loadThemePreference(storage)).toBe("system");
  });

  it("survives blocked storage", () => {
    const blocked: ThemeStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadThemePreference(blocked)).toBe("system");
    expect(() => saveThemePreference(blocked, "dark")).not.toThrow();
  });

  it("writes the resolved theme to data-theme and labels the current mode", () => {
    const root = {
      dataset: {} as DOMStringMap,
      style: { colorScheme: "" } as CSSStyleDeclaration,
    };
    expect(applyThemePreference("system", true, root)).toBe("dark");
    expect(root.dataset.theme).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");
    expect(applyThemePreference("system", false, root)).toBe("light");
    expect(root.dataset.theme).toBe("light");
    expect(root.style.colorScheme).toBe("light");
    expect(applyThemePreference("dark", false, root)).toBe("dark");
    expect(root.dataset.theme).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");

    const labels: ThemePreference[] = ["system", "light", "dark"];
    expect(labels.map(themeLabel)).toEqual(["Theme: System", "Theme: Light", "Theme: Dark"]);
  });
});
