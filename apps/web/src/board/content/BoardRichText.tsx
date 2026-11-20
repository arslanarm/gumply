/**
 * Sticky/shape/text content rendered as Markdown (#5hme2fwj): bold, italic,
 * strike, code, lists, links and `[[links]]`, like the page editor. Raw HTML
 * is never rendered (markdown-it `html: false`), and only safe web links
 * open. `[[links]]` open the page or board they point at.
 */
import MarkdownIt from "markdown-it";
import { memo, useLayoutEffect, useMemo, useRef, type MouseEvent } from "react";
import { wikilinkMarkdownPlugin } from "../../editor/wikilink/markdown-plugin.js";
import { useBoardContent } from "./context.js";
import { resolveBoardLink, safeWebUrl } from "./links.js";

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true });
wikilinkMarkdownPlugin(markdown);

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
