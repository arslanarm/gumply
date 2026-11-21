/**
 * Text and hard-break serialization that keeps files readable (#82x82ek7).
 *
 * tiptap-markdown HTML-escaped every text node (`a > b` was saved as
 * `a &gt; b`), and prosemirror-markdown backslash-escapes every `[`, `]`,
 * `*`, `_`, `~` and `` ` ``. Here a character is escaped only when, left
 * alone, it could change how the line parses. Obsidian syntax typed as text
 * (`$math$`, `[^1]`) is deliberately left unescaped, so it means the same in
 * Gumply and Obsidian after a reload. `==highlight==` is a mark now; a
 * balanced `==x==` left in plain text was an escaped literal and stays one.
 */
import HardBreak from "@tiptap/extension-hard-break";
import Text from "@tiptap/extension-text";
import type { Node as PMNode } from "@tiptap/pm/model";
import { BREAK_SPACE_ATTR, BREAK_STYLE_ATTR } from "./markdown-plugin.js";

interface TextSerializerState {
  text(text: string, escape?: boolean): void;
  write(content?: string): void;
  out: string;
  atBlockStart?: boolean;
  inAutolink?: boolean;
  inTable?: boolean;
  /** #iatezw4m: the last thing written was a soft break. */
  afterSoftBreak?: boolean;
  /** prosemirror-markdown: the prefix written at the start of each line of a block. */
  delim?: string;
}

/**
 * #iatezw4m: escape a line that follows a soft break only where it would
 * *interrupt the paragraph* under CommonMark (and so turn into a heading,
 * quote, list, fence, rule or setext underline on reload). A line read from a
 * file can never look like that, since markdown-it would have split the
 * paragraph there, so untouched text keeps its bytes; text typed after a
 * break gets the backslash it needs. `2. item` can't interrupt and stays.
 */
