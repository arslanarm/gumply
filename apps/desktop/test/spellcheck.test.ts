import { describe, expect, it } from "vitest";
import { spellcheckLanguages } from "../src/spellcheck";

// A typical Chromium list (Linux/Windows `session.availableSpellCheckerLanguages`).
const CHROMIUM = ["af", "bg", "de-DE", "en-AU", "en-CA", "en-GB", "en-US", "es", "fr-FR", "ru", "uk"];

describe("spellcheck follows the app's language (1.0 N3)", () => {
  it("en → en-US, ru → ru", () => {
    expect(spellcheckLanguages("en", "en-US", CHROMIUM)).toEqual(["en-US"]);
    expect(spellcheckLanguages("ru", "ru-RU", CHROMIUM)).toEqual(["ru"]);
  });

  it("the app's language first, then the system's when it's a different language", () => {
    // Russian on an English (UK) system: both, Russian first.
    expect(spellcheckLanguages("ru", "en-GB", CHROMIUM)).toEqual(["ru", "en-GB"]);
    // English on a German system.
    expect(spellcheckLanguages("en", "de-DE", CHROMIUM)).toEqual(["en-US", "de-DE"]);
    // Same language, other region: one dictionary, in the system's region.
    expect(spellcheckLanguages("en", "en-GB", CHROMIUM)).toEqual(["en-GB"]);
    expect(spellcheckLanguages("ru", "ru-RU", ["ru", "ru-RU"])).toEqual(["ru-RU"]);
  });

  it("falls back within the language, and never returns what Chromium doesn't offer", () => {
    expect(spellcheckLanguages("en", "en-US", ["en-GB", "ru"])).toEqual(["en-GB"]);
    expect(spellcheckLanguages("ru", "en-US", ["ru-RU", "en-US"])).toEqual(["ru-RU", "en-US"]);
    // A system language Chromium has no dictionary for is left out.
    expect(spellcheckLanguages("ru", "kk-KZ", CHROMIUM)).toEqual(["ru"]);
    expect(spellcheckLanguages("en", "en-US", [])).toEqual([]);
  });

  it("a bare `en` in Chromium's list never wins over a regional dictionary (the 92b6ff6 trial got [\"en\"])", () => {
    const withBare = ["de", "en", "en-AU", "en-GB", "en-US", "ru"];
    expect(spellcheckLanguages("en", "en-US", withBare)).toEqual(["en-US"]);
    expect(spellcheckLanguages("en", "en", withBare)).toEqual(["en-US"]);
    expect(spellcheckLanguages("ru", "en-US", withBare)).toEqual(["ru", "en-US"]);
    // Only a bare `en` offered: that's still better than nothing.
    expect(spellcheckLanguages("en", "en-US", ["en", "ru"])).toEqual(["en"]);
  });

  it("matches case-insensitively, keeps Chromium's spelling, and has no duplicates", () => {
    expect(spellcheckLanguages("en", "EN_us", ["EN-US"])).toEqual(["EN-US"]);
    expect(spellcheckLanguages("ru", "ru", CHROMIUM)).toEqual(["ru"]);
  });
});
