/**
 * Shared emoji data for the page-icon picker and the editor's emoji features.
 *
 * The full set (~1,900 emoji with names, keywords and shortcodes, generated
 * from emojibase-data by `npm run emoji:data`) lives in `emoji-data.json` and
 * is loaded on demand with `loadEmojiData()`, so it never weighs on the main
 * bundle. Everything else in this file is small and synchronous.
 */

export const CATEGORY_IDS = [
  "smileys",
  "people",
  "nature",
  "food",
  "travel",
  "activities",
  "objects",
  "symbols",
  "flags",
] as const;

export type EmojiCategoryId = (typeof CATEGORY_IDS)[number];

export interface EmojiCategory {
  id: EmojiCategoryId;
  label: string;
  /** Emoji shown on the category tab. */
  icon: string;
}

export const EMOJI_CATEGORIES: readonly EmojiCategory[] = [
  { id: "smileys", label: "Smileys & emotion", icon: "😀" },
  { id: "people", label: "People & body", icon: "👋" },
  { id: "nature", label: "Animals & nature", icon: "🌿" },
  { id: "food", label: "Food & drink", icon: "🍔" },
  { id: "travel", label: "Travel & places", icon: "✈️" },
  { id: "activities", label: "Activities", icon: "⚽" },
  { id: "objects", label: "Objects", icon: "💡" },
  { id: "symbols", label: "Symbols", icon: "❤️" },
  { id: "flags", label: "Flags", icon: "🏳️" },
];

export interface EmojiEntry {
  emoji: string;
  /** Lower-case CLDR name, e.g. "rocket". */
  name: string;
  keywords: string[];
  /** Without colons, e.g. ["rocket"], ["+1", "thumbsup"]. */
  shortcodes: string[];
  category: EmojiCategoryId;
  /** Unicode emoji version it first appeared in. */
  version: number;
}

type EmojiRow = [string, string, string, string, number, number];

const split = (value: string): string[] => (value ? value.split(" ") : []);

/** Expand the compact JSON rows. Exported for tests. */
export function parseEmojiRows(rows: readonly EmojiRow[]): EmojiEntry[] {
  return rows.map(([emoji, name, keywords, shortcodes, category, version]) => ({
    emoji,
    name,
    keywords: split(keywords),
    shortcodes: split(shortcodes),
    category: CATEGORY_IDS[category] ?? "symbols",
    version,
  }));
}

let loading: Promise<EmojiEntry[]> | null = null;
let loaded: EmojiEntry[] | null = null;

/**
 * The full emoji list in the standard order, minus emoji this system's font
 * cannot draw. Loaded once, then cached.
 */
export function loadEmojiData(): Promise<EmojiEntry[]> {
  if (!loading) {
    loading = import("./emoji-data.json")
      .then((module) => {
        const all = parseEmojiRows(module.default as unknown as EmojiRow[]);
        loaded = all.filter(supportedVersionFilter(all));
        return loaded;
      })
      .catch((error: unknown) => {
        loading = null;
        throw error;
      });
  }
  return loading;
}

/** The list if `loadEmojiData()` has already resolved, else null. */
export function emojiDataIfLoaded(): EmojiEntry[] | null {
  return loaded;
}

/** Look up one emoji (ignores the U+FE0F presentation selector). */
export function findEmoji(entries: readonly EmojiEntry[], emoji: string): EmojiEntry | undefined {
  const bare = stripVariation(emoji);
  return entries.find((entry) => entry.emoji === emoji || stripVariation(entry.emoji) === bare);
}

const stripVariation = (value: string) => value.replace(/️/g, "");

// ---------- Search ----------

const normalise = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/^:+|:+$/g, "")
    .trim();

/**
 * Rank how well `entry` matches one query word (higher is better, 0 = no
 * match). Name and shortcode beat keywords, whole words beat prefixes, prefixes
 * beat substrings.
 */
function scoreWord(entry: EmojiEntry, word: string): number {
  const nameWords = entry.name.split(/[\s:,-]+/);
  if (entry.name === word || entry.shortcodes.includes(word)) return 100;
  if (nameWords.includes(word)) return 80;
  if (entry.keywords.includes(word)) return 60;
  if (entry.shortcodes.some((code) => code.startsWith(word))) return 55;
  if (nameWords.some((part) => part.startsWith(word))) return 50;
  if (entry.keywords.some((keyword) => keyword.startsWith(word))) return 35;
  if (word.length >= 3 && entry.name.includes(word)) return 20;
  if (word.length >= 3 && entry.keywords.some((keyword) => keyword.includes(word))) return 10;
  return 0;
}