export function escapeParagraphInterrupt(line: string): string {
  const indent = /^[ \t]*/.exec(line)?.[0] ?? "";
  // Four or more columns: a lazy continuation line, never a new block.
  if (indent.replace(/\t/g, "    ").length >= 4) return line;
  const rest = line.slice(indent.length);
  const escapeAt = (offset: number) => `${indent}${rest.slice(0, offset)}\\${rest.slice(offset)}`;
  if (/^#{1,6}(\s|$)/.test(rest)) return escapeAt(0);
  if (rest.startsWith(">")) return escapeAt(0);
  if (/^[-+*][ \t]+\S/.test(rest)) return escapeAt(0);
  if (/^1[.)][ \t]+\S/.test(rest)) return escapeAt(1);
  if (/^(```|~~~)/.test(rest)) return escapeAt(0);
  if (/^(=+|-+)[ \t]*$/.test(rest)) return escapeAt(0);
  if (/^([-*_])([ \t]*\1){2,}[ \t]*$/.test(rest)) return escapeAt(0);
  return line;
}

const ASCII_PUNCT = /[!-/:-@[-`{-~]/;
const TAG_LIKE = /^<(\/?[A-Za-z][\w-]*(\s[^>]*)?\/?>|!--|[A-Za-z][\w+.-]{1,31}:[^\s<>]*>|[^\s<>@]+@[^\s<>]+>)/;

function isSpace(char: string | undefined): boolean {
  return char === undefined || /\s/.test(char);
}

/** Escape what would otherwise turn into Markdown syntax. */
export function escapeMarkdownText(text: string, startOfLine: boolean): string {
  // Brackets only matter when they could form a link: `](`, `][`, `]:`.
  const linkish = /\]\s*[([:]/.test(text) || /^\[[^\]]*$/.test(text);
  // `==x==` in plain text is a literal the file had escaped (`\==x==`), since
  // a real highlight is a mark (#bg3cb83t). Escape its opening `=` so it
  // doesn't turn into a highlight on reload; `a == b` stays as typed.
  const highlightOpeners = new Set<number>();
  for (const match of text.matchAll(/(?<!=)==(?=[^\s=])(?:[^=]|=(?!=))*?[^\s=]==(?!=)/g)) {
    highlightOpeners.add(match.index ?? 0);
  }
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    const prev = text[i - 1];
    const next = text[i + 1];
    let escape = false;
    switch (char) {
      case "\\":
        // A backslash is literal unless it precedes punctuation (or ends the
        // text, where it could escape what follows, e.g. a mark delimiter).
        escape = next === undefined || ASCII_PUNCT.test(next);
        break;
      case "`":
        escape = true;
        break;
      case "*":
        // Spaces on both sides can never open or close emphasis.
        escape = !(isSpace(prev) && isSpace(next));
        break;
      case "~":
        // Strikethrough needs `~~`; a lone tilde is literal.
        // Escaping the first tilde of a pair is enough to break it.
        escape = next === "~" && prev !== "~" && !(isSpace(prev) && isSpace(text[i + 2]));
        break;
      case "_":
        // Intraword underscores are literal in CommonMark (snake_case).
        escape = !(
          (isSpace(prev) && isSpace(next)) ||
          (prev !== undefined && /[\p{L}\p{N}]/u.test(prev) && next !== undefined && /[\p{L}\p{N}]/u.test(next))
        );
        break;
      case "[":
      case "]":
        escape = linkish;
        break;
      case "<":
        // Only before something markdown-it would read as a tag, comment or
        // autolink; `a < b` and `a<b` stay as typed.
        escape = TAG_LIKE.test(text.slice(i));
        break;
      case "=":
        escape = highlightOpeners.has(i);
        break;
      case "&":
        // Only something that reads as an entity (`&amp;`, `&#38;`).
        escape = /^&(#\d+|#x[\da-f]+|[a-z][a-z\d]*);/i.test(text.slice(i));
        break;
      default:
        break;
    }
    out += escape ? `\\${char}` : char;
  }

  if (startOfLine) {
    out = out
      .replace(/^(\s*)([-+*])(?=\s|$)/, "$1\\$2")
      .replace(/^(\s*)>/, "$1\\>")
      .replace(/^(\s*)(#{1,6})(?=\s|$)/, "$1\\$2")
      .replace(/^(\s*\d+)([.)])(?=\s|$)/, "$1\\$2")
      .replace(/^(\s*)(=+|-+)(\s*)$/, "$1\\$2$3")
      .replace(/^(\s*)(```|~~~)/, "$1\\$2");
  }
  return out;
}

export const MarkdownText = Text.extend({
  addStorage() {
    return {
      markdown: {
        serialize(state: TextSerializerState, node: PMNode) {
          const value = node.text ?? "";
          if (state.inAutolink) {
            state.text(value, false);
            return;
          }
          // Right after a soft break, at the start of the line (nothing but the
          // block prefix and indent written yet): only paragraph interrupts.
          const afterSoft = state.afterSoftBreak === true && /(^|\n)[ \t>]*$/.test(state.out);
          state.afterSoftBreak = false;
          // `text(…, false)` writes line by line with the block's prefix;
          // escaping is done here, per line, with our own rules.
          const escaped = value
            .split("\n")
            .map((line, index) => {
              if (index === 0 && afterSoft) return escapeParagraphInterrupt(escapeMarkdownText(line, false));
              return escapeMarkdownText(line, index === 0 ? Boolean(state.atBlockStart) : true);
            })
            .join("\n");
          state.text(escaped, false);
        },
        parse: {
          // handled by markdown-it
        },
      },
    };
  },
});

/**
 * The next write starts the line with no block prefix (a lazy continuation
 * line, written at column 0 as in the source). One-shot: the serializer's own
 * `write` comes back right after.
 */
function skipNextPrefix(state: TextSerializerState): void {
  const target = state as unknown as { write: (content?: string) => void; out: string };
  target.write = (content?: string) => {
    delete (target as { write?: unknown }).write;
    target.out += content ?? "";
  };
}

export const MarkdownHardBreak = HardBreak.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      markdownStyle: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute(BREAK_STYLE_ATTR),
        renderHTML: () => ({}),
      },
      /**
       * #iatezw4m: `[before, after, lead?]` whitespace of a soft break, as
       * read: before the newline, the next line's indent within the block,
       * and that source line's whole leading whitespace.
       */
      markdownSpace: {
        default: null,
        parseHTML: (element: HTMLElement) => {
          try {
            const value = JSON.parse(element.getAttribute(BREAK_SPACE_ATTR) ?? "null") as unknown;
            return Array.isArray(value) &&
              (value.length === 2 || value.length === 3) &&
              value.every((part) => typeof part === "string" && /^[ \t]*$/.test(part))
              ? value
              : null;
          } catch {
            return null;
          }
        },
        renderHTML: () => ({}),
      },
    };
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: TextSerializerState, node: PMNode, parent: PMNode, index: number) {
          // A GFM table cell can't hold a line break: write a space.
          if (state.inTable) {
            if (index < parent.childCount - 1) state.write(" ");
            return;
          }
          // Like prosemirror-markdown: trailing breaks are dropped.
          for (let i = index + 1; i < parent.childCount; i += 1) {
            if (parent.child(i).type !== node.type) {
              if (node.attrs.markdownStyle === "soft") {
                // #iatezw4m: a single newline, as read (with its whitespace).
                const [before, after, lead] = (node.attrs.markdownSpace as [string, string, string?] | null) ?? ["", ""];
                state.afterSoftBreak = true;
                if (lead !== undefined && /^[ \t]*$/.test(state.delim ?? "")) {
                  // A list item's (or top-level) continuation line: its own
                  // indent, verbatim, instead of the list's nesting indent.
                  state.write(before);
                  state.out += `\n${lead}`;
                  if (lead === "") skipNextPrefix(state);
                  return;
                }
                state.write(`${before}\n`);
                if (after) state.write(after);
                return;
              }
              state.write(node.attrs.markdownStyle === "spaces" ? "  \n" : "\\\n");
              return;
            }
          }
        },
        parse: {
          // handled by markdown-it
        },
      },
    };
  },
});
