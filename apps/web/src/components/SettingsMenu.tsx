/**
 * Settings popover (#7h5utv23): the interface language and the theme. The
 * topbar keeps its one-click theme toggle; this is the place for both, and
 * Cmd+K → "Language…" opens it too.
 */
import { useEffect, useRef, useState } from "react";
import { LANGUAGES, useLanguage, useT, type LanguagePreference } from "../i18n/index.js";
import { chooseLanguage, languagePreference } from "../i18n/preference.js";
import {
  applyThemePreference,
  browserStorage,
  loadThemePreference,
  saveThemePreference,
  systemPrefersDark,
  themeName,
  type ThemePreference,
} from "../lib/theme.js";
import { Icon } from "./Icon.js";

const THEMES: readonly ThemePreference[] = ["system", "light", "dark"];

export function SettingsMenu({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useT();
  // Re-render when the language changes (the selected option moves).
  useLanguage();
  const [language, setLanguagePreference] = useState<LanguagePreference>(languagePreference);
  const [theme, setTheme] = useState<ThemePreference>(() => loadThemePreference(browserStorage()));
  const ref = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    if (!open) return;
    setLanguagePreference(languagePreference());
    setTheme(loadThemePreference(browserStorage()));
    firstRef.current?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onOpenChange(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onOpenChange(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, onOpenChange]);

  const pickTheme = (next: ThemePreference) => {
    applyThemePreference(next, systemPrefersDark());
    saveThemePreference(browserStorage(), next);
    setTheme(next);
    // The topbar toggle reads the same storage; tell it.
    window.dispatchEvent(new CustomEvent("gumply:theme-changed"));
  };

  return (
    <div className="settings" ref={ref}>
      <button
        type="button"
        className={`icon-button${open ? " is-active" : ""}`}
        data-testid="settings-button"
        data-tooltip={t("settings.title")}
        aria-label={t("settings.title")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      >
        <Icon name="languages" size={16} />
      </button>
      {open ? (
        <div className="settings-popover" role="dialog" aria-label={t("settings.title")} data-testid="settings-popover">
          <label className="settings-row">
            <span className="settings-label">{t("settings.language")}</span>
            <select
              ref={firstRef}
              className="settings-select"
              data-testid="settings-language"
              value={language}
              onChange={(event) => {
                const next = event.target.value as LanguagePreference;
                setLanguagePreference(next);
                void chooseLanguage(next);
              }}
            >
              <option value="system">{t("settings.languageSystem")}</option>
              {LANGUAGES.map((option) => (
                <option key={option.code} value={option.code} lang={option.code}>
                  {option.name}
                </option>
              ))}
            </select>
          </label>
          <div className="settings-row">
            <span className="settings-label" id="settings-theme-label">
              {t("settings.theme.title")}
            </span>
            <div className="settings-segments" role="radiogroup" aria-labelledby="settings-theme-label">
              {THEMES.map((option) => (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={theme === option}
                  className={`settings-segment${theme === option ? " is-active" : ""}`}
                  data-testid={`settings-theme-${option}`}
                  onClick={() => pickTheme(option)}
                >
                  {themeName(option)}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
