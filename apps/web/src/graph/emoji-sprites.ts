/**
 * Page-icon emoji for graph nodes (#emmyabbj), pre-rendered once per emoji to
 * a small offscreen canvas. Each frame then only does a `drawImage`, which is
 * cheap and GPU-friendly; shaping and rasterising colour-emoji text every frame
 * for hundreds of nodes is not.
 */

/** Sprite edge in device px: crisp up to a ~24 px node at 3× DPR. */
const SPRITE_PX = 96;
const EMOJI_FONT =
  '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Twemoji Mozilla", "EmojiOne Color", sans-serif';

const cache = new Map<string, HTMLCanvasElement | null>();

/** Drawn size (CSS px) of an emoji node whose dot would have `radius`. */
export function emojiNodeSize(radius: number): number {
  return Math.round(radius * 2 + 6);
}

/** The icon's first grapheme (so "👩‍💻" or "🇳🇱" stay whole), or null when there is none. */
export function normaliseIcon(icon: string | undefined | null): string | null {
  const value = (icon ?? "").trim();
  if (!value) return null;
  const Segmenter = (Intl as unknown as { Segmenter?: new (locale?: string, options?: { granularity: string }) => { segment: (input: string) => Iterable<{ segment: string }> } }).Segmenter;
  if (Segmenter) {
    for (const part of new Segmenter(undefined, { granularity: "grapheme" }).segment(value)) {
      return part.segment;
    }
  }
  return [...value].slice(0, 2).join("");
}

/** The cached sprite for an emoji, rendering it on first use. Null without a DOM. */
export function emojiSprite(emoji: string): HTMLCanvasElement | null {
  const cached = cache.get(emoji);
  if (cached !== undefined) return cached;
  let sprite: HTMLCanvasElement | null = null;
  if (typeof document !== "undefined") {
    sprite = document.createElement("canvas");
    sprite.width = SPRITE_PX;
    sprite.height = SPRITE_PX;
    const ctx = sprite.getContext("2d");
    if (ctx) {
      ctx.font = `${Math.round(SPRITE_PX * 0.8)}px ${EMOJI_FONT}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      // Centre the glyph's ink box, not its baseline: emoji fonts differ.
      const metrics = ctx.measureText(emoji);
      const ascent = metrics.actualBoundingBoxAscent || SPRITE_PX * 0.7;
      const descent = metrics.actualBoundingBoxDescent || SPRITE_PX * 0.1;
      ctx.fillText(emoji, SPRITE_PX / 2, SPRITE_PX / 2 + (ascent - descent) / 2);
    } else {
      sprite = null;
    }
  }
  cache.set(emoji, sprite);
  return sprite;
}
