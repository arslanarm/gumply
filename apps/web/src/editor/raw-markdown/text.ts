/**
 * Text and hard-break serialization that keeps files readable (#82x82ek7).
 *
 * tiptap-markdown HTML-escaped every text node (`a > b` was saved as
 * `a &gt; b`), and prosemirror-markdown backslash-escapes every `[`, `]`,
 * `*`, `_`, `~` and `` ` ``. Here a character is escaped only when, left
 * alone, it could change how the line parses. Obsidian syntax typed as text
 * (`==highlight==`, `$math$`, `[^1]`) is deliberately left unescaped, so it
 * means the same in Gumply and Obsidian after a reload.
 */
import HardBreak from "@tiptap/extension-hard-break";
import Text from "@tiptap/extension-text";
import type { Node as PMNode } from "@tiptap/pm/model";
import { BREAK_STYLE_ATTR } from "./markdown-plugin.js";

interface TextSerializerState {
  text(text: string, escape?: boolean): void;
  write(content?: string): void;
  atBlockStart?: boolean;
  inAutolink?: boolean;
  inTable?: boolean;
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
          // `text(…, false)` writes line by line with the block's prefix;
          // escaping is done here, per line, with our own rules.
          const escaped = value
            .split("\n")
            .map((line, index) =>
              escapeMarkdownText(line, index === 0 ? Boolean(state.atBlockStart) : true),
            )
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

export const MarkdownHardBreak = HardBreak.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      markdownStyle: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute(BREAK_STYLE_ATTR),
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
