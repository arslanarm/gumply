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
import { useModal } from "../lib/modal.js";

const THEMES: readonly ThemePreference[] = ["system", "light", "dark"];

export function SettingsMenu({
  open,
  onOpenChange,
  onOpenMcp,
  onOpenHistory,
  onOpenUpdates,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A3: Settings → AI apps (MCP)…. */
  onOpenMcp?: () => void;
  /** D41: Settings → Version history (size, clear, the Syncthing hint). */
  onOpenHistory?: () => void;
  /** spec/auto-update: Settings → Updates… (desktop installs that update or are told). */
  onOpenUpdates?: () => void;
}) {
  const t = useT();
  // Re-render when the language changes (the selected option moves).
  useLanguage();
  const [language, setLanguagePreference] = useState<LanguagePreference>(languagePreference);
  const [theme, setTheme] = useState<ThemePreference>(() => loadThemePreference(browserStorage()));
  const ref = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLSelectElement>(null);
  // A popover, not a modal: focus moves in on open and back to the Settings
  // button on Escape (#vefk9dwg); Tab may leave it.
  const popoverRef = useRef<HTMLDivElement>(null);
  useModal(popoverRef, { active: open, modal: false });

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
        {/* A gear: the popover holds Language, Theme and AI apps, not just the language (#jn9vhndu). */}
        <Icon name="settings" size={16} />
      </button>
      {open ? (
        <div className="settings-popover" ref={popoverRef} role="dialog" aria-label={t("settings.title")} data-testid="settings-popover">
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
          {onOpenMcp ? (
            <button
              type="button"
              className="settings-link"
              data-testid="settings-mcp"
              onClick={() => {
                onOpenChange(false);
                onOpenMcp();
              }}
            >
              <Icon name="graph" size={15} />
              <span>{t("settings.mcp.open")}</span>
              <Icon name="chevronRight" size={14} />
            </button>
          ) : null}
          {onOpenHistory ? (
            <button
              type="button"
              className="settings-link"
              data-testid="settings-history"
              onClick={() => {
                onOpenChange(false);
                onOpenHistory();
              }}
            >
              <Icon name="clock" size={15} />
              <span>{t("history.title")}</span>
              <Icon name="chevronRight" size={14} />
            </button>
          ) : null}
          {onOpenUpdates ? (
            <button
              type="button"
              className="settings-link"
              data-testid="settings-updates"
              onClick={() => {
                onOpenChange(false);
                onOpenUpdates();
              }}
            >
              <Icon name="download" size={15} />
              <span>{t("settings.updates.open")}</span>
              <Icon name="chevronRight" size={14} />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
