import { useEffect, useState } from "react";
import { Icon, type IconName } from "./Icon.js";
import {
  applyThemePreference,
  browserStorage,
  loadThemePreference,
  nextThemePreference,
  saveThemePreference,
  systemPrefersDark,
  themeLabel,
  type ThemePreference,
} from "../lib/theme.js";

const ICONS: Record<ThemePreference, IconName> = {
  system: "monitor",
  light: "sun",
  dark: "moon",
};

/** Topbar toggle: System → Light → Dark, persisted in localStorage. */
export function ThemeToggle() {
  const [preference, setPreference] = useState<ThemePreference>(() =>
    loadThemePreference(browserStorage()),
  );

  // Keep the document in sync with the saved preference and, in System mode,
  // with live OS theme changes.
  useEffect(() => {
    const apply = () => applyThemePreference(preference, systemPrefersDark());
    apply();
    if (preference !== "system" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    query.addEventListener?.("change", apply);
    return () => query.removeEventListener?.("change", apply);
  }, [preference]);

  const cycle = () => {
    const next = nextThemePreference(preference);
    // Apply before the state update so the click never paints an old theme.
    applyThemePreference(next, systemPrefersDark());
    saveThemePreference(browserStorage(), next);
    setPreference(next);
  };

  const label = themeLabel(preference);

  return (
    <button
      type="button"
      className="icon-button theme-toggle"
      data-testid="theme-toggle"
      data-tooltip={label}
      aria-label={label}
      onClick={cycle}
    >
      <span aria-hidden="true">
        <Icon name={ICONS[preference]} size={16} />
      </span>
    </button>
  );
}
