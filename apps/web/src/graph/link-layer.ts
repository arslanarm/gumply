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
  x?: number;
  y?: number;
}

export interface LayerLink {
  source: unknown;
  target: unknown;
}

const point = (value: unknown): Endpoint | null =>
  value !== null && typeof value === "object" && Number.isFinite((value as Endpoint).x) && Number.isFinite((value as Endpoint).y)
    ? (value as Endpoint)
    : null;

/**
 * Every resting link as force-graph strokes it: plain links in one path, links
 * to a page not created yet (`isDashed`) in a second, dashed one; `lineWidth`
 * is the CSS width over the zoom, as force-graph sets it. Links whose ends
 * haven't been placed yet are skipped, as force-graph skips them.
 */
export function paintRestingLinks(
  ctx: LinkPainter,
  links: readonly LayerLink[],
  options: { color: string; widthCss: number; scale: number; dash: number[]; isDashed: (link: LayerLink) => boolean },
): void {
  const plain: Array<[Endpoint, Endpoint]> = [];
  const dashed: Array<[Endpoint, Endpoint]> = [];
  for (const link of links) {
    const start = point(link.source);
    const end = point(link.target);
    if (!start || !end) continue;
    (options.isDashed(link) ? dashed : plain).push([start, end]);
  }
  ctx.strokeStyle = options.color;
  ctx.lineWidth = options.widthCss / options.scale;
  for (const [group, segments] of [[plain, [] as number[]], [dashed, options.dash]] as const) {
    if (group.length === 0) continue;
    ctx.beginPath();
    for (const [start, end] of group) {
      ctx.moveTo(start.x as number, start.y as number);
      ctx.lineTo(end.x as number, end.y as number);
    }
    ctx.setLineDash(segments);
    ctx.stroke();
  }
  ctx.setLineDash([]);
}
