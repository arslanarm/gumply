/**
 * The one definition of what may sit inside `[[…]]` and `![[…]]` (#wf4hhfj7).
 *
 * As in Obsidian: no `[` or `]`, and never a line break, so a link split
 * across lines is plain text (#pvrx7t6r). Every pattern that reads wikilinks
 * or embeds, in core and in the web app, is built from these, so they can't
 * drift apart again. Tests pin each call site, and a source-scan tripwire
 * flags new hand-written RegExp literals.
 *
 * They are RegExp source fragments, for `new RegExp(String.raw`…`)`.
 */

/** Any character allowed inside `[[…]]`. */
export const WIKILINK_INNER = String.raw`[^[\]\r\n]`;

/** A character of the target alone: also not `|` (alias) or `#` (heading or block). */
export const WIKILINK_TARGET = String.raw`[^[\]|#\r\n]`;

/** A character up to the alias: also not `|` (a target with its `#part`). */
export const WIKILINK_PART = String.raw`[^[\]|\r\n]`;

/**
 * Put before `\[\[`: the opener isn't escaped. `\[[x]]` is plain text in
 * Obsidian (the backslash escapes the first `[`); `\\[[x]]` is a link again
 * (an escaped backslash). That is, not after an odd run of backslashes.
 */
export const WIKILINK_UNESCAPED = String.raw`(?<!(?<!\\)\\(?:\\\\)*)`;

/** Whether `text` can be the inside of a `[[…]]` (for parsers that don't use a RegExp). */
export function isWikilinkInner(text: string): boolean {
  return !/[[\]\r\n]/.test(text);
}
