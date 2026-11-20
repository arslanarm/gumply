/**
 * Keep Markdown the editor doesn't model byte-for-byte (#82x82ek7).
 *
 * Opening a note from an existing (Obsidian) vault and fixing one typo used
 * to rewrite the whole file through the editor's schema: tables were
 * flattened to text, callouts merged into one line, footnotes and HTML
 * escaped. Now such constructs become opaque "raw" nodes holding their exact
 * source, which the serializer writes back unchanged:
 *
 * - blocks (top level): GFM tables, callouts (`> [!note] …`), footnote
 *   definitions (`[^1]: …`), math blocks (`$$ … $$`), and HTML blocks at
 *   any depth;
 * - inline: footnote references `[^1]`, `==highlight==`, inline math `$x$`,
 *   inline HTML (`<kbd>`, `<br>`, `<!-- -->`).
 *
 * HTML is recognised (markdown-it `html: true`) only so it can be captured:
 * every HTML token is rendered as an escaped `data-` attribute and never
 * reaches the DOM as markup.
 *
 * Hard breaks also remember their source style (two trailing spaces vs
 * backslash) so an unrelated edit doesn't rewrite them.
 */

/* markdown-it is an untyped optional peer dep here (see wikilink plugin). */
/* eslint-disable @typescript-eslint/no-explicit-any */

export const RAW_BLOCK_ATTR = "data-raw-md";
export const RAW_INLINE_ATTR = "data-raw-md-inline";
export const BREAK_STYLE_ATTR = "data-md-break";

export function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const CALLOUT = /^\[![\w-]+\][+-]?/;
const FOOTNOTE_DEF = /^\[\^[^\]\s]+\]:/;

function isBlank(line: string | undefined): boolean {
  return line === undefined || line.trim().length === 0;
}

/** Index of the token closing the block opened at `start` (same level). */
function closingIndex(tokens: any[], start: number): number {
  const open = tokens[start];
  if (open.nesting !== 1) return start;
  let depth = 0;
  for (let i = start; i < tokens.length; i += 1) {
    depth += tokens[i].nesting;
    if (depth === 0) return i;
  }
  return tokens.length - 1;
}

/** Which top-level block starting at `index` must be kept as raw source. */
function rawKind(tokens: any[], index: number, source: string): string | null {
  const token = tokens[index];
  if (token.type === "table_open") return "table";
  if (token.type === "blockquote_open") {
    const inline = tokens.slice(index, closingIndex(tokens, index)).find((t) => t.type === "inline");
    if (inline && CALLOUT.test(inline.content)) return "callout";
  }
  if (token.type === "paragraph_open") {
    if (FOOTNOTE_DEF.test(source)) return "footnote";
    const trimmed = source.trim();
    if (trimmed.startsWith("$$") && trimmed.endsWith("$$") && trimmed.length >= 4) return "math";
  }
  return null;
}

function rawBlocksRule(state: any): void {
  const lines: string[] = state.src.split("\n");
  const tokens: any[] = state.tokens;
  const out: any[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.level !== 0 || token.nesting !== 1 || !token.map) {
      out.push(token);
      continue;
    }
    const [startLine, endLine] = token.map as [number, number];
    let contentEnd = endLine;
    while (contentEnd > startLine && isBlank(lines[contentEnd - 1])) contentEnd -= 1;
    const source = lines.slice(startLine, contentEnd).join("\n");

    const kind = rawKind(tokens, i, source);
    if (!kind) {
      out.push(token);
      continue;
    }
    const raw = new state.Token("gumply_raw_block", "div", 0);
    raw.block = true;
    raw.level = 0;
    raw.map = [startLine, contentEnd];
    raw.content = source;
    raw.info = kind;
    out.push(raw);
    i = closingIndex(tokens, i);
  }
  state.tokens = out;
}

