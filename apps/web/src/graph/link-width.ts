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
