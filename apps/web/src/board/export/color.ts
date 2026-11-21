/**
 * Colours for exported SVGs (#yewapn9k). Computed styles can come back in CSS
 * Color 4 forms: `color-mix()` resolves to `color(srgb r g b / a)`, and themes
 * may use `oklch()`/`lab()`. SVG viewers outside browsers (librsvg, Inkscape,
 * many design tools) don't read those, and fall back to black. Every colour
 * the exporter writes goes through here: plain `rgb(r, g, b)` plus a separate
 * opacity, which every SVG renderer understands.
 */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  /** 0–1. */
  a: number;
}

const clamp = (value: number, max: number) => Math.min(max, Math.max(0, value));

function channel(part: string, scale: number): number {
  const value = Number.parseFloat(part);
  if (!Number.isFinite(value)) return Number.NaN;
  return part.trim().endsWith("%") ? (value / 100) * scale : value;
}

function alpha(part: string | undefined): number {
  if (part === undefined || part.trim() === "") return 1;
  const value = Number.parseFloat(part);
  if (!Number.isFinite(value)) return Number.NaN;
  return clamp(part.trim().endsWith("%") ? value / 100 : value, 1);
}

/** Split `a b c / d` or `a, b, c, d` into channels and alpha. */
function parts(body: string): { channels: string[]; alpha: string | undefined } {
  const [main, slashAlpha] = body.split("/");
  const channels = (main ?? "").split(/[\s,]+/).filter(Boolean);
  if (slashAlpha !== undefined) return { channels, alpha: slashAlpha.trim() };
  return channels.length === 4 ? { channels: channels.slice(0, 3), alpha: channels[3] } : { channels, alpha: undefined };
}

/**
 * Parse the colour forms computed styles produce: `rgb()`/`rgba()` (comma or
 * space syntax), `#rgb`/`#rrggbb`/`#rrggbbaa`, `color(srgb …)` and
 * `transparent`. Anything else (`oklch()`, `lab()`…) returns null.
 */
export function parseCssColor(value: string): Rgba | null {
  const text = value.trim().toLowerCase();
  if (text === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  const hex = /^#([0-9a-f]{3,8})$/.exec(text)?.[1];
  if (hex && [3, 4, 6, 8].includes(hex.length)) {
    const full = hex.length <= 4 ? [...hex].map((char) => char + char).join("") : hex;
    const at = (index: number) => Number.parseInt(full.slice(index, index + 2), 16);
    return { r: at(0), g: at(2), b: at(4), a: full.length === 8 ? at(6) / 255 : 1 };
  }
  const rgb = /^rgba?\((.*)\)$/.exec(text)?.[1];
  if (rgb !== undefined) {
    const { channels, alpha: a } = parts(rgb);
    if (channels.length !== 3) return null;
    const [r, g, b] = channels.map((part) => channel(part, 255));
    const result = { r: r!, g: g!, b: b!, a: alpha(a) };
    return Object.values(result).every(Number.isFinite) ? result : null;
  }
  const srgb = /^color\(\s*srgb\s+(.*)\)$/.exec(text)?.[1];
  if (srgb !== undefined) {
    const { channels, alpha: a } = parts(srgb);
    if (channels.length !== 3) return null;
    const [r, g, b] = channels.map((part) => channel(part, 1) * 255);
    const result = { r: r!, g: g!, b: b!, a: alpha(a) };
    return Object.values(result).every(Number.isFinite) ? result : null;
  }
  return null;
}

let probe: CanvasRenderingContext2D | null | undefined;

/** Any other CSS colour: let the browser paint it and read the pixel back. */
function viaCanvas(value: string): Rgba | null {
  if (typeof document === "undefined") return null;
  if (probe === undefined) {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    probe = canvas.getContext("2d", { willReadFrequently: true });
  }
  if (!probe) return null;
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = "#000";
  probe.fillStyle = value;
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
  return { r: r!, g: g!, b: b!, a: a! / 255 };
}

const cache = new Map<string, Rgba | null>();

/** A computed colour as RGBA, or null when it isn't a colour (`none`, `url(…)`). */
export function toRgba(value: string): Rgba | null {
  if (!value || value === "none" || value.startsWith("url(")) return null;
  let known = cache.get(value);
  if (known === undefined) {
    known = parseCssColor(value) ?? viaCanvas(value);
    cache.set(value, known);
  }
  return known;
}

const round = (value: number) => Math.round(clamp(value, 255));
const opacity = (value: number) => String(Math.round(clamp(value, 1) * 1000) / 1000);

/**
 * SVG paint attributes for a colour: ` fill="rgb(…)"` plus ` fill-opacity`
 * when it isn't opaque (times `extra`), or ` fill="none"` for no colour.
 */
export function paint(name: "fill" | "stroke" | "flood-color", value: string, extra = 1): string {
  const color = toRgba(value);
  if (!color || color.a * extra <= 0) return name === "flood-color" ? ' flood-opacity="0"' : ` ${name}="none"`;
  const rgb = `rgb(${round(color.r)}, ${round(color.g)}, ${round(color.b)})`;
  const a = color.a * extra;
  const opacityName = name === "flood-color" ? "flood-opacity" : `${name}-opacity`;
  return ` ${name}="${rgb}"${a < 1 ? ` ${opacityName}="${opacity(a)}"` : ""}`;
}

/** Whether a computed colour paints anything. */
export function isVisible(value: string): boolean {
  const color = toRgba(value);
  return color !== null && color.a > 0;
}
