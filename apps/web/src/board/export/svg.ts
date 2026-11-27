/**
 * Board export (spec/v0-6 §D): turn a rendered board (the export stage, at
 * zoom 1) into a plain SVG document. Everything becomes native SVG, never
 * `<foreignObject>`, so the file opens the same in browsers, Inkscape,
 * Figma and Illustrator:
 *
 * - boxes (sticky paper, frames, cards) → `<rect>` with their radius,
 *   border and drop shadow;
 * - SVG already on the board (shapes, ink, connectors, icons) → copied with
 *   its computed styles and the transform to stage pixels (`getScreenCTM`);
 * - text → one `<text>` per laid-out line, at the position the browser laid
 *   it out (measured with Ranges), in the embedded export font;
 * - images → `<image>` with the file inlined as a data URI;
 * - `overflow: hidden` boxes → clip paths.
 *
 * Coordinates are CSS pixels relative to `origin` (the stage's top-left).
 */

import { isVisible, paint } from "./color.js";

export interface SvgOptions {
  /** Top-left of the exported area, in client coordinates. */
  origin: { x: number; y: number };
  width: number;
  height: number;
  /** A CSS colour, or null for a transparent background. */
  background: string | null;
  /** `@font-face` rules to embed (data URIs). */
  fontCss: string;
  /** Turn an image URL into a data URI (null: leave the image out). */
  inlineImage: (url: string) => Promise<string | null>;
}

