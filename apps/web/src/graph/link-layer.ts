/**
 * #pifuz5zs: the resting links of a big graph, kept as a picture while nothing
 * moves.
 *
 * force-graph repaints every link on every frame, and the links' colour
 * depends on which node is hovered, so on the 10k vault each hover change cost
 * a full repaint of ~129k links (~1.35 s at 4× CPU, measured in #t38fvsrw).
 * GraphCanvas now draws the resting links itself into an offscreen canvas
 * (one for "nothing hovered", one faded for "something hovered") while the
 * camera, the positions and the styles stay the same, and only copies that
 * picture on later frames. force-graph draws just the hovered node's own links,
 * on top.
 *
 * The strokes are force-graph's own: one path per dash group, the resting width
 * from `restingLinkWidth` (under one device pixel, #s3sszwux), the ghost dash in
 * graph units, so the picture matches the live drawing.
 */

import { isGhostId } from "./graph-model.js";

/**
 * How a link looks, as pure functions of exactly what the cached picture's key
 * holds (#pifuz5zs): the hovered node, the theme's link colours, the device pixel
 * ratio (the width, in link-width.ts) and the data (whether the target is a page
 * not created yet). A link style that read anything more (a selection, a group's
 * colour) would need a new parameter here, and so a new part of the key: the
 * unit test pins these signatures and values.
 */
export interface LinkColors {
  idle: string;
  faded: string;
  active: string;
}

/** The dash of a link to a page not created yet, in graph units (as force-graph sets it). */
export const GHOST_LINK_DASH = [4, 3];

/**
 * A link's colour: the theme's idle colour at rest; while a node is hovered, active on its links, faded elsewhere.
 * #yy347xgi (4): with a search shown in context ("Show the rest"), a link is idle only between two matches
 * (`spotlight`), faded otherwise. The cached picture's key carries the spotlight's version.
 */
export function linkColorFor(
  sourceId: string,
  targetId: string,
  hoveredId: string | null,
  colors: LinkColors,
  spotlight: ReadonlySet<string> | null = null,
): string {
  if (hoveredId === null) return spotlight && !(spotlight.has(sourceId) && spotlight.has(targetId)) ? colors.faded : colors.idle;
  return sourceId === hoveredId || targetId === hoveredId ? colors.active : colors.faded;
}

/** A link's dash: dashed to a page not created yet, else solid (null). */
export function linkDashFor(targetId: string): number[] | null {
  return isGhostId(targetId) ? GHOST_LINK_DASH : null;
}

/** The key's style part: every colour a resting link is drawn in, and the device pixel ratio (its width). */
export function linkLayerStyle(colors: LinkColors, dpr: number): string {
  return `${colors.idle}|${colors.faded}|${dpr}`;
}

/** What a link layer depends on: any change means it has to be drawn again. */
export interface LinkLayerInputs {
  /** The canvas transform (CSS px × DPR): a, d (scale) and e, f (translation). */
  transform: { a: number; b: number; c: number; d: number; e: number; f: number };
  /** The canvas size in device pixels. */
  width: number;
  height: number;
  /** Bumped whenever node positions change (the worker's updates, a drag). */
  positions: number;
  /** The drawn graph's identity (nodes, links, filters). */
  data: string;
  /** The link colours and the device pixel ratio. */
  style: string;
}

/**
 * #yy347xgi (4): the key's data part: the drawn graph's version and the spotlight's (a search shown in context
 * colours the links), so a search change rebuilds the picture.
 */
export function linkLayerData(dataVersion: number, spotlightVersion: number): string {
  return `${dataVersion}|${spotlightVersion}`;
}

export function linkLayerKey(inputs: LinkLayerInputs): string {
  const t = inputs.transform;
  return [t.a, t.b, t.c, t.d, t.e, t.f, inputs.width, inputs.height, inputs.positions, inputs.data, inputs.style].join("|");
}

/** The parts of a 2D context the layer draws with (a test can pass a recorder). */
export interface LinkPainter {
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
  setLineDash(segments: number[]): void;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
}

