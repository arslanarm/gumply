/**
 * Where the language preference lives (#7h5utv23): `localStorage`
 * (`gumply:language`; absent = follow the system). In the desktop app that
 * key is mirrored to the desktop settings like every `gumply:*` preference
 * (#c7fzzxk8, `lib/ui-state.ts`): it's restored before `initLanguage` runs,
 * and the desktop app rebuilds its menu when it changes.
 */
import {
  LANGUAGE_STORAGE_KEY,
  parseLanguagePreference,
  resolveLanguage,
  setLanguage,
  type LanguagePreference,
} from "./index.js";

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
  preference = readStored();
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
  try {
    if (next === "system") window.localStorage.removeItem(LANGUAGE_STORAGE_KEY);
    else window.localStorage.setItem(LANGUAGE_STORAGE_KEY, next);
  } catch {
    // Storage disabled: the choice lasts for this session.
  }
}