interface Output {
  defs: string[];
  body: string[];
  nextId: number;
  images: Array<Promise<void>>;
  /** Text actually drawn, to pick the font subsets to embed. */
  text: string[];
  italic: boolean;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const SKIP_CLASSES = ["react-flow__handle", "react-flow__resize-control", "react-flow__edge-interaction", "react-flow__background"];

export function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** Drop characters XML 1.0 can't hold (control characters, lone surrogates). */
function xmlSafe(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

const num = (value: number): string => {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? "0" : String(rounded);
};

const visibleColor = isVisible;

function skipElement(element: Element): boolean {
  const classes = element.classList;
  return SKIP_CLASSES.some((name) => classes.contains(name));
}

/* ------------------------------------------------------------------------ */
/* Boxes                                                                     */
/* ------------------------------------------------------------------------ */

function radius(value: string, size: number): number {
  const first = value.split(" ")[0] ?? "0";
  const parsed = Number.parseFloat(first);
  if (!Number.isFinite(parsed)) return 0;
  return first.endsWith("%") ? (parsed / 100) * size : parsed;
}

interface Shadow {
  color: string;
  x: number;
  y: number;
  blur: number;
}

/** Outer shadows of a computed `box-shadow` (spread and inset are left out). */
export function parseBoxShadow(value: string): Shadow[] {
  if (!value || value === "none") return [];
  const shadows: Shadow[] = [];
  // Split on commas outside parentheses.
  for (const part of value.split(/,(?![^(]*\))/)) {
    if (/\binset\b/.test(part)) continue;
    const color =
      /((?:rgba?|color|oklch|oklab|lab|lch|hsla?|hwb)\([^)]*\)|#[0-9a-f]+|[a-z]+(?=\s|$))/i.exec(part)?.[1] ?? "rgba(0, 0, 0, 0.2)";
    const lengths = part.replace(color, "").match(/-?[\d.]+px|\b0\b/g)?.map((item) => Number.parseFloat(item)) ?? [];
    if (lengths.length < 2 || !visibleColor(color)) continue;
    shadows.push({ color, x: lengths[0]!, y: lengths[1]!, blur: lengths[2] ?? 0 });
  }
  return shadows;
}

/**
 * Soft shadows as a few translucent rects, each a little larger than the
 * last (an approximation of the blur). Blur filters looked the same at these
 * sizes but made PNGs of big boards several times slower to rasterise, and
 * some design tools ignore them.
 */
function emitShadows(out: Output, value: string, x: number, y: number, width: number, height: number, rx: number, ry: number): void {
  const LAYERS = 2;
  for (const shadow of parseBoxShadow(value)) {
    for (let layer = 0; layer < LAYERS; layer += 1) {
      const grow = shadow.blur <= 0 ? 0 : (shadow.blur / 2) * ((layer + 1) / LAYERS) - shadow.blur / 4;
      const corner = rx > 0 || grow > 0 ? ` rx="${num(Math.max(0, rx + grow))}" ry="${num(Math.max(0, ry + grow))}"` : "";
      out.body.push(
        `<rect x="${num(x + shadow.x - grow)}" y="${num(y + shadow.y - grow)}" width="${num(width + grow * 2)}" height="${num(height + grow * 2)}"${corner}${paint("fill", shadow.color, shadow.blur <= 0 ? 1 : 1 / LAYERS + 0.15)}/>`,
      );
      if (shadow.blur <= 0) break;
    }
  }
}

function emitBox(out: Output, style: CSSStyleDeclaration, box: DOMRect, origin: SvgOptions["origin"]): void {
  if (box.width <= 0 || box.height <= 0) return;
  const x = box.left - origin.x;
  const y = box.top - origin.y;
  const rx = Math.min(radius(style.borderTopLeftRadius, box.width), box.width / 2);
  const ry = style.borderTopLeftRadius.endsWith("%") ? Math.min(radius(style.borderTopLeftRadius, box.height), box.height / 2) : rx;
  const corners = rx > 0 ? ` rx="${num(rx)}" ry="${num(ry)}"` : "";
  const background = style.backgroundColor;
  if (visibleColor(background)) {
    if (style.boxShadow && style.boxShadow !== "none") emitShadows(out, style.boxShadow, x, y, box.width, box.height, rx, ry);
    out.body.push(`<rect x="${num(x)}" y="${num(y)}" width="${num(box.width)}" height="${num(box.height)}"${corners}${paint("fill", background)}/>`);
  }
  const sides = [
    [style.borderTopWidth, style.borderTopColor, style.borderTopStyle],
    [style.borderRightWidth, style.borderRightColor, style.borderRightStyle],
    [style.borderBottomWidth, style.borderBottomColor, style.borderBottomStyle],
    [style.borderLeftWidth, style.borderLeftColor, style.borderLeftStyle],
  ].map(([width, color, kind]) => ({ width: Number.parseFloat(width!) || 0, color: color!, kind: kind! }));
  const drawn = sides.map((side) => side.width > 0 && side.kind !== "none" && side.kind !== "hidden" && visibleColor(side.color));
  if (!drawn.some(Boolean)) return;
  const dash = (kind: string, width: number) =>
    kind === "dashed" ? ` stroke-dasharray="${num(width * 3)} ${num(width * 2)}"` : kind === "dotted" ? ` stroke-dasharray="${num(width)} ${num(width)}"` : "";
  const first = sides[0]!;
  const uniform = drawn.every(Boolean) && sides.every((side) => side.width === first.width && side.color === first.color && side.kind === first.kind);
  if (uniform) {
    const half = first.width / 2;
    const inner = rx > 0 ? ` rx="${num(Math.max(0, rx - half))}" ry="${num(Math.max(0, ry - half))}"` : "";
    out.body.push(
      `<rect x="${num(x + half)}" y="${num(y + half)}" width="${num(box.width - first.width)}" height="${num(box.height - first.width)}"${inner} fill="none"${paint("stroke", first.color)} stroke-width="${num(first.width)}"${dash(first.kind, first.width)}/>`,
    );
    return;
  }
  const lines = [
    [x, y + sides[0]!.width / 2, x + box.width, y + sides[0]!.width / 2],
    [x + box.width - sides[1]!.width / 2, y, x + box.width - sides[1]!.width / 2, y + box.height],
    [x, y + box.height - sides[2]!.width / 2, x + box.width, y + box.height - sides[2]!.width / 2],
    [x + sides[3]!.width / 2, y, x + sides[3]!.width / 2, y + box.height],
  ];
  sides.forEach((side, index) => {
    if (!drawn[index]) return;
    const [x1, y1, x2, y2] = lines[index]!;
    out.body.push(
      `<line x1="${num(x1!)}" y1="${num(y1!)}" x2="${num(x2!)}" y2="${num(y2!)}"${paint("stroke", side.color)} stroke-width="${num(side.width)}"${dash(side.kind, side.width)}/>`,
    );
  });
}

/* ------------------------------------------------------------------------ */
/* Text                                                                      */
/* ------------------------------------------------------------------------ */

const metricsCache = new Map<string, { ascent: number; descent: number }>();
let measureContext: CanvasRenderingContext2D | null = null;

function fontMetrics(font: string): { ascent: number; descent: number } {
  const known = metricsCache.get(font);
  if (known) return known;
  measureContext ??= document.createElement("canvas").getContext("2d");
  let metrics = { ascent: 0, descent: 0 };
  if (measureContext) {
    measureContext.font = font;
    const measured = measureContext.measureText("Hg");
    metrics = { ascent: measured.fontBoundingBoxAscent, descent: measured.fontBoundingBoxDescent };
  }
  metricsCache.set(font, metrics);
  return metrics;
}

interface Line {
  text: string;
  left: number;
  top: number;
  bottom: number;
}

/**
 * The lines a text node was laid out in. One Range per word: words whose
 * boxes share a top are on the same line, joined by single spaces (white
 * space collapses in normal flow; `pre` text keeps its spacing per line).
 */
function layoutLines(node: Text, preserveSpaces: boolean): Line[] {
  const data = node.data;
  const range = document.createRange();
  range.selectNodeContents(node);
  const all = range.getClientRects();
  if (all.length === 0) return [];
  const words: Array<{ start: number; end: number; rect: DOMRect }> = [];
  const pattern = preserveSpaces ? /[^\n]+/g : /\S+/g;
  for (const match of data.matchAll(pattern)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    range.setStart(node, start);
    range.setEnd(node, end);
    const rects = range.getClientRects();
    if (rects.length <= 1) {
      const rect = rects[0] ?? range.getBoundingClientRect();
      if (rect.width > 0 || rect.height > 0) words.push({ start, end, rect });
      continue;
    }
    // A word (or a pre line) broken over lines: split it character by character.
    let lineStart = start;
    let lineRect: DOMRect | null = null;
    for (let index = start; index < end; index += 1) {
      range.setStart(node, index);
      range.setEnd(node, index + 1);
      const rect = range.getBoundingClientRect();
      if (lineRect && Math.abs(rect.top - lineRect.top) > rect.height / 2) {
        words.push({ start: lineStart, end: index, rect: lineRect });
        lineStart = index;
        lineRect = null;
      }
      if (!lineRect) lineRect = rect;
      else lineRect = new DOMRect(lineRect.left, lineRect.top, rect.right - lineRect.left, lineRect.height);
    }
    if (lineRect) words.push({ start: lineStart, end, rect: lineRect });
  }
  range.detach();
  const lines: Line[] = [];
  let current: { words: typeof words } | null = null;
  const flush = () => {
    if (!current || current.words.length === 0) return;
    const first = current.words[0]!;
    const last = current.words[current.words.length - 1]!;
    const text = preserveSpaces
      ? data.slice(first.start, last.end)
      : current.words.map((word) => data.slice(word.start, word.end)).join(" ");
    lines.push({
      text,
      left: first.rect.left,
      top: Math.min(...current.words.map((word) => word.rect.top)),
      bottom: Math.max(...current.words.map((word) => word.rect.bottom)),
    });
  };
  for (const word of words) {
    const previous = current?.words[current.words.length - 1];
    if (!current || !previous || Math.abs(word.rect.top - previous.rect.top) > Math.max(2, word.rect.height / 2)) {
      flush();
      current = { words: [] };
    }
    current.words.push(word);
  }
  flush();
  return lines;
}

function emitText(out: Output, node: Text, style: CSSStyleDeclaration, origin: SvgOptions["origin"]): void {
  if (!/\S/.test(node.data)) return;
  if (style.visibility !== "visible" || !visibleColor(style.color)) return;
  const whiteSpace = style.whiteSpace;
  const preserve = whiteSpace === "pre" || whiteSpace === "pre-wrap" || whiteSpace === "break-spaces";
  const lines = layoutLines(node, preserve);
  if (lines.length === 0) return;
  const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const { descent } = fontMetrics(font);
  const family = style.fontFamily.replace(/"/g, "'");
  const decoration = style.textDecorationLine && style.textDecorationLine !== "none" ? ` text-decoration="${style.textDecorationLine}"` : "";
  const spacing = style.letterSpacing && style.letterSpacing !== "normal" ? ` letter-spacing="${style.letterSpacing}"` : "";
  const italic = style.fontStyle !== "normal";
  if (italic) out.italic = true;
  const attributes = `font-family="${family}" font-size="${style.fontSize}" font-weight="${style.fontWeight}"${italic ? ` font-style="${style.fontStyle}"` : ""}${paint("fill", style.color)}${decoration}${spacing}`;
  for (const line of lines) {
    const text = xmlSafe(line.text);
    if (!text.trim()) continue;
    out.text.push(text);
    const baseline = line.bottom - descent;
    out.body.push(
      `<text x="${num(line.left - origin.x)}" y="${num(baseline - origin.y)}" ${attributes}${preserve ? ' xml:space="preserve"' : ""}>${escapeXml(text)}</text>`,
    );
  }
}

/* ------------------------------------------------------------------------ */
/* Inline SVG (shapes, ink, connectors, icons)                               */
/* ------------------------------------------------------------------------ */

const GEOMETRY: Record<string, readonly string[]> = {
  path: ["d"],
  rect: ["x", "y", "width", "height", "rx", "ry"],
  circle: ["cx", "cy", "r"],
  ellipse: ["cx", "cy", "rx", "ry"],
  line: ["x1", "y1", "x2", "y2"],
  polyline: ["points"],
  polygon: ["points"],
};

function emitSvgShapes(out: Output, svg: SVGSVGElement, origin: SvgOptions["origin"]): void {
  const walk = (element: Element) => {
    if (skipElement(element)) return;
    const tag = element.tagName.toLowerCase();
    if (tag === "defs" || tag === "title" || tag === "desc" || tag === "clippath" || tag === "mask") return;
    if (element instanceof SVGGraphicsElement || element instanceof SVGSVGElement) {
      const style = getComputedStyle(element);
      if (style.display === "none" || Number.parseFloat(style.opacity) === 0) return;
      const geometry = GEOMETRY[tag];
      if (geometry && style.visibility === "visible") emitSvgShape(out, element as SVGGraphicsElement, tag, geometry, style, origin);
    }
    for (const child of Array.from(element.children)) walk(child);
  };
  walk(svg);
}

function emitSvgShape(
  out: Output,
  element: SVGGraphicsElement,
  tag: string,
  geometry: readonly string[],
  style: CSSStyleDeclaration,
  origin: SvgOptions["origin"],
): void {
  const fill = style.fill.startsWith("url(") ? "none" : style.fill;
  const stroke = style.stroke.startsWith("url(") ? "none" : style.stroke;
  const fillOpacity = Number.parseFloat(style.fillOpacity);
  const strokeOpacity = Number.parseFloat(style.strokeOpacity);
  const hasFill = visibleColor(fill) && fillOpacity > 0 && tag !== "line" && tag !== "polyline";
  const strokeWidth = Number.parseFloat(style.strokeWidth) || 0;
  const hasStroke = visibleColor(stroke) && strokeOpacity > 0 && strokeWidth > 0;
  if (!hasFill && !hasStroke) return;
  const matrix = element.getScreenCTM();
  if (!matrix) return;
  const attributes: string[] = [];
  for (const name of geometry) {
    let value = element.getAttribute(name);
    if (value === null && name === "d") value = style.getPropertyValue("d").replace(/^path\("(.*)"\)$/, "$1") || null;
    if (value === null) {
      // Geometry set in CSS (e.g. `r`, `rx`): use the computed value.
      const computed = style.getPropertyValue(name);
      if (computed && computed !== "auto") value = String(Number.parseFloat(computed));
    }
    if (value !== null && value !== "") attributes.push(`${name}="${escapeXml(value)}"`);
  }
  const e = matrix.e - origin.x;
  const f = matrix.f - origin.y;
  const transform = `matrix(${num(matrix.a)} ${num(matrix.b)} ${num(matrix.c)} ${num(matrix.d)} ${num(e)} ${num(f)})`;
  attributes.push(`transform="${transform}"`);
  attributes.push(hasFill ? paint("fill", fill, fillOpacity).trim() : 'fill="none"');
  if (hasFill && style.fillRule === "evenodd") attributes.push('fill-rule="evenodd"');
  if (hasStroke) {
    // Non-scaling strokes are as wide on screen as their stroke-width: keep
    // that width once the transform scales the shape.
    const scale = Math.sqrt(Math.abs(matrix.a * matrix.d - matrix.b * matrix.c)) || 1;
    const width = style.vectorEffect === "non-scaling-stroke" ? strokeWidth / scale : strokeWidth;
    attributes.push(paint("stroke", stroke, strokeOpacity).trim(), `stroke-width="${num(width)}"`);
    if (style.strokeLinecap !== "butt") attributes.push(`stroke-linecap="${style.strokeLinecap}"`);
    if (style.strokeLinejoin !== "miter") attributes.push(`stroke-linejoin="${style.strokeLinejoin}"`);
    if (style.strokeDasharray && style.strokeDasharray !== "none") {
      const factor = style.vectorEffect === "non-scaling-stroke" ? 1 / scale : 1;
      const dashes = style.strokeDasharray.split(/[\s,]+/).map((item) => num(Number.parseFloat(item) * factor));
      attributes.push(`stroke-dasharray="${dashes.join(" ")}"`);
    }
  }
  const opacity = Number.parseFloat(style.opacity);
  if (opacity < 1) attributes.push(`opacity="${num(opacity)}"`);
  out.body.push(`<${tag} ${attributes.join(" ")}/>`);
}

/* ------------------------------------------------------------------------ */
/* Images                                                                    */
/* ------------------------------------------------------------------------ */

function emitImage(out: Output, image: HTMLImageElement, style: CSSStyleDeclaration, options: SvgOptions): void {
  const box = image.getBoundingClientRect();
  const src = image.currentSrc || image.src;
  if (!src || box.width <= 0 || box.height <= 0 || !image.complete || image.naturalWidth === 0) return;
  const fit = style.objectFit;
  const aspect = fit === "contain" || fit === "scale-down" ? "xMidYMid meet" : fit === "cover" ? "xMidYMid slice" : "none";
  const index = out.body.length;
  out.body.push("");
  const x = box.left - options.origin.x;
  const y = box.top - options.origin.y;
  let clip = "";
  if (fit === "cover") {
    const id = `c${out.nextId++}`;
    out.defs.push(`<clipPath id="${id}"><rect x="${num(x)}" y="${num(y)}" width="${num(box.width)}" height="${num(box.height)}"/></clipPath>`);
    clip = ` clip-path="url(#${id})"`;
  }
  out.images.push(
    options.inlineImage(src).then((data) => {
      if (!data) return;
      out.body[index] = `<image x="${num(x)}" y="${num(y)}" width="${num(box.width)}" height="${num(box.height)}" preserveAspectRatio="${aspect}" href="${escapeXml(data)}"${clip}/>`;
    }),
  );
}

/* ------------------------------------------------------------------------ */
/* Walk                                                                      */
/* ------------------------------------------------------------------------ */

function visit(out: Output, element: Element, options: SvgOptions): void {
  if (skipElement(element)) return;
  if (element instanceof SVGSVGElement) {
    emitSvgShapes(out, element, options.origin);
    return;
  }
  if (!(element instanceof HTMLElement)) return;
  const style = getComputedStyle(element);
  if (style.display === "none") return;
  const opacity = Number.parseFloat(style.opacity);
  if (opacity === 0) return;
  if (element instanceof HTMLImageElement) {
    if (style.visibility === "visible") emitImage(out, element, style, options);
    return;
  }
  // Form controls never appear on the stage; skip them if one does.
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLButtonElement && element.classList.contains("board-card-open")) return;

  const groupOpen = opacity < 1;
  if (groupOpen) out.body.push(`<g opacity="${num(opacity)}">`);
  const box = element.getBoundingClientRect();
  if (style.visibility === "visible") emitBox(out, style, box, options.origin);

  const clips = (style.overflowX !== "visible" || style.overflowY !== "visible") && element.childNodes.length > 0 && box.width > 0;
  if (clips) {
    const id = `c${out.nextId++}`;
    const rx = Math.min(radius(style.borderTopLeftRadius, box.width), box.width / 2);
    out.defs.push(
      `<clipPath id="${id}"><rect x="${num(box.left - options.origin.x)}" y="${num(box.top - options.origin.y)}" width="${num(box.width)}" height="${num(box.height)}"${rx > 0 ? ` rx="${num(rx)}"` : ""}/></clipPath>`,
    );
    out.body.push(`<g clip-path="url(#${id})">`);
  }
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) emitText(out, child as Text, style, options.origin);
    else if (child.nodeType === Node.ELEMENT_NODE) visit(out, child as Element, options);
  }
  if (clips) out.body.push("</g>");
  if (groupOpen) out.body.push("</g>");
}