interface Endpoint {
  id?: string | number;
  x?: number;
  y?: number;
}

export interface LayerLink {
  source: unknown;
  target: unknown;
}

/**
 * #znabmb8n: the links as typed arrays, built once per data version: for each
 * link, the indices of its two nodes and whether it's dashed (a link to a page
 * not created yet). Painting then reads positions by index, with no allocation
 * and no string work per link.
 */
export interface LinkIndex {
  source: Uint32Array;
  target: Uint32Array;
  dashed: Uint8Array;
  /** The nodes the indices point into (their x/y are read when painting). */
  nodes: readonly Endpoint[];
  count: number;
}

export function buildLinkIndex(nodes: readonly Endpoint[], links: readonly LayerLink[], isDashed: (link: LayerLink) => boolean): LinkIndex {
  const byObject = new Map<unknown, number>();
  const byId = new Map<string, number>();
  nodes.forEach((node, i) => {
    byObject.set(node, i);
    if (node.id !== undefined) byId.set(String(node.id), i);
  });
  const find = (end: unknown): number | undefined =>
    byObject.get(end) ?? (end !== null && typeof end === "object" ? byId.get(String((end as Endpoint).id)) : byId.get(String(end)));
  const source = new Uint32Array(links.length);
  const target = new Uint32Array(links.length);
  const dashed = new Uint8Array(links.length);
  let count = 0;
  for (const link of links) {
    const s = find(link.source);
    const t = find(link.target);
    if (s === undefined || t === undefined) continue;
    source[count] = s;
    target[count] = t;
    dashed[count] = isDashed(link) ? 1 : 0;
    count += 1;
  }
  return { source, target, dashed, nodes, count };
}

/** The part of the graph (graph units) a canvas shows under `transform` (device px; no rotation). */
export function visibleGraphRect(
  transform: { a: number; d: number; e: number; f: number },
  width: number,
  height: number,
): { minX: number; minY: number; maxX: number; maxY: number } {
  const x0 = (0 - transform.e) / transform.a;
  const x1 = (width - transform.e) / transform.a;
  const y0 = (0 - transform.f) / transform.d;
  const y1 = (height - transform.f) / transform.d;
  return { minX: Math.min(x0, x1), maxX: Math.max(x0, x1), minY: Math.min(y0, y1), maxY: Math.max(y0, y1) };
}

/**
 * #znabmb8n: the part of segment (x0,y0)→(x1,y1) inside the rectangle, as
 * fractions [t0, t1] along it (Liang–Barsky), or null if it misses it.
 */
export function clipSegment(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  rect: { minX: number; minY: number; maxX: number; maxY: number },
): [number, number] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const edges: Array<[number, number]> = [
    [-dx, x0 - rect.minX],
    [dx, rect.maxX - x0],
    [-dy, y0 - rect.minY],
    [dy, rect.maxY - y0],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }
  return [t0, t1];
}

/**
 * Where a clipped dashed segment has to start so its dashes fall exactly where
 * they would on the whole segment: back from the clip point to the last whole
 * dash period measured from the segment's real start (a canvas restarts the dash
 * pattern at each subpath). Returns the fraction along the segment.
 */
export function dashAlignedStart(t0: number, length: number, period: number): number {
  if (t0 <= 0 || period <= 0 || length <= 0) return t0;
  const along = t0 * length;
  return (Math.floor(along / period) * period) / length;
}

/**
 * Every resting link as force-graph strokes it: plain links in one path, links
 * to a page not created yet in a second, dashed one; `lineWidth` is the CSS
 * width over the zoom, as force-graph sets it. Links whose ends haven't been
 * placed yet are skipped, as force-graph skips them.
 *
 * #znabmb8n: with `view` (the visible graph rectangle), a link whose segment's
 * bounding box lies wholly outside it (with a margin of one line width) is not
 * pathed: zoomed in, those were most links, and each still cost Skia's stroke,
 * clip and dash work (a rest frame at 8× took ~4× one at fit). A link crossing
 * the view, even with both ends outside, is kept, so nothing visible changes.
 */
