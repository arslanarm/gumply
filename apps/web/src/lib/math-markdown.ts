/**
 * v0.8 F1: `$…$` and `$$…$$` in read-only renderers (page previews, board
 * stickies). They become `data-math` placeholders holding the TeX (escaped by
 * markdown-it like any text); `hydrateMath` renders them once KaTeX has
 * loaded. Detection is the editor's own (`matchInlineMath`,
 * `isMathBlockSource`), so prices like `$5 and $10` stay text everywhere.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- markdown-it has no bundled types here, as in the other plugins */
import { isMathBlockSource, matchInlineMath } from "../editor/raw-markdown/markdown-plugin.js";

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function mathMarkdownPlugin(md: any): void {
  md.inline.ruler.before("escape", "gumply_math_inline", (state: any, silent: boolean) => {
    if (state.src[state.pos] !== "$") return false;
    const math = matchInlineMath(state.src.slice(state.pos), state.src[state.pos - 1]);
    if (math === null) return false;
    if (!silent) {
      const token = state.push("gumply_math_inline", "span", 0);
      token.content = math.slice(1, -1);
    }
    state.pos += math.length;
    return true;
  });

  // A paragraph that is all `$$…$$` (possibly over several lines) is a block.
  md.core.ruler.after("block", "gumply_math_block", (state: any) => {
    const tokens = state.tokens;
    for (let index = 0; index + 2 < tokens.length; index += 1) {
      const open = tokens[index]!;
      const inline = tokens[index + 1]!;
      if (open.type !== "paragraph_open" || inline.type !== "inline") continue;
      const source = inline.content.trim();
      if (!isMathBlockSource(source)) continue;
      const block = new state.Token("gumply_math_block", "div", 0);
      block.content = source.slice(2, -2).trim();
      block.map = open.map;
      tokens.splice(index, 3, block);
    }
  });

  md.renderer.rules.gumply_math_inline = (tokens: any[], index: number) =>
    `<span class="math-inline" data-math="${escapeHtml(tokens[index]!.content)}">${escapeHtml(tokens[index]!.content)}</span>`;
  md.renderer.rules.gumply_math_block = (tokens: any[], index: number) =>
    `<div class="math-block" data-math="${escapeHtml(tokens[index]!.content)}" data-math-display="true">${escapeHtml(tokens[index]!.content)}</div>\n`;
}
