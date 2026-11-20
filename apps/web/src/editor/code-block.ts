/**
 * Code blocks (#smwaixfp, #82x82ek7).
 *
 * - ``` (or ~~~) starts a code block as soon as it is typed, like Notion.
 *   TipTap's rule waited for a space and took the word typed before it as
 *   the language, so "```const x = 1;" lost "const".
 * - The source fence is kept: ```` ````md ````, `~~~python` and 4-space
 *   indented blocks are written back as they were read.
 * - A fence is always longer than any run of its character inside the code
 *   (CommonMark), so a ```` ``` ```` inside the block can't close it early:
 *   the editor used to write a ````md block containing ``` with 3 backticks,
 *   which split the block on the next load.
 */
import CodeBlock from "@tiptap/extension-code-block";
import { InputRule } from "@tiptap/core";
import type { Node as PMNode, NodeType } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { CodeBlockView } from "../components/CodeBlockView.js";
import { codeHighlightPlugin } from "./code/highlight-plugin.js";
import { typedLanguage } from "./code/languages.js";

export const FENCE_ATTR = "data-md-fence";
/** The whole fence info string (`js title="x"`), so extra words survive. */
export const INFO_ATTR = "data-md-info";

interface CodeSerializerState {
  write(content?: string): void;
  text(text: string, escape?: boolean): void;
  ensureNewLine(): void;
  closeBlock(node: PMNode): void;
}

/** Longest run of `char` anywhere in `text`. */
function longestRun(text: string, char: string): number {
  let longest = 0;
  let current = 0;
  for (const c of text) {
    current = c === char ? current + 1 : 0;
    if (current > longest) longest = current;
  }
  return longest;
}