export function paintRestingLinks(
  ctx: LinkPainter,
  index: LinkIndex,
  options: {
    color: string;
    widthCss: number;
    scale: number;
    dash: number[];
    view?: { minX: number; minY: number; maxX: number; maxY: number };
    /** #yy347xgi (4): only the links marked 1 here (the links between a search's matches). */
    only?: Uint8Array;
  },
): void {
  const lineWidth = options.widthCss / options.scale;
  const view = options.view;
  const minX = view ? view.minX - lineWidth : -Infinity;
  const maxX = view ? view.maxX + lineWidth : Infinity;
  const minY = view ? view.minY - lineWidth : -Infinity;
  const maxY = view ? view.maxY + lineWidth : Infinity;
  const { source, target, dashed, nodes, count } = index;
  const period = options.dash.reduce((sum, part) => sum + part, 0);
  ctx.strokeStyle = options.color;
  ctx.lineWidth = lineWidth;
  for (const pass of [0, 1] as const) {
    let started = false;
    for (let i = 0; i < count; i += 1) {
      if (dashed[i] !== pass) continue;
      if (options.only && options.only[i] !== 1) continue;
      const a = nodes[source[i]!]!;
      const b = nodes[target[i]!]!;
      const ax = a.x;
      const ay = a.y;
      const bx = b.x;
      const by = b.y;
      if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(bx) || !Number.isFinite(by)) continue;
      const x0 = ax as number;
      const y0 = ay as number;
      const x1 = bx as number;
      const y1 = by as number;
      if ((x0 < minX && x1 < minX) || (x0 > maxX && x1 > maxX) || (y0 < minY && y1 < minY) || (y0 > maxY && y1 > maxY)) continue;
      let sx = x0;
      let sy = y0;
      let ex = x1;
      let ey = y1;
      // A segment reaching outside the view is cut to it: Chrome dashes a whole path in one go and past ~1-2 M dash
      // intervals strokes it solid (#znabmb8n), so zoomed in on a big vault ghost links turned solid; the off-screen
      // length also cost time. A dashed one starts at a whole dash period, so its dashes stay where they were.
      if (view && (x0 < minX || x0 > maxX || y0 < minY || y0 > maxY || x1 < minX || x1 > maxX || y1 < minY || y1 > maxY)) {
        const cut = clipSegment(x0, y0, x1, y1, { minX, minY, maxX, maxY });
        if (!cut) continue;
        const t1 = cut[1];
        const t0 = pass === 1 ? dashAlignedStart(cut[0], Math.hypot(x1 - x0, y1 - y0), period) : cut[0];
        sx = x0 + (x1 - x0) * t0;
        sy = y0 + (y1 - y0) * t0;
        ex = x0 + (x1 - x0) * t1;
        ey = y0 + (y1 - y0) * t1;
      }
      if (!started) {
        ctx.beginPath();
        started = true;
      }
      ctx.moveTo(sx, sy);
      ctx.lineTo(ex, ey);
    }
    if (started) {
      ctx.setLineDash(pass === 1 ? options.dash : []);
      ctx.stroke();
    }
  }
  ctx.setLineDash([]);
}

/** #yy347xgi (4): marks the links whose both ends are in `ids` (a search's matches), for `paintRestingLinks`' `only`. */
export function linksWithin(index: LinkIndex, ids: ReadonlySet<string>): Uint8Array {
  const mask = new Uint8Array(index.count);
  for (let i = 0; i < index.count; i += 1) {
    const a = (index.nodes[index.source[i]!] as { id?: unknown } | undefined)?.id;
    const b = (index.nodes[index.target[i]!] as { id?: unknown } | undefined)?.id;
    if (typeof a === "string" && typeof b === "string" && ids.has(a) && ids.has(b)) mask[i] = 1;
  }
  return mask;
}
