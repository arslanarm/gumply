/**
 * #hz23dqif (from @kaktuzz): Enter after bold, italic or coloured text starts
 * the new line plain, as Notion does; the formatting stays on the text it was
 * put on. Shift+Enter (a line break inside the block) starts plain too, so a
 * new line is always plain. Typing on in the same line keeps the formatting.
 *
 * TipTap carries the cursor's marks over a split (Enter, a list or task item's
 * Enter, Shift+Enter) unless the mark says `keepOnSplit: false`. StarterKit's
 * bold, italic and strike are registered here with that; Gumply's own marks
 * (code, highlight, the colours) say it where they're made, and the link mark
 * already does. Only what's typed next changes, never the file's bytes (D37).
 */
import Bold from "@tiptap/extension-bold";
import Italic from "@tiptap/extension-italic";
import Strike from "@tiptap/extension-strike";

export const PlainSplitBold = Bold.extend({ keepOnSplit: false });
export const PlainSplitItalic = Italic.extend({ keepOnSplit: false });
export const PlainSplitStrike = Strike.extend({ keepOnSplit: false });
