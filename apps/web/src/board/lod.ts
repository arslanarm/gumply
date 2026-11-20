/**
 * Level of detail (#bdzcggf5). Far zoomed out, text on a big board is only a
 * few pixels high: unreadable, yet painting it is most of the cost of every
 * frame. Like Miro and FigJam, the board then draws text as placeholder bars,
 * keeping shapes, colours, card outlines, icons, frames and connectors.
 *
 * Text comes in size buckets (by its font size in board units). A bucket
 * turns into bars once it would be at most LOD_SCREEN_PX high on screen, and
 * comes back slightly later when zooming in (hysteresis, so it doesn't flicker
 * at the threshold). The board root carries the level as `data-lod`; CSS does
 * the rest, so no object re-renders when the level changes.
 */

/** Text this small on screen (CSS px) is drawn as bars. */
export const LOD_SCREEN_PX = 4;

/** Largest font size (board px) of each bucket, 1 to 5. */
export const LOD_BUCKET_PX = [13, 16, 20, 24, 28] as const;

/** Text reappears only once the zoom is this much past the threshold. */
export const LOD_HYSTERESIS = 1.12;

export type LodLevel = 0 | 1 | 2 | 3 | 4 | 5;

/** The size bucket (1 to 5, as `data-text-size`) of text set at `fontPx`. */
export function textBucket(fontPx: number): string {
  const index = LOD_BUCKET_PX.findIndex((max) => fontPx <= max);
  return String(index === -1 ? LOD_BUCKET_PX.length : index + 1);
}

/**
 * How many buckets are drawn as bars at `zoom`: 0 = all text real, n = buckets
 * 1…n (the n smallest sizes) as bars. `previous` is the current level (for
 * hysteresis).
 */
export function lodLevel(zoom: number, previous: LodLevel = 0): LodLevel {
  let level = 0;
  for (let bucket = 0; bucket < LOD_BUCKET_PX.length; bucket += 1) {
    const threshold = LOD_SCREEN_PX / LOD_BUCKET_PX[bucket]!;
    // Already bars: stay bars until clearly legible again.
    const limit = bucket < previous ? threshold * LOD_HYSTERESIS : threshold;
    if (zoom <= limit) level = bucket + 1;
  }
  return level as LodLevel;
}
