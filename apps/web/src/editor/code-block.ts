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
import { textblockTypeInputRule } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";

export const FENCE_ATTR = "data-md-fence";

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
  state.write(`${marker}${language}\n`);
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
  const tag = (html: string, fence: string) =>
    html.replace(/^<pre/, `<pre ${FENCE_ATTR}="${fence}"`);
  const fenceRule = md.renderer.rules.fence;
  const codeRule = md.renderer.rules.code_block;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  md.renderer.rules.fence = (tokens: any[], index: number, ...rest: unknown[]) =>
    tag(fenceRule(tokens, index, ...rest), String(tokens[index].markup));
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
    };
  },

  addInputRules() {
    return [
      textblockTypeInputRule({ find: /^```$/, type: this.type }),
      textblockTypeInputRule({ find: /^~~~$/, type: this.type }),
    ];
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
