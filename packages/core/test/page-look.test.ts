import { describe, expect, it } from "vitest";
import { coverValue, pageLook, parseCover, type Property } from "../src/index";

const props = (values: Record<string, Property["value"]>): Property[] =>
  Object.entries(values).map(([key, value]) => ({ key, value, type: "text", editable: true }));

describe("page cover and background (#385sexd6)", () => {
  it("parses every cover form, and rejects anything unsafe", () => {
    expect(parseCover("[[attachments/cover.png]]")).toEqual({ kind: "image", link: "attachments/cover.png" });
    expect(parseCover("![[cover.png|wide]]")).toEqual({ kind: "image", link: "cover.png" });
    expect(parseCover("Images/banner.jpg")).toEqual({ kind: "image", link: "Images/banner.jpg" });
    expect(parseCover("https://example.com/a.png")).toEqual({ kind: "url", url: "https://example.com/a.png" });
    expect(parseCover("color:Blue")).toEqual({ kind: "color", name: "blue" });
    expect(parseCover("gradient:ocean")).toEqual({ kind: "gradient", name: "ocean" });
    expect(parseCover("none")).toBe("none");
    for (const bad of ["javascript:alert(1)", "http://x/a.png", "data:image/png;base64,AA", "color:chartreuse", "[[../secret.png]]", "/etc/x.png", "", 3]) {
      expect(parseCover(bad as never)).toBeNull();
    }
  });

  it("reads the look, with Banners plugin keys as a fallback", () => {
    expect(pageLook(undefined)).toEqual({ cover: null, position: 50, background: null, coverSource: null, bannerIcon: null });
    expect(pageLook(props({ cover: "color:red", "cover-position": 120, background: "green" }))).toEqual({
      cover: { kind: "color", name: "red" },
      position: 100,
      background: "green",
      coverSource: "cover",
      bannerIcon: null,
    });
    expect(pageLook(props({ banner: "[[b.png]]", banner_y: 0.25 }))).toMatchObject({
      cover: { kind: "image", link: "b.png" },
      position: 25,
      coverSource: "banner",
    });
    // Our own key wins; `none` hides a Banners cover in Gumply only.
    expect(pageLook(props({ cover: "color:blue", banner: "[[b.png]]" })).coverSource).toBe("cover");
    expect(pageLook(props({ cover: "none", banner: "[[b.png]]" }))).toMatchObject({ cover: null, coverSource: "cover" });
    expect(pageLook(props({ background: "teal" })).background).toBeNull();
    // Legacy `![[…]]`, an out-of-range banner_y (clamped), and the icon.
    expect(pageLook(props({ banner: "![[b.png]]", banner_y: 1.7, banner_icon: "🏔️ peaks" }))).toMatchObject({
      cover: { kind: "image", link: "b.png" },
      position: 100,
      bannerIcon: "🏔️",
    });
    expect(pageLook(props({ banner: "https://example.com/b.png" })).cover).toEqual({ kind: "url", url: "https://example.com/b.png" });
  });

  it("writes images with their full vault path", () => {
    expect(coverValue({ kind: "image", link: "attachments/x.png" })).toBe("[[attachments/x.png]]");
    expect(coverValue({ kind: "gradient", name: "dusk" })).toBe("gradient:dusk");
  });
});
