/**
 * When typing `:` opens emoji suggestions (#6v8tyxfd), Notion-style:
 * `:roc` → 🚀 suggestions once two characters follow the colon.
 *
 * No trigger:
 * - after a letter, digit or other non-opening character (`12:30`, `http:`,
 *   `a:b`, `example.com/x:y`);
 * - inside code (code blocks, inline code); the caller checks that;
 * - with a space in the query (`: not this`).
 */

/** Characters after which a `:` may start an emoji query. */
const OPENERS = /[\s([{"'“‘«]/;
const QUERY = /^[a-z0-9_+-]{2,32}$/i;

export interface EmojiQuery {
  /** Text after the colon, e.g. `roc`. */
  query: string;
  /** Index of the `:` in `textBefore`. */
  colon: number;
}

/** The emoji query that ends at the caret, given the block text before it. */
export function findEmojiQuery(textBefore: string): EmojiQuery | null {
  const colon = textBefore.lastIndexOf(":");
  if (colon === -1) return null;
  const query = textBefore.slice(colon + 1);
  if (!QUERY.test(query)) return null;
  const before = colon > 0 ? textBefore[colon - 1]! : null;
  if (before !== null && !OPENERS.test(before)) return null;
  return { query, colon };
}
