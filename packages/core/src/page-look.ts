/**
 * Page cover and page background (v0.7 F, #385sexd6), read from frontmatter.
 *
 * - `cover:`: `"[[vault/path.png]]"` (or a bare `[[name.png]]`), an
 *   `https://` URL (read only; Gumply saves pasted URLs to the vault first),
 *   `color:<name>`, `gradient:<name>`, or `none` (a Banners cover hidden in
 *   Gumply).
 * - `cover-position:` the vertical focus, 0–100 (default 50).
 * - `background:` a palette name.
 *
 * Notes made with the Obsidian Banners plugin are read too: `banner:` when
 * there is no `cover:`, and `banner_y` (0–1) as the position. Gumply never
 * writes `banner*` keys.
 *
 * These keys are written through the property patch (only their own lines
 * change) and are hidden from the properties block.
 */
import type { Property, PropertyValue } from "./properties.js";

export const PAGE_LOOK_KEYS: readonly string[] = ["cover", "cover-position", "background"];

/** The text/background palette (#h368c8ni) names. */
export const PAGE_COLORS = ["gray", "red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink"] as const;
export type PageColor = (typeof PAGE_COLORS)[number];

export const PAGE_GRADIENTS = ["sunrise", "ocean", "forest", "dusk", "peach", "slate"] as const;
export type PageGradient = (typeof PAGE_GRADIENTS)[number];

export type PageCover =
  | { kind: "image"; /** The link target as written (a vault path or a bare name). */ link: string }
  | { kind: "url"; url: string }
  | { kind: "color"; name: PageColor }
  | { kind: "gradient"; name: PageGradient };

export interface PageLook {
  cover: PageCover | null;
  /** 0–100. */
  position: number;
  background: PageColor | null;
  /** Where the cover came from: Gumply's key, or the Banners plugin's. */
  coverSource: "cover" | "banner" | null;
}

const isColor = (value: string): value is PageColor => (PAGE_COLORS as readonly string[]).includes(value);
const isGradient = (value: string): value is PageGradient => (PAGE_GRADIENTS as readonly string[]).includes(value);

/** `[[target|alias]]` → `target`; a plain vault path stays as is. */
function linkTarget(value: string): string | null {
  const wiki = /^!?\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]$/.exec(value);
  const target = (wiki ? wiki[1]! : value).trim();
  if (target.length === 0 || target.includes("..") || target.startsWith("/")) return null;
  return target;
}

/** Parse one `cover:` / `banner:` value. `none` is returned as `"none"`. */
export function parseCover(raw: PropertyValue | undefined): PageCover | "none" | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value.length === 0) return null;
  if (value === "none") return "none";
  const lower = value.toLowerCase();
  if (lower.startsWith("color:")) {
    const name = lower.slice(6).trim();
    return isColor(name) ? { kind: "color", name } : null;
  }
  if (lower.startsWith("gradient:")) {
    const name = lower.slice(9).trim();
    return isGradient(name) ? { kind: "gradient", name } : null;
  }
  if (/^https:\/\//i.test(value)) return { kind: "url", url: value };
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null; // other schemes (http:, data:, javascript:…)
  const link = linkTarget(value);
  return link ? { kind: "image", link } : null;
}

function number(raw: PropertyValue | undefined): number | null {
  const value = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  return Number.isFinite(value) ? value : null;
}

const clamp = (value: number) => Math.min(100, Math.max(0, Math.round(value * 10) / 10));

/** The page's look from its properties (`Page.properties`). */
export function pageLook(properties: readonly Property[] | undefined): PageLook {
  const value = (key: string) => properties?.find((property) => property.key === key)?.value;
  let cover: PageCover | null = null;
  let coverSource: PageLook["coverSource"] = null;
  let position = 50;

  const own = parseCover(value("cover"));
  if (own === "none") {
    coverSource = "cover";
  } else if (own) {
    cover = own;
    coverSource = "cover";
    position = clamp(number(value("cover-position")) ?? 50);
  } else if (value("cover") === undefined) {
    const banner = parseCover(value("banner"));
    if (banner && banner !== "none") {
      cover = banner;
      coverSource = "banner";
      const y = number(value("banner_y"));
      position = y === null ? 50 : clamp(y * 100);
    }
  }

  const background = value("background");
  const name = typeof background === "string" ? background.trim().toLowerCase() : "";
  return { cover, position, background: isColor(name) ? name : null, coverSource };
}

/** The `cover:` value Gumply writes. Images always carry their full vault path. */
export function coverValue(cover: PageCover): string {
  switch (cover.kind) {
    case "image":
      return `[[${cover.link}]]`;
    case "url":
      return cover.url;
    case "color":
      return `color:${cover.name}`;
    case "gradient":
      return `gradient:${cover.name}`;
  }
}