/** The opening/closing fence for this code: original style, long enough. */
export function fenceFor(content: string, original: string | null | undefined): string {
  const char = original?.startsWith("~") ? "~" : "`";
  const wanted = original && /^(`{3,}|~{3,})$/.test(original) ? original.length : 3;
  return char.repeat(Math.max(wanted, longestRun(content, char) + 1, 3));
}

/**
 * The fence info to write: the original info string while its language is
 * unchanged (keeps `js title="x"`), otherwise just the language.
 */
export function fenceInfo(language: string, originalInfo: string | null | undefined): string {
  const info = (originalInfo ?? "").trim();
  if (info && info.split(/\s+/)[0] === language) return info;
  return language;
}

/** Markdown for a code block, keeping its fence style where possible. */
export function serializeCodeBlock(state: CodeSerializerState, node: PMNode, parent?: PMNode): void {
  const content = node.textContent;
  const language = String(node.attrs.language ?? "");
  const fence = node.attrs.markdownFence as string | null;

  // Indented code: only without a language, with content, at the top level.
  const canIndent =
    fence === "indent" &&
    language.length === 0 &&
    content.trim().length > 0 &&
    (!parent || parent.type.name === "doc");
  if (canIndent) {
    state.text(
      content
        .split("\n")
        .map((line) => (line.length > 0 ? `    ${line}` : ""))
        .join("\n"),
      false,
    );
    state.closeBlock(node);
    return;
  }

  const marker = fenceFor(content, fence === "indent" ? null : fence);
  state.write(`${marker}${fenceInfo(language, node.attrs.markdownInfo as string | null)}\n`);
  state.text(content, false);
  state.ensureNewLine();
  state.write(marker);
  state.closeBlock(node);
}

const INSTALLED = Symbol.for("gumply.codeFence");

/** Tag rendered `<pre>` elements with the fence they came from. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fenceMarkdownPlugin(md: any): void {
  if (md[INSTALLED]) return;
  md[INSTALLED] = true;
  const escape = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const tag = (html: string, fence: string, info = "") =>
    html.replace(
      /^<pre/,
      `<pre ${FENCE_ATTR}="${fence}"${info ? ` ${INFO_ATTR}="${escape(info)}"` : ""}`,
    );
  const fenceRule = md.renderer.rules.fence;
  const codeRule = md.renderer.rules.code_block;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  md.renderer.rules.fence = (tokens: any[], index: number, ...rest: unknown[]) =>
    tag(
      fenceRule(tokens, index, ...rest),
      String(tokens[index].markup),
      String(tokens[index].info ?? "").trim(),
    );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  md.renderer.rules.code_block = (tokens: any[], index: number, ...rest: unknown[]) =>
    tag(codeRule(tokens, index, ...rest), "indent");
}

export const NotionCodeBlock = CodeBlock.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      markdownFence: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute(FENCE_ATTR),
        renderHTML: () => ({}),
      },
      markdownInfo: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute(INFO_ATTR),
        renderHTML: () => ({}),
      },
    };
  },

  addInputRules() {
    return [fenceInputRule(/^```$/, this.type), fenceInputRule(/^~~~$/, this.type)];
  },

  addKeyboardShortcuts() {
    return {
      ...this.parent?.(),
      // ```python + Enter: the word typed in a brand-new block is its language.
      Enter: ({ editor }) => {
        const { state } = editor;
        const { $from, empty } = state.selection;
        if (!empty || $from.parent.type !== this.type) return false;
        const fresh = freshFenceKey.getState(state);
        const blockPos = $from.before();
        if (fresh !== blockPos || $from.parent.attrs.language) return false;
        if ($from.parentOffset !== $from.parent.content.size) return false;
        const language = typedLanguage($from.parent.textContent);
        if (!language) return false;
        return editor
          .chain()
          .command(({ tr }) => {
            tr.delete(blockPos + 1, blockPos + 1 + $from.parent.content.size);
            tr.setNodeMarkup(blockPos, undefined, { ...$from.parent.attrs, language });
            tr.setMeta(freshFenceKey, null);
            return true;
          })
          .run();
      },
    };
  },

  addProseMirrorPlugins() {
    return [...(this.parent?.() ?? []), freshFencePlugin(this.name), codeHighlightPlugin(this.name)];
  },

  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockView);
  },

  addStorage() {
    return {
      markdown: {
        serialize: serializeCodeBlock,
        parse: {
          setup(this: { options?: { languageClassPrefix?: string } }, markdownit: unknown) {
            // Same as tiptap-markdown's own code block setup, plus the fence tag.
            (markdownit as { set(options: object): void }).set({
              langPrefix: this?.options?.languageClassPrefix ?? "language-",
            });
            fenceMarkdownPlugin(markdownit);
          },
          updateDOM(element: Element) {
            element.innerHTML = element.innerHTML.replace(/\n<\/code><\/pre>/g, "</code></pre>");
          },
        },
      },
    };
  },
});

/**
 * Position of a code block just created by typing a fence, while its first
 * line is still being typed. Only there does Enter turn the typed word into
 * the language; a "python" line in any other code block stays code.
 */
const freshFenceKey = new PluginKey<number | null>("gumplyFreshFence");

function freshFencePlugin(typeName: string): Plugin<number | null> {
  return new Plugin<number | null>({
    key: freshFenceKey,
    state: {
      init: () => null,
      apply(tr, value, _old, next) {
        const meta = tr.getMeta(freshFenceKey) as number | null | undefined;
        if (meta !== undefined) return meta;
        if (value === null) return null;
        const pos = tr.mapping.map(value);
        const node = next.doc.nodeAt(pos);
        if (!node || node.type.name !== typeName || node.textContent.includes("\n")) return null;
        // Leaving the block ends its "first line".
        const { $from } = next.selection;
        if ($from.depth === 0 || $from.before() !== pos) return null;
        return pos;
      },
    },
  });
}

/** ``` or ~~~ starts a code block at once (Notion), remembered as fresh. */
function fenceInputRule(find: RegExp, type: NodeType): InputRule {
  return new InputRule({
    find,
    handler: ({ state, range }) => {
      const $start = state.doc.resolve(range.from);
      if (!$start.node(-1).canReplaceWith($start.index(-1), $start.indexAfter(-1), type)) return null;
      const { tr } = state;
      tr.delete(range.from, range.to);
      tr.setBlockType(range.from, range.from, type);
      tr.setMeta(freshFenceKey, $start.before());
      return undefined;
    },
  });
}
