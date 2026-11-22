/**
 * Page preview node view (#5dpxwac4): a live, read-only rendering of another
 * page, one of its sections (`#Heading`) or one block (`#^id`), in a frame
 * that grows with its content up to a max height and then scrolls inside.
 *
 * - **Live:** the source is refetched whenever its `updated` moves (edits in
 *   Gumply or on disk); content is cached per page version.
 * - **Nested previews** render inside, up to {@link MAX_DEPTH} levels; a page
 *   already shown higher up the chain reads "Embedded here already" (no loops).
 * - **Not found:** the page, heading or block that's missing, calmly.
 * - Raw HTML in pages is never rendered (see `render.ts`); links only open
 *   through the same rules as the editor.
 */
import { embeddedMarkdown, parseEmbedPart, resolveAttachmentHref, resolveWikilink, type PageMeta } from "@gumply/core";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { api, fileUrl } from "../api/client.js";
import { safeWebUrl } from "../board/content/links.js";
import { obsidianFileUrl, useFileLinkVersion } from "../lib/file-links.js";
import { highlightToHtml } from "../editor/code/highlight-plugin.js";
import { CHEVRON_ICON, calloutIcon, svgIcon } from "../editor/callout/types.js";
import { renderEmbeddedMarkdown } from "../editor/page-embed/render.js";
import { hydrateMath } from "../lib/math.js";
import { hydrateDiagrams } from "../lib/diagram.js";
import { useWikiLinkEnvironment, type WikiLinkEnvironment } from "../editor/wikilink/link-store.js";
import { useT } from "../i18n/index.js";
import { isBoard } from "../lib/boards.js";
import { errorMessage } from "../lib/errors.js";
import { Icon } from "./Icon.js";

/** Previews inside previews go this deep, then show as links. */
export const MAX_DEPTH = 3;

interface Loaded {
  content: string;
  /** #8k4ssrkb: its Obsidian file links, resolved from the previewed page. */
  fileLinks?: Record<string, string | null>;
}

const contentCache = new Map<string, Promise<Loaded>>();

/** The page's Markdown body, fetched once per version (`id` + `updated`). */
function loadContent(page: PageMeta): Promise<Loaded> {
  const key = `${page.id}\u0000${page.updated}`;
  let pending = contentCache.get(key);
  if (!pending) {
    pending = api.getPage(page.id).then((loaded) => ({ content: loaded.content, ...(loaded.fileLinks ? { fileLinks: loaded.fileLinks } : {}) }));
    pending.catch(() => contentCache.delete(key));
    contentCache.set(key, pending);
    // Old versions of the same page aren't needed any more.
    for (const other of contentCache.keys()) {
      if (other !== key && other.startsWith(`${page.id}\u0000`)) contentCache.delete(other);
    }
  }
  return pending;
}

function usePageContent(
  page: PageMeta | null,
  enabled: boolean,
): { content: string | null; fileLinks?: Record<string, string | null>; error: string | null } {
  const [state, setState] = useState<{ key: string; content: string | null; fileLinks?: Record<string, string | null>; error: string | null }>({
    key: "",
    content: null,
    error: null,
  });
  const key = page ? `${page.id}\u0000${page.updated}` : "";
  useEffect(() => {
    if (!enabled || !page) return;
    let cancelled = false;
    loadContent(page)
      .then((loaded) => {
        if (!cancelled) setState({ key, content: loaded.content, ...(loaded.fileLinks ? { fileLinks: loaded.fileLinks } : {}), error: null });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState((previous) => ({ ...previous, key, error: errorMessage(error) }));
      });
    return () => {
      cancelled = true;
    };
    // `key` covers the page and its version.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key]);
  // A new version keeps showing the previous content until it loads (no flicker).
  return { content: state.content, fileLinks: state.fileLinks, error: state.key === key ? state.error : null };
}

/** `true` once the element comes within `margin` of the viewport (mounts lazily). */
function useNearViewport(ref: React.RefObject<HTMLElement | null>, margin = "800px"): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (near) return;
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setNear(true);
    }, { rootMargin: margin });
    observer.observe(element);
    return () => observer.disconnect();
  }, [near, ref, margin]);
  return near;
}

function partLabel(part: string): string {
  return part.startsWith("^") ? part : part ? `# ${part}` : "";
}

interface Nested {
  element: HTMLElement;
  target: string;
  part: string;
}

