/**
 * #s3sszwux (vi): the resting link width, in CSS px, so its stroke stays just under one
 * **device** pixel at any device pixel ratio. force-graph strokes every link of a colour as one
 * path with `width / globalScale` under a `globalScale × devicePixelRatio` transform, so the
 * device width is `width × devicePixelRatio`. At one device pixel or more (1 px at DPR 1 when
 * floating point lands a hair above 1, 2 px at DPR 2), Skia leaves its hairline path and that
 * one ~123k-segment stroke rasterizes in tens of seconds instead of ~0.3 s.
 */
export function restingLinkWidth(devicePixelRatio: number): number {
  const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return 0.99 / ratio;
}

/** The hovered node's links, drawn wider (their own small path, so off the batched stroke). */
export const ACTIVE_LINK_WIDTH = 1.7;

/**
 * The whole link-width rule `GraphCanvas` passes to force-graph: a link touching the hovered node
 * is active, every other link (resting, or faded while something is hovered) gets the resting
 * width, so the big batched stroke never reaches one device pixel. `graph-hairline.test.ts`
 * guards it through this function, so a change here can't quietly bring the stall back.
 */
export function linkWidthFor(
  sourceId: string,
  targetId: string,
  hoveredId: string | null,
  devicePixelRatio: number,
): number {
  if (hoveredId !== null && (sourceId === hoveredId || targetId === hoveredId)) return ACTIVE_LINK_WIDTH;
  return restingLinkWidth(devicePixelRatio);
}

/**
 * N6 3b (#9x4duwmg): the dashed ghost circles ("not created yet") are one batched stroke of every
 * ghost too (~6k on the 10k vault), under the same `k × devicePixelRatio` transform. Stroked at
 * `1.4 / k` they were 1.4 device px at DPR 1 and 2.8 at DPR 2, off Skia's hairline path (a probe:
 * 64 ms at DPR 2, 17 ms just under one device px). Same rule as the links: just under one device
 * pixel at any ratio, so the dashes are as thin as a link.
 */
export function ghostStrokeWidth(devicePixelRatio: number): number {
  return restingLinkWidth(devicePixelRatio);
}