export interface SvgResult {
  svg: string;
  /** Characters drawn as text (to choose font subsets). */
  text: string;
  italic: boolean;
}

/** React Flow's layers: their children share the viewport's stacking context. */
const LAYER_CLASSES = ["react-flow__edges", "react-flow__edgelabel-renderer", "react-flow__nodes"];

/**
 * The viewport's objects in the order the browser paints them (#sdwrzdgx):
 * the edges, edge labels and nodes of every layer, sorted by z-index, ties in
 * DOM order. Edges sit above frames, so DOM order alone would hide them.
 */
function paintOrder(root: Element): Element[] {
  const items: Element[] = [];
  for (const child of Array.from(root.children)) {
    if (LAYER_CLASSES.some((name) => child.classList.contains(name))) items.push(...Array.from(child.children));
    else items.push(child);
  }
  const z = (element: Element): number => {
    const value = Number.parseInt(getComputedStyle(element).zIndex, 10);
    return Number.isFinite(value) ? value : 0;
  };
  return items.map((element, index) => ({ element, index, z: z(element) })).sort((a, b) => a.z - b.z || a.index - b.index).map(({ element }) => element);
}

/**
 * Build the SVG for everything under `root`. `fontCss` may be a function of
 * the text drawn, so only the font subsets actually needed are embedded.
 */