/** The rendered part of a page, with its own nested previews. */
function EmbeddedContent({ target, part, chain, depth, env }: {
  target: string;
  part: string;
  /** Ids of the pages shown above this one (the host page first). */
  chain: readonly string[];
  depth: number;
  env: WikiLinkEnvironment;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const near = useNearViewport(ref);
  const resolved = resolveWikilink(target, env.pages);
  const page = resolved && !isBoard(resolved) ? resolved : null;
  const loop = page ? chain.includes(page.id) : false;
  const { content, fileLinks, error } = usePageContent(page, near && !loop);
  const fileLinkVersion = useFileLinkVersion();
  const embedPart = useMemo(() => parseEmbedPart(part), [part]);
  const markdown = content === null ? null : embeddedMarkdown(content, embedPart);
  const html = useMemo(() => (markdown === null ? "" : renderEmbeddedMarkdown(markdown)), [markdown]);
  const [nested, setNested] = useState<Nested[]>([]);

  // After each render of the HTML: vault images, safe links, link state,
  // callout icons, and the places nested previews go.
  useLayoutEffect(() => {
    const root = ref.current?.querySelector<HTMLElement>(".page-embed-body");
    if (!root || !page) {
      setNested([]);
      return;
    }
    for (const image of Array.from(root.querySelectorAll("img"))) {
      // #8k4ssrkb: an Obsidian embed resolves from the previewed page, not the open one.
      const obsidianUrl = obsidianFileUrl(image.getAttribute("data-obsidian"), page.id, fileLinks);
      if (obsidianUrl !== null) {
        if (obsidianUrl) image.src = obsidianUrl;
        else image.removeAttribute("src");
        image.loading = "lazy";
        image.referrerPolicy = "no-referrer";
        continue;
      }
      const src = image.getAttribute("src") ?? "";
      const vaultPath = /^https?:/i.test(src) ? null : resolveAttachmentHref(page.id, src) ?? null;
      const byName = vaultPath ? null : env.attachments.find((file) => file.name === src.split("/").pop());
      if (vaultPath) image.src = fileUrl(vaultPath);
      else if (byName) image.src = fileUrl(byName.path);
      else if (!safeWebUrl(src)) image.removeAttribute("src");
      image.loading = "lazy";
      image.referrerPolicy = "no-referrer";
    }
    for (const anchor of Array.from(root.querySelectorAll("a[href]"))) {
      if (!safeWebUrl(anchor.getAttribute("href") ?? "")) anchor.removeAttribute("href");
    }
    for (const link of Array.from(root.querySelectorAll("wiki-link"))) {
      const title = link.getAttribute("data-wikilink-title") ?? "";
      link.classList.add("wiki-link");
      link.classList.toggle("is-unresolved", !resolveWikilink(title, env.pages));
      link.setAttribute("role", "link");
    }
    for (const icon of Array.from(root.querySelectorAll<HTMLElement>("[data-callout-icon]"))) {
      if (!icon.firstChild) icon.append(calloutIcon(icon.dataset.calloutIcon ?? "note", 18));
    }
    for (const fold of Array.from(root.querySelectorAll<HTMLElement>("[data-callout-fold]"))) {
      if (!fold.firstChild) fold.append(svgIcon(CHEVRON_ICON, 16));
    }
    // Code: the editor's highlighter, loaded on demand.
    for (const code of Array.from(root.querySelectorAll<HTMLElement>("pre > code[class*='language-']"))) {
      const language = /language-(\S+)/.exec(code.className)?.[1] ?? "";
      const text = code.textContent ?? "";
      void highlightToHtml(language, text).then(
        (highlighted) => {
          if (highlighted !== null && code.isConnected && code.textContent === text) code.innerHTML = highlighted;
        },
        () => undefined,
      );
    }
    setNested(
      Array.from(root.querySelectorAll<HTMLElement>(".page-embed-nested")).map((element) => ({
        element,
        target: element.dataset.target ?? "",
        part: element.dataset.part ?? "",
      })),
    );
    // F1: typeset `$…$` / `$$…$$` (KaTeX loads only when there is math).
    if (html.includes("data-math")) void hydrateMath(root);
    // F2: ```mermaid diagrams (Mermaid loads only when there is one).
    if (html.includes("data-mermaid")) void hydrateDiagrams(root);
  }, [html, page, env.pages, env.attachments, fileLinks, fileLinkVersion]);

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const element = event.target as HTMLElement;
    const fold = element.closest<HTMLElement>("[data-callout-fold], .callout.is-foldable .callout-title");
    if (fold) {
      // Folding is a reading aid here: it never writes the file.
      const callout = fold.closest<HTMLElement>(".callout");
      if (callout) {
        event.preventDefault();
        callout.classList.toggle("is-closed");
        callout.querySelector("[data-callout-fold]")?.setAttribute("aria-expanded", String(!callout.classList.contains("is-closed")));
        return;
      }
    }
    const wiki = element.closest("wiki-link, [data-wikilink-title]");
    if (wiki) {
      event.preventDefault();
      event.stopPropagation();
      env.openLink({
        targetTitle: wiki.getAttribute("data-wikilink-title") ?? "",
        heading: wiki.getAttribute("data-wikilink-heading") ?? "",
      });
      return;
    }
    const anchor = element.closest("a");
    if (anchor) {
      event.preventDefault();
      event.stopPropagation();
      const url = safeWebUrl(anchor.getAttribute("href") ?? "");
      if (url) window.open(url, "_blank", "noopener,noreferrer");
    }
  };

  let body: ReactNode;
  if (!page) {
    body = (
      <div className="page-embed-missing" data-testid="page-embed-missing" data-missing="page">
        <strong>{t("pageEmbed.pageMissing")}</strong>
        <span>{t("pageEmbed.pageMissingHint", { target })}</span>
        {depth === 1 ? (
          <button
            type="button"
            className="button-secondary"
            data-testid="page-embed-create"
            onClick={(event) => {
              event.stopPropagation();
              env.createLink(target.split("/").pop() ?? target);
            }}
          >
            {t("embed.create")}
          </button>
        ) : null}
      </div>
    );
  } else if (loop) {
    body = (
      <div className="page-embed-note" data-testid="page-embed-loop">
        {t("pageEmbed.alreadyHere", { title: page.title })}
      </div>
    );
  } else if (error && content === null) {
    body = <div className="page-embed-note">{t("pageEmbed.loadFailed", { error })}</div>;
  } else if (content !== null && markdown === null) {
    body = (
      <div className="page-embed-missing" data-testid="page-embed-missing" data-missing={embedPart.kind}>
        <strong>{embedPart.kind === "block" ? t("pageEmbed.blockMissing") : t("pageEmbed.headingMissing")}</strong>
        <span>{t("pageEmbed.partMissingHint", { part: partLabel(part), title: page.title })}</span>
      </div>
    );
  } else if (content !== null && markdown !== null && markdown.trim() === "") {
    body = <div className="page-embed-note">{t("pageEmbed.empty")}</div>;
  } else {
    body = (
      <div
        className="page-embed-body gumply-editor"
        data-testid="page-embed-body"
        // The renderer escapes the page's own HTML (`html: false`).
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  return (
    <div ref={ref} className="page-embed-content" data-depth={depth} onClick={onClick}>
      {body}
      {page && !loop
        ? nested.map((item, index) =>
            createPortal(
              depth >= MAX_DEPTH ? (
                <div className="page-embed-nested-link">
                  <span className="wiki-link" data-wikilink-title={item.target} data-wikilink-heading={item.part} role="link">
                    {item.target}
                    {item.part ? ` › ${partLabel(item.part)}` : ""}
                  </span>
                </div>
              ) : (
                <div className="page-embed is-nested" data-testid="page-embed-nested">
                  <EmbeddedContent target={item.target} part={item.part} chain={[...chain, page.id]} depth={depth + 1} env={env} />
                </div>
              ),
              item.element,
              `${index}:${item.target}#${item.part}`,
            ),
          )
        : null}
    </div>
  );
}

export function PageEmbedView({ node, selected }: NodeViewProps) {
  const t = useT();
  const env = useWikiLinkEnvironment();
  const target = String(node.attrs.target ?? "");
  const part = String(node.attrs.part ?? "");
  const resolved = resolveWikilink(target, env.pages);
  const page = resolved && !isBoard(resolved) ? resolved : null;
  const open = () => {
    if (page) env.openLink({ targetTitle: target, heading: part });
  };

  return (
    <NodeViewWrapper
      className={`page-embed${selected ? " is-selected" : ""}${page ? "" : " is-missing"}`}
      data-testid="page-embed"
      data-target={target}
      data-part={part}
      data-page-id={page?.id ?? ""}
      contentEditable={false}
    >
      <div className="page-embed-bar" data-testid="page-embed-bar">
        <span className="page-embed-title" data-testid="page-embed-title">
          {page?.icon ? (
            <span className="page-embed-emoji" aria-hidden="true">
              {page.icon}
            </span>
          ) : (
            <Icon name="file" size={14} />
          )}
          <span>{page?.title ?? target}</span>
          {part ? <span className="page-embed-part">{partLabel(part)}</span> : null}
        </span>
        {page ? (
          <button
            type="button"
            className="page-embed-open"
            data-testid="page-embed-open"
            aria-label={t("pageEmbed.open", { title: page.title })}
            onClick={(event) => {
              event.stopPropagation();
              open();
            }}
          >
            {t("common.open")}
          </button>
        ) : null}
      </div>
      <div className="page-embed-frame" data-testid="page-embed-frame">
        <EmbeddedContent target={target} part={part} chain={env.pageId ? [env.pageId] : []} depth={1} env={env} />
      </div>
    </NodeViewWrapper>
  );
}
