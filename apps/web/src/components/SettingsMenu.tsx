/**
 * Settings popover (#7h5utv23): the interface language, what opens on startup,
 * and the appearance (theme, page font and width, v0.9 F #if236h9k); then the
 * dialogs (AI apps, version history, updates). The topbar keeps its one-click
 * theme toggle, and Cmd+K → "Language…" opens this too.
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
import {
  applyPageAppearance,
  loadPageFont,
  loadPageWidth,
  loadStartupMode,
  PAGE_FONTS,
  PAGE_WIDTHS,
  savePageFont,
  savePageWidth,
  saveStartupMode,
  STARTUP_MODES,
  type PageFont,
  type PageWidth,
  type StartupMode,
} from "../lib/page-appearance.js";
import { Icon } from "./Icon.js";
import { useModal } from "../lib/modal.js";

const THEMES: readonly ThemePreference[] = ["system", "light", "dark"];

export function SettingsMenu({
  open,
  onOpenChange,
  onOpenMcp,
  onOpenHistory,
  onOpenUpdates,
  startupPage,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A3: Settings → AI apps (MCP)…. */
  onOpenMcp?: () => void;
  /** D41: Settings → Version history (size, clear, the Syncthing hint). */
  onOpenHistory?: () => void;
  /** spec/auto-update: Settings → Updates… (desktop installs that update or are told). */
  onOpenUpdates?: () => void;
  /** v0.9 F: the page chosen for startup in this vault (its title, or null), and how to pick one. */
  startupPage?: { title: string | null; onChoose: () => void };
}) {
  const t = useT();
  // Re-render when the language changes (the selected option moves).
  useLanguage();
  const [language, setLanguagePreference] = useState<LanguagePreference>(languagePreference);
  const [theme, setTheme] = useState<ThemePreference>(() => loadThemePreference(browserStorage()));
  const [font, setFont] = useState<PageFont>(loadPageFont);
  const [width, setWidth] = useState<PageWidth>(loadPageWidth);
  const [startup, setStartup] = useState<StartupMode>(loadStartupMode);
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
    setFont(loadPageFont());
    setWidth(loadPageWidth());
    setStartup(loadStartupMode());
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

  const pickFont = (next: PageFont) => {
    savePageFont(next);
    setFont(next);
    applyPageAppearance(next, width);
  };
  const pickWidth = (next: PageWidth) => {
    savePageWidth(next);
    setWidth(next);
    applyPageAppearance(font, next);
  };
  const pickStartup = (next: StartupMode) => {
    saveStartupMode(next);
    setStartup(next);
  };

  const themeRow = (
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
  );
  const fontRow = (
    <div className="settings-row">
      <span className="settings-label" id="settings-font-label">
        {t("settings.font.title")}
      </span>
      <div className="settings-segments" role="radiogroup" aria-labelledby="settings-font-label">
        {PAGE_FONTS.map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={font === option}
            className={`settings-segment is-font-sample${font === option ? " is-active" : ""}`}
            data-testid={`settings-font-${option}`}
            onClick={() => pickFont(option)}
          >
            <span className={`font-sample is-${option}`} aria-hidden="true">
              Ag
            </span>
            <span className="font-name">{t(`settings.font.${option}`)}</span>
          </button>
        ))}
      </div>
    </div>
  );
  const widthRow = (
    <div className="settings-row">
      <span className="settings-label" id="settings-width-label">
        {t("settings.width.title")}
      </span>
      <div className="settings-segments" role="radiogroup" aria-labelledby="settings-width-label">
        {PAGE_WIDTHS.map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={width === option}
            className={`settings-segment${width === option ? " is-active" : ""}`}
            data-testid={`settings-width-${option}`}
            onClick={() => pickWidth(option)}
          >
            {t(`settings.width.${option}`)}
          </button>
        ))}
      </div>
    </div>
  );
  const startupRow = (
    <div className="settings-row">
      <label className="settings-label" htmlFor="settings-startup">
        {t("settings.startup.title")}
      </label>
      <select
        id="settings-startup"
        className="settings-select"
        data-testid="settings-startup"
        value={startup}
        onChange={(event) => {
          const next = event.target.value as StartupMode;
          pickStartup(next);
          // Choosing "A page I choose" with none chosen yet opens the picker at once.
          if (next === "page" && startupPage && !startupPage.title) {
            onOpenChange(false);
            startupPage.onChoose();
          }
        }}
      >
        {STARTUP_MODES.map((option) => (
          <option key={option} value={option}>
            {t(`settings.startup.${option}`)}
          </option>
        ))}
      </select>
      {startup === "page" && startupPage ? (
        <button
          type="button"
          className="settings-startup-page"
          data-testid="settings-startup-choose"
          onClick={() => {
            onOpenChange(false);
            startupPage.onChoose();
          }}
        >
          <span className="settings-startup-page-title">{startupPage.title ?? t("settings.startup.none")}</span>
          <span className="settings-startup-page-action">{t("settings.startup.choose")}</span>
        </button>
      ) : null}
    </div>
  );

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
          {/* Layout B (@lead, #if236h9k): startup next to language, then the visual settings together. */}
          {startupRow}
          <p className="settings-section-title">{t("settings.appearance")}</p>
          {themeRow}
          {fontRow}
          {widthRow}
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
