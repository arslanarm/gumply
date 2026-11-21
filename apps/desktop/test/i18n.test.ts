import { describe, expect, it } from "vitest";
import { normaliseSettings } from "../src/settings";
import { DESKTOP_LANGUAGES, desktopT, resolveDesktopLanguage } from "../src/i18n";

describe("desktop menus and dialogs in the interface language (#7h5utv23)", () => {
  it("ships the web app's languages", () => {
    expect(DESKTOP_LANGUAGES).toEqual(expect.arrayContaining(["en", "ru"]));
  });

  it("uses the saved language, else the system's, else English", () => {
    expect(resolveDesktopLanguage("ru", "en-US")).toBe("ru");
    expect(resolveDesktopLanguage(null, "ru-RU")).toBe("ru");
    expect(resolveDesktopLanguage(null, "de-DE")).toBe("en");
    expect(resolveDesktopLanguage("xx", "en-GB")).toBe("en");
  });

  it("translates menu labels, keeping the access-key ampersand", () => {
    expect(desktopT("en", "menu.file")).toBe("&File");
    expect(desktopT("ru", "menu.file")).toMatch(/^&/);
    expect(desktopT("ru", "menu.newPage")).not.toBe("New Page");
    // Unknown language or key: English, then the key itself.
    expect(desktopT("xx", "menu.newPage")).toBe("New Page");
    expect(desktopT("en", "menu.nope")).toBe("desktop.menu.nope");
  });

  it("reads the language from the app's mirrored preferences (#c7fzzxk8)", () => {
    const saved = normaliseSettings({ uiState: { "gumply:language": "ru" } }).uiState["gumply:language"];
    expect(saved).toBe("ru");
    expect(resolveDesktopLanguage(saved, "en-US")).toBe("ru");
    // Anything but a shipped language follows the system.
    expect(resolveDesktopLanguage("../evil", "ru-RU")).toBe("ru");
    expect(resolveDesktopLanguage(undefined, "de-DE")).toBe("en");
  });
});
