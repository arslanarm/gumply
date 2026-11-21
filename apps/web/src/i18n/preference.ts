/**
 * Where the language preference lives (#7h5utv23):
 * - browser: `localStorage` (`gumply:language`; absent = follow the browser);
 * - desktop app: the desktop settings, read from `/api/health` (`uiLanguage`)
 *   and written with `PUT /api/ui/language`. The desktop window loads from a
 *   new random port on every start, so its `localStorage` doesn't last; the
 *   desktop app also rebuilds its menu in the chosen language.
 */
import { api } from "../api/client.js";
import {
  LANGUAGE_STORAGE_KEY,
  parseLanguagePreference,
  resolveLanguage,
  setLanguage,
  type LanguagePreference,
} from "./index.js";

function isDesktop(): boolean {
  return typeof navigator !== "undefined" && /\bElectron\//.test(navigator.userAgent);
}

function preferredLanguages(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  return navigator.languages?.length ? navigator.languages : [navigator.language];
}

let preference: LanguagePreference = "system";

export function languagePreference(): LanguagePreference {
  return preference;
}

function readStored(): LanguagePreference {
  try {
    return parseLanguagePreference(window.localStorage.getItem(LANGUAGE_STORAGE_KEY));
  } catch {
    return "system";
  }
}

/** Before first paint: load the saved (or system) language. Never throws. */
export async function initLanguage(): Promise<void> {
  if (isDesktop()) {
    try {
      preference = parseLanguagePreference((await api.health()).uiLanguage);
    } catch {
      preference = "system";
    }
  } else {
    preference = readStored();
  }
  try {
    await setLanguage(resolveLanguage(preference, preferredLanguages()));
  } catch (error) {
    // A language file that can't load leaves the app in English.
    console.error("[gumply] couldn't load the interface language:", error);
  }
}

/** The user picked a language (or "system"): switch now and remember it. */
export async function chooseLanguage(next: LanguagePreference): Promise<void> {
  preference = next;
  await setLanguage(resolveLanguage(next, preferredLanguages()));
  if (isDesktop()) {
    await api.setUiLanguage(next).catch((error) => console.error("[gumply] couldn't save the language:", error));
    return;
  }
  try {
    if (next === "system") window.localStorage.removeItem(LANGUAGE_STORAGE_KEY);
    else window.localStorage.setItem(LANGUAGE_STORAGE_KEY, next);
  } catch {
    // Storage disabled: the choice lasts for this session.
  }
}
