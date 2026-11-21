/**
 * Sticky/shape/text content rendered as Markdown (#5hme2fwj): bold, italic,
 * strike, code, lists, links and `[[links]]`, like the page editor. Raw HTML
 * is never rendered (markdown-it `html: false`), and only safe web links
 * open. `[[links]]` open the page or board they point at.
 */
import MarkdownIt from "markdown-it";
import { memo, useLayoutEffect, useMemo, useRef, type MouseEvent } from "react";
import { highlightMarkdownPlugin } from "../../editor/highlight.js";
import { wikilinkMarkdownPlugin } from "../../editor/wikilink/markdown-plugin.js";
import { useBoardContent } from "./context.js";
import { resolveBoardLink, safeWebUrl } from "./links.js";

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true });
wikilinkMarkdownPlugin(markdown);
// `==highlight==` on stickies too, as in pages (#bg3cb83t).
highlightMarkdownPlugin(markdown);

/**
 * `![[Loop.canvas]]` on a board (#ux5cukze): a board can't show a live board
 * inside a node, so the embed reads as a link to it, labelled with the
 * board's name, with no stray `!` (and its `|height` isn't an alias).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
markdown.inline.ruler.before("image", "board_embed_link", (state: any, silent: boolean) => {
  const match = /^!\[\[([^[\]|#\r\n]+?\.canvas)(?:\|[^[\]\r\n]*)?\]\]/i.exec(state.src.slice(state.pos));
  if (!match) return false;
  if (!silent) {
    const target = (match[1] ?? "").trim();
    const name = (target.split("/").pop() ?? target).replace(/\.canvas$/i, "");
    const token = state.push("wikilink", "wiki-link", 0);
    token.meta = { title: target, alias: name, heading: "" };
    token.content = match[0];
  }
  state.pos += match[0].length;
  return true;
});

export function renderBoardMarkdown(text: string): string {
  return markdown.render(text);
}

export const BoardRichText = memo(function BoardRichText({ text }: { text: string }) {
  const { pages, openFile } = useBoardContent();
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => renderBoardMarkdown(text), [text]);

  // Mark `[[links]]` that point nowhere, like unresolved links in pages.
  useLayoutEffect(() => {
    for (const link of Array.from(ref.current?.querySelectorAll("wiki-link") ?? [])) {
      const target = link.getAttribute("data-wikilink-title") ?? "";
      const page = resolveBoardLink(target, pages);
      link.classList.toggle("is-unresolved", !page);
      link.setAttribute("role", "link");
      link.setAttribute("title", page ? `Open ${page.title}` : `“${target}” doesn't exist yet`);
    }
    for (const anchor of Array.from(ref.current?.querySelectorAll("a[href]") ?? [])) {
      if (!safeWebUrl(anchor.getAttribute("href") ?? "")) anchor.removeAttribute("href");
    }
  }, [html, pages]);

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as Element;
    const wiki = target.closest("wiki-link");
    if (wiki) {
      event.preventDefault();
      event.stopPropagation();
      const page = resolveBoardLink(wiki.getAttribute("data-wikilink-title") ?? "", pages);
      if (page) openFile(page.path);
      return;
    }
    const anchor = target.closest("a");
    if (anchor) {
      event.preventDefault();
      event.stopPropagation();
      const url = safeWebUrl(anchor.getAttribute("href") ?? "");
      if (url) window.open(url, "_blank", "noopener,noreferrer");
    }
  };

  return (
    <div
      ref={ref}
      className="board-rich"
      data-testid="board-rich-text"
      onClick={onClick}
      // Clicking a link must not start a drag or select the node first.
      onPointerDown={(event) => {
        if ((event.target as Element).closest("wiki-link, a")) event.stopPropagation();
      }}
      // markdown-it with html:false escapes everything; links are checked above.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});
