import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { USER_GUIDE_BASE, userGuideUrl } from "../src/lib/user-guide.js";

/** #snuin2ja: Cmd+K → Open the user guide, by the app's language (the guide is #6ka8s7mf). */
describe("user guide URL", () => {
  it("ru opens the Russian guide; any other language the English one", () => {
    expect(userGuideUrl("en")).toBe("https://github.com/arslanarm/gumply/blob/main/docs/guide/en/README.md");
    expect(userGuideUrl("ru")).toBe("https://github.com/arslanarm/gumply/blob/main/docs/guide/ru/README.md");
    expect(userGuideUrl("de")).toBe("https://github.com/arslanarm/gumply/blob/main/docs/guide/en/README.md");
  });

  it("is the same URL as the desktop's Help → User Guide, once that has one", () => {
    const desktop = new URL("../../desktop/src/urls.ts", import.meta.url);
    const source = existsSync(desktop) ? readFileSync(desktop, "utf8") : "";
    const base = /USER_GUIDE_BASE\s*=\s*"([^"]+)"/.exec(source)?.[1];
    if (base !== undefined) expect(base).toBe(USER_GUIDE_BASE);
  });
});