/** `[^id]`, `==text==` and Obsidian-style `$math$` as raw inline atoms. */
function rawInlineRule(state: any, silent: boolean): boolean {
  const src: string = state.src;
  const pos: number = state.pos;
  const rest = src.slice(pos);
  let match: RegExpExecArray | null = null;
  let kind = "";

  if (src[pos] === "[" && src[pos + 1] === "^") {
    match = /^\[\^[^\]\s]+\]/.exec(rest);
    kind = "footnote-ref";
  } else if (src[pos] === "=" && src[pos + 1] === "=") {
    match = /^==(?=\S)([^=\n]|=(?!=))*?\S==/.exec(rest) ?? /^==\S==/.exec(rest);
    kind = "highlight";
  } else if (src[pos] === "$" && src[pos + 1] !== "$" && src[pos - 1] !== "\\") {
    // Obsidian rule: no space inside the delimiters, no digit right after.
    match = /^\$(?=\S)[^$\n]*?\S\$(?!\d)/.exec(rest) ?? /^\$[^\s$]\$(?!\d)/.exec(rest);
    kind = "math";
  }
  if (!match) return false;

  if (!silent) {
    const token = state.push("gumply_raw_inline", "span", 0);
    token.content = match[0];
    token.info = kind;
  }
  state.pos += match[0].length;
  return true;
}

/**
 * Record each hard break's source style. Inline tokens carry their raw text,
 * so the n-th break token matches the n-th `  \n` / `\\\n` in it.
 */
function breakStyleRule(state: any): void {
  for (const block of state.tokens as any[]) {
    if (block.type !== "inline" || !block.children) continue;
    const breaks = (block.children as any[]).filter((t) => t.type === "hardbreak");
    if (breaks.length === 0) continue;
    const styles = [...(block.content as string).matchAll(/( {2,}|\\)\n/g)].map((m) =>
      m[1] === "\\" ? "backslash" : "spaces",
    );
    if (styles.length !== breaks.length) continue;
    breaks.forEach((token, index) => token.attrSet(BREAK_STYLE_ATTR, styles[index]));
  }
}

const INSTALLED = Symbol.for("gumply.rawMarkdown");

export function rawMarkdownPlugin(md: any): void {
  if (md[INSTALLED]) return;
  md[INSTALLED] = true;

  // Recognise HTML so it can be captured below; it is never rendered as HTML.
  md.set({ html: true });

  md.core.ruler.after("block", "gumply_raw_blocks", rawBlocksRule);
  md.core.ruler.after("inline", "gumply_break_style", breakStyleRule);
  md.inline.ruler.before("link", "gumply_raw_inline", rawInlineRule);

  const block = (source: string, kind: string) =>
    `<div ${RAW_BLOCK_ATTR}="${escapeAttr(source)}" data-raw-kind="${escapeAttr(kind)}"></div>`;
  const inline = (source: string, kind: string) =>
    `<span ${RAW_INLINE_ATTR}="${escapeAttr(source)}" data-raw-kind="${escapeAttr(kind)}"></span>`;

  md.renderer.rules.gumply_raw_block = (tokens: any[], index: number) =>
    block(tokens[index].content, tokens[index].info);
  md.renderer.rules.gumply_raw_inline = (tokens: any[], index: number) =>
    inline(tokens[index].content, tokens[index].info);
  md.renderer.rules.html_block = (tokens: any[], index: number) =>
    block(String(tokens[index].content).replace(/\n+$/, ""), "html");
  md.renderer.rules.html_inline = (tokens: any[], index: number) => {
    const content = String(tokens[index].content);
    // markdown-it-task-lists injects its checkbox as an html_inline token;
    // that one is ours, not vault HTML.
    if (/^<input class="task-list-item-checkbox"[^<>]*>$/.test(content)) return content;
    return inline(content, "html");
  };
  md.renderer.rules.hardbreak = (tokens: any[], index: number) => {
    const style = tokens[index].attrGet(BREAK_STYLE_ATTR);
    return style ? `<br ${BREAK_STYLE_ATTR}="${style}">` : "<br>";
  };
}
