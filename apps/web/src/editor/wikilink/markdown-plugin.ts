/**
 * markdown-it rule that turns `[[Title]]` / `[[Title|alias]]` /
 * `[[Title#heading]]` into a `<wiki-link>` element, which the TipTap node
 * parses. Registered through tiptap-markdown's `parse.setup` hook.
 *
 * markdown-it and its token types are optional peer deps of tiptap-markdown,
 * hence the local `any` aliases at the boundary.
 */

interface WikiLinkMeta {
  title: string;
  alias: string;
  heading: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function readInlineRule(state: any, silent: boolean): boolean {
  const src: string = state.src;
  const pos: number = state.pos;

  if (src[pos] !== "[" || src[pos + 1] !== "[") return false;

  const end = src.indexOf("]]", pos + 2);
  if (end === -1) return false;

  const inner = src.slice(pos + 2, end);
  if (inner.includes("[") || inner.includes("]")) return false;

  const pipe = inner.indexOf("|");
  const targetPart = pipe === -1 ? inner : inner.slice(0, pipe);
  const alias = pipe === -1 ? "" : inner.slice(pipe + 1).trim();
  const hash = targetPart.indexOf("#");
  const title = (hash === -1 ? targetPart : targetPart.slice(0, hash)).trim();
  const heading = hash === -1 ? "" : targetPart.slice(hash + 1).trim();

  if (title.length === 0) return false;

  if (!silent) {
    const token = state.push("wikilink", "wiki-link", 0);
    const meta: WikiLinkMeta = { title, alias, heading };
    token.meta = meta;
    token.content = src.slice(pos, end + 2);
  }

  state.pos = end + 2;
  return true;
}

export function wikilinkMarkdownPlugin(md: any): void {
  md.inline.ruler.before("link", "wikilink", readInlineRule);

  md.renderer.rules.wikilink = (tokens: any[], index: number): string => {
    const meta = tokens[index]?.meta as WikiLinkMeta | undefined;
    if (!meta) return "";
    const attrs = [
      `data-wikilink-title="${escapeHtml(meta.title)}"`,
      meta.alias.length > 0 ? `data-wikilink-alias="${escapeHtml(meta.alias)}"` : "",
      meta.heading.length > 0 ? `data-wikilink-heading="${escapeHtml(meta.heading)}"` : "",
    ]
      .filter((attr) => attr.length > 0)
      .join(" ");
    const label = meta.alias.length > 0 ? meta.alias : meta.title;
    return `<wiki-link ${attrs}>${escapeHtml(label)}</wiki-link>`;
  };
}
