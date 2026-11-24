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
export const LINK_LAYER_FACTOR = 1;

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
  const groups = groupLinks(links, styles.length, slotOf);
  groups.forEach((coords, slot) => {
    if (coords.length === 0) return;
    const style = styles[slot]!;
    ctx.beginPath();
    for (let i = 0; i + 3 < coords.length; i += 4) {
      ctx.moveTo(coords[i]!, coords[i + 1]!);
      ctx.lineTo(coords[i + 2]!, coords[i + 3]!);
    }
    ctx.strokeStyle = style.color;
    ctx.lineWidth = style.width / k;
    ctx.setLineDash(style.dash ? [...style.dash] : []);
    ctx.stroke();
  });
  main.save();
  main.setTransform(1, 0, 0, 1, 0, 0);
  main.imageSmoothingEnabled = true;
  main.drawImage(canvas, 0, 0, main.canvas.width, main.canvas.height);
  main.restore();
  // How many links each slot drew (for the dev probe).
  return groups.map((coords) => coords.length / 4);
}