/**
 * Search by name, keyword or shortcode ("rocket", "heart", ":+1", "thumbs up").
 * Every query word has to match; results are best first, then in the standard
 * emoji order. An empty query returns nothing.
 */
export function searchEmoji(
  entries: readonly EmojiEntry[],
  query: string,
  limit = Infinity,
): EmojiEntry[] {
  const q = normalise(query);
  if (!q) return [];
  const words = q.split(/[\s_]+/).filter(Boolean);
  const phrase = q.replace(/_/g, " ");

  const scored: { entry: EmojiEntry; score: number; index: number }[] = [];
  entries.forEach((entry, index) => {
    let score = 0;
    for (const word of words) {
      const wordScore = scoreWord(entry, word);
      if (wordScore === 0) return;
      score += wordScore;
    }
    // Whole-phrase bonuses: "thumbs up" → 👍 before 👆.
    if (words.length > 1 && entry.name === phrase) score += 200;
    else if (words.length > 1 && entry.name.startsWith(phrase)) score += 60;
    // Prefer shorter names among equal matches ("heart" → ❤️ before 💔).
    score -= entry.name.length / 100;
    scored.push({ entry, score, index });
  });

  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, limit).map((item) => item.entry);
}

// ---------- Pasted / typed emoji ----------

const PICTOGRAPHIC = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;

/**
 * The first emoji in `text` (one full grapheme, e.g. "👩🏽‍💻" or "🇯🇵"), or null
 * when the text starts with anything else. Used for pasting any emoji —
 * including skin-tone variants that are not in the list — into the picker.
 */
export function firstEmoji(text: string): string | null {
  const value = text.trim();
  if (!value) return null;
  let first: string | undefined;
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    first = segmenter.segment(value)[Symbol.iterator]().next().value?.segment;
  } else {
    first = Array.from(value)[0];
  }
  if (!first || !PICTOGRAPHIC.test(first)) return null;
  // Digits, # and * are only emoji as keycaps (with U+20E3).
  if (/^[0-9#*]/.test(first) && !first.includes("⃣")) return null;
  return first;
}

// ---------- Font support ----------

/**
 * Some systems' emoji fonts lag behind Unicode. Probe the newest emoji of each
 * version once and drop versions the font draws as tofu or as split-up ZWJ
 * sequences. Without a canvas (tests, very old browsers) everything is kept.
 */
function supportedVersionFilter(entries: readonly EmojiEntry[]): (entry: EmojiEntry) => boolean {
  const maxVersion = maxSupportedVersion(entries);
  return (entry) => entry.version <= maxVersion;
}

function maxSupportedVersion(entries: readonly EmojiEntry[]): number {
  const probe = createProbe();
  if (!probe) return Infinity;
  const versions = [...new Set(entries.map((entry) => entry.version))]
    .filter((version) => version > 12)
    .sort((a, b) => a - b);
  let max = 12;
  for (const version of versions) {
    const samples = entries.filter((entry) => entry.version === version).slice(0, 3);
    if (!samples.some((entry) => probe(entry.emoji))) break;
    max = version;
  }
  return versions.length ? max : Infinity;
}

function createProbe(): ((emoji: string) => boolean) | null {
  if (typeof document === "undefined") return null;
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 32;
    ctx = canvas.getContext("2d", { willReadFrequently: true });
  } catch {
    return null;
  }
  if (!ctx || typeof ctx.getImageData !== "function") return null;
  const c = ctx;
  c.font = '24px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
  c.textBaseline = "top";
  const reference = c.measureText("😀").width;
  if (!reference) return null;

  return (emoji) => {
    // A split-up ZWJ sequence draws as several glyphs side by side.
    if (c.measureText(emoji).width > reference * 1.4) return false;
    c.clearRect(0, 0, 64, 32);
    c.fillStyle = "#000";
    c.fillText(emoji, 0, 0);
    const pixels = c.getImageData(0, 0, 32, 32).data;
    // Tofu is drawn in fillStyle (black); real emoji have colour.
    for (let i = 0; i < pixels.length; i += 4) {
      const [r, g, b, a] = [pixels[i]!, pixels[i + 1]!, pixels[i + 2]!, pixels[i + 3]!];
      if (a > 0 && (Math.abs(r - g) > 12 || Math.abs(g - b) > 12 || Math.abs(r - b) > 12)) {
        return true;
      }
    }
    return false;
  };
}
