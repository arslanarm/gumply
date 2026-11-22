/**
 * Keep empty lines (empty top-level paragraphs) across save + reload.
 *
 * Markdown has no "empty paragraph": the serializer used to drop them and
 * markdown-it collapses any run of blank lines, so every empty line the user
 * typed vanished after a reload (#jmg9g5t3).
 *
 * On disk an empty line is written as one extra blank line between blocks, so
 * the file stays clean Markdown and reads the same in any editor:
 *
 *     First            → First
 *                        (empty line)
 *                        Second
 *
 *     Second
 *
 * Two places can't carry a blank line, so there the empty line is written as
 * a paragraph holding only `&nbsp;` (which every Markdown renderer shows as an
 * empty line):
 * - at the very start of the body (leading blank lines are trimmed with the
 *   frontmatter);
 * - between two lists (blank lines don't end a CommonMark list, so the two
 *   lists would merge into one loose list).
 * Trailing empty lines at the end of a page are not kept, like a text editor
 * trimming trailing whitespace.
 */
import Paragraph from "@tiptap/extension-paragraph";
import type { Node as PMNode } from "@tiptap/pm/model";

// markdown-it is an optional peer dep of tiptap-markdown without bundled
// types here, so describe the small part of its API this rule touches.
interface Token {
  type: string;
  level: number;
  nesting: number;
  map: [number, number] | null;
  content: string;
  children: Token[] | null;
  block: boolean;
}

interface StateCore {
  src: string;
  tokens: Token[];
  Token: new (type: string, tag: string, nesting: number) => Token;
}

interface MarkdownIt {
  core: { ruler: { after(name: string, rule: string, fn: (state: StateCore) => void): void } };
}

export const EMPTY_LINE_MARKER = "&nbsp;";

const LIST_TYPES = new Set(["bulletList", "orderedList", "taskList"]);

/** Minimal surface of prosemirror-markdown's serializer state we use. */
export interface EmptyLineSerializerState {
  write(content?: string): void;
  renderInline(node: PMNode): void;
  closeBlock(node: PMNode): void;
}

function isEmptyParagraph(node: PMNode | null | undefined): boolean {
  return node?.type.name === "paragraph" && node.childCount === 0;
}

/** How an empty top-level paragraph at `index` must be written. */
export function emptyLineForm(parent: PMNode, index: number): "blank" | "marker" | "skip" {
  // Find the run of empty paragraphs this one belongs to.
  let start = index;
  while (start > 0 && isEmptyParagraph(parent.child(start - 1))) start -= 1;
  let end = index;
  while (end < parent.childCount - 1 && isEmptyParagraph(parent.child(end + 1))) end += 1;

  const before = start > 0 ? parent.child(start - 1) : null;
  const after = end < parent.childCount - 1 ? parent.child(end + 1) : null;

  // Trailing empty lines are dropped (nothing would follow to keep them).
  if (!after) return "skip";
  // Leading run: the first line becomes `&nbsp;`, later ones blank lines.
  if (!before) return index === start ? "marker" : "blank";
  // Between two lists: the last line separates them as `&nbsp;`.
  if (LIST_TYPES.has(before.type.name) && LIST_TYPES.has(after.type.name)) {
    return index === end ? "marker" : "blank";
  }
  return "blank";
}

/** Markdown serializer for paragraphs that keeps empty top-level ones. */
export function serializeParagraph(
  state: EmptyLineSerializerState,
  node: PMNode,
  parent: PMNode,
  index: number,
): void {
  if (node.childCount === 0 && parent.type.name === "doc") {
    const form = emptyLineForm(parent, index);
    if (form === "skip") return;
    // write("") flushes the previous block's separator; closing this block
    // then adds one more blank line before the next block.
    state.write(form === "marker" ? EMPTY_LINE_MARKER : "");
    state.closeBlock(node);
    return;
  }
  // An indented first line (`  Text`, #ftx3awn7) keeps its spaces.
  const indent = node.attrs.markdownIndent as string | null | undefined;
  if (indent && parent.type.name === "doc") state.write(indent);
  state.renderInline(node);
  state.closeBlock(node);
}

function emptyParagraphTokens(state: StateCore): Token[] {
  const open = new state.Token("paragraph_open", "p", 1);
  open.block = true;
  const inline = new state.Token("inline", "", 0);
  inline.children = [];
  inline.content = "";
  const close = new state.Token("paragraph_close", "p", -1);
  close.block = true;
  return [open, inline, close];
}

function isBlank(line: string | undefined): boolean {
  return line === undefined || line.trim().length === 0;
}

/**
 * markdown-it core rule: turn each extra blank line between top-level blocks
 * into an empty paragraph, and a top-level `&nbsp;`-only paragraph into an
 * empty one.
 */
export function emptyLinesRule(state: StateCore): void {
  const lines = state.src.split("\n");
  const tokens = state.tokens;
  const out: Token[] = [];
  // Last source line (exclusive) holding content of the previous block.
  let previousEnd: number | null = null;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    const opensTopLevelBlock = token.level === 0 && token.nesting >= 0 && token.map;

    if (opensTopLevelBlock && token.map) {
      const [startLine, endLine] = token.map;
      if (previousEnd !== null) {
        const extra = startLine - previousEnd - 1;
        for (let n = 0; n < extra; n += 1) out.push(...emptyParagraphTokens(state));
      }
      // Lists (and some other blocks) include trailing blank lines in map.
      let contentEnd = endLine;
      while (contentEnd > startLine && isBlank(lines[contentEnd - 1])) contentEnd -= 1;
      previousEnd = contentEnd;

      if (token.type === "paragraph_open") {
        const inline = tokens[i + 1];
        if (inline?.type === "inline" && inline.content.trim() === EMPTY_LINE_MARKER) {
          inline.content = "";
          inline.children = [];
        }
      }
    }
    out.push(token);
  }

  state.tokens = out;
}

const INSTALLED = Symbol.for("gumply.emptyLines");

/** Install the empty-line rule once per markdown-it instance. */
export function emptyLinesMarkdownPlugin(instance: unknown): void {
  const flagged = instance as MarkdownIt & { [INSTALLED]?: boolean };
  if (flagged[INSTALLED]) return;
  flagged[INSTALLED] = true;
  flagged.core.ruler.after("block", "gumply_empty_lines", emptyLinesRule);
}

/** Paragraph node with the empty-line-preserving Markdown round-trip. */
export const EmptyLineParagraph = Paragraph.extend({
  addStorage() {
    return {
      markdown: {
        serialize: serializeParagraph,
        parse: {
          setup: emptyLinesMarkdownPlugin,
        },
      },
    };
  },
});
