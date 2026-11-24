/**
 * #s3sszwux (iii), from N6 c0 (#9x4duwmg, @graph-dev): a big graph's links are
 * drawn into our own canvas with a **CPU** 2D context (`willReadFrequently`),
 * so they're rasterized as they're drawn, and the graph's canvas records one
 * `drawImage` instead of ~123k path operations. A full repaint of the big
 * canvas otherwise commits a huge recorded display list (1.3–1.8 s every time
 * at 4×, occasionally 80–150 s: the first-open stall).
 *
 * N6 c0: a big graph's links drawn at half resolution. The cost
 * of a 10k graph's frame is the raster of its anti-aliased link lines (the
 * pixels they cover), not the number of draw calls; drawn into a canvas of
 * half the width and height, that is a quarter of the pixels. The layer is then
 * scaled up under the dots, which (with labels and hulls) stay at full
 * resolution. At fit the links are a grey mass, so the softer line doesn't show.
 */

/** One drawn style: links in a slot share one path and one stroke. */
export interface LinkSlotStyle {
  color: string;
  /** In CSS px on screen, like force-graph's linkWidth. */
  width: number;
  dash: readonly number[] | null;
  /** A multiplier on the colour's alpha (the half-resolution density match), 1 by default. */
  alpha?: number;
}

interface Positioned {
  x?: number;
  y?: number;
}

/** The layer's canvas and its CPU context, kept between frames (one per graph view). */
export interface LinkLayer {
  canvas: HTMLCanvasElement | null;
  context?: CanvasRenderingContext2D | null;
}

/**
 * The layer's 2D context: CPU-backed (`willReadFrequently`), so drawing
 * rasterizes at once instead of recording for the compositor. The attribute
 * only takes effect on a canvas's first `getContext`, so it's made once.
 */
export function layerContext(layer: LinkLayer): CanvasRenderingContext2D | null {
  layer.canvas ??= document.createElement("canvas");
  layer.context ??= layer.canvas.getContext("2d", { willReadFrequently: true });
  return layer.context;
}

/**
 * The layer's resolution as a share of the main canvas. 1: the same pixels, so
 * the links look exactly as force-graph drew them (half resolution made the
 * grey mass lighter at fit and the lines soft when zoomed in, #s3sszwux). The
 * stall fix is the links being off force-graph's composited canvas, drawn on a
 * CPU canvas and copied as one image, not the lower resolution (to confirm).
 */
export const LINK_LAYER_FACTOR = 0.5;

/**
 * #s3sszwux (iii, half resolution): no line thinner than this many **layer** px.
 * A 1 px link is half a layer pixel at half resolution, which composes lighter
 * and aliases into grain when upscaled; at least one layer pixel (two screen
 * pixels) it doesn't.
 *
 * **Never above 1.** One stroke of ~123k segments is 282 ms at 1 px but 54 s at
 * 3 px (headless Chromium, software raster): past one device pixel Skia leaves its
 * hairline path. At 1 layer pixel (= main's width 2 at full resolution), a
 * synthetic density grid matched main's mean luminance within ~1/255 in both
 * themes (light −1.0, dark +0.03); the grid saturates, so it can't rank values
 * finer than that: the check is the shots against main at fit.
 */
export const LINK_LAYER_MIN_PX = 1;

/**
 * The idle links' alpha multiplier at half resolution, so the mass at fit is as
 * dark as main's. 1 (main's 0.32): with a 1-layer-pixel line the grid found no
 * better alpha within its resolution; adjust only from the shots against main.
 */
export const LINK_LAYER_IDLE_ALPHA = 1;

/** The layer's size for a main canvas of `width` × `height` device px, at `factor` (rounded up, never empty). */
export function layerSize(width: number, height: number, factor = LINK_LAYER_FACTOR): { width: number; height: number } {
  return { width: Math.max(1, Math.ceil(width * factor)), height: Math.max(1, Math.ceil(height * factor)) };
}

/**
 * Group links by slot: `slotOf` gives each link its style slot, or -1 when it
 * isn't drawn. Returns, per slot, the flat endpoint coordinates
 * [x1, y1, x2, y2, …] of its links with both ends placed.
 */
export function groupLinks<L extends { source: unknown; target: unknown }>(
  links: readonly L[],
  slots: number,
  slotOf: (link: L) => number,
): number[][] {
  const groups: number[][] = Array.from({ length: slots }, () => []);
  for (const link of links) {
    const slot = slotOf(link);
    if (slot < 0 || slot >= slots) continue;
    const a = link.source as Positioned;
    const b = link.target as Positioned;
    if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) continue;
    const { x: x1, y: y1 } = a;
    const { x: x2, y: y2 } = b;
    if (!Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x2) || !Number.isFinite(y2)) continue;
    groups[slot]!.push(x1 as number, y1 as number, x2 as number, y2 as number);
  }
  return groups;
}

/**
 * Draw the links into the half-resolution layer with the main context's
 * camera, then onto the main canvas. `scale` is force-graph's globalScale.
 */
export function drawLinkLayer<L extends { source: unknown; target: unknown }>(
  main: CanvasRenderingContext2D,
  layer: LinkLayer,
  links: readonly L[],
  styles: readonly LinkSlotStyle[],
  slotOf: (link: L) => number,
  scale: number,
): number[] {
  const size = layerSize(main.canvas.width, main.canvas.height);
  const ctx = layerContext(layer);
  const canvas = layer.canvas;
  if (!ctx || !canvas) return [];
  if (canvas.width !== size.width) canvas.width = size.width;
  if (canvas.height !== size.height) canvas.height = size.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // The main camera, at half the pixels.
  const t = main.getTransform();
  const sx = canvas.width / main.canvas.width;
  const sy = canvas.height / main.canvas.height;
  ctx.setTransform(t.a * sx, t.b * sy, t.c * sx, t.d * sy, t.e * sx, t.f * sy);
  const k = Math.max(scale, 1e-3);
  // Layer pixels per graph unit, for the minimum line width.
  const layerScale = Math.max(Math.hypot(t.a * sx, t.b * sy), 1e-6);
  const minWidth = LINK_LAYER_MIN_PX / layerScale;
  const groups = groupLinks(links, styles.length, slotOf);
  groups.forEach((coords, slot) => {
    if (coords.length === 0) return;
    const style = styles[slot]!;
    ctx.globalAlpha = style.alpha ?? 1;
    ctx.beginPath();
    for (let i = 0; i + 3 < coords.length; i += 4) {
      ctx.moveTo(coords[i]!, coords[i + 1]!);
      ctx.lineTo(coords[i + 2]!, coords[i + 3]!);
    }
    ctx.strokeStyle = style.color;
    ctx.lineWidth = Math.max(style.width / k, minWidth);
    ctx.setLineDash(style.dash ? [...style.dash] : []);
    ctx.stroke();
  });
  ctx.globalAlpha = 1;
  main.save();
  main.setTransform(1, 0, 0, 1, 0, 0);
  main.imageSmoothingEnabled = true;
  main.drawImage(canvas, 0, 0, main.canvas.width, main.canvas.height);
  main.restore();
  // How many links each slot drew (for the dev probe).
  return groups.map((coords) => coords.length / 4);
}