export async function elementToSvg(
  root: Element,
  options: Omit<SvgOptions, "fontCss"> & { fontCss: string | ((used: { text: string; italic: boolean }) => Promise<string>) },
): Promise<SvgResult> {
  const out: Output = { defs: [], body: [], nextId: 0, images: [], text: [], italic: false };
  const resolved: SvgOptions = { ...options, fontCss: "" };
  for (const child of paintOrder(root)) visit(out, child, resolved);
  await Promise.all(out.images);
  const text = out.text.join("\n");
  const fontCss = typeof options.fontCss === "string" ? options.fontCss : await options.fontCss({ text, italic: out.italic });
  const { width, height } = options;
  const parts = [
    `<svg xmlns="${SVG_NS}" width="${num(width)}" height="${num(height)}" viewBox="0 0 ${num(width)} ${num(height)}">`,
  ];
  const defs = [...(fontCss ? [`<style>${fontCss}</style>`] : []), ...out.defs];
  if (defs.length > 0) parts.push(`<defs>${defs.join("")}</defs>`);
  if (options.background && isVisible(options.background)) parts.push(`<rect width="100%" height="100%"${paint("fill", options.background)}/>`);
  parts.push(...out.body.filter((line) => line !== ""), "</svg>");
  return { svg: parts.join("\n"), text, italic: out.italic };
}
