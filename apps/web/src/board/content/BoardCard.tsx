/**
 * Card content for page, board, image, file and web-link cards (#5hme2fwj).
 * - Page card: the page's icon, title and its first lines of text, live.
 * - Board card: icon, title, "Whiteboard".
 * - Image card: the image (vault file), with a quiet "missing" state.
 * - File card: icon, name and type.
 * - Link card: host and URL; only http(s)/mailto open. Anything else
 *   (`javascript:`, `data:`, …) is shown as inert text (lead's security note).
 */
import type { CanvasNode } from "@gumply/core";
import { memo, useEffect, useState } from "react";
import { fileUrl } from "../../api/client.js";
import { plainTextSnippet } from "../../lib/search.js";
import { useBoardActions, type BoardCardRenderProps } from "../context.js";
import { BoardIcon } from "../icons.js";
import { useBoardContent } from "./context.js";
import { safeWebUrl } from "./links.js";
import { t, useT } from "../../i18n/index.js";

function baseName(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.(md|canvas)$/i, "");
}

function extension(path: string): string {
  const match = /\.([a-z0-9]{1,8})$/i.exec(path);
  return match ? match[1]!.toUpperCase() : "";
}

function OpenButton({ node, label }: { node: CanvasNode; label: string }) {
  const actions = useBoardActions();
  return (
    <button
      type="button"
      className="board-card-open nodrag"
      aria-label={label}
      data-tooltip={label}
      data-testid="board-card-open"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        actions.openNode(node);
      }}
    >
      <BoardIcon name="open" size={14} />
    </button>
  );
}

// ---------- live page previews ----------

/** A line of a page card's preview: text, or a task with its box (#vc4hivrr). */
export interface PreviewLine {
  text: string;
  task?: { checked: boolean };
}

const previewCache = new Map<string, PreviewLine[] | null>();
const PREVIEW_LINES = 6;

const sameText = (a: string, b: string) =>
  a.trim().toLowerCase().replace(/\s+/g, " ") === b.trim().toLowerCase().replace(/\s+/g, " ");

const TASK = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\](?:\s+|$)/;
/** `> [!note] Title` (any depth of `>`, optional +/- fold marker). */
const CALLOUT = /^\s*(?:>\s*)+\[!([^\]\s]+)\][+-]?\s*(.*)$/;
/** Pandoc fenced divs: `::: {.column}`, `::::`, `:::`. */
const FENCED_DIV = /^\s*:{3,}/;

/**
 * The first lines of a page as plain text (no Markdown syntax). A leading H1
 * that just repeats the page title is skipped: the card already shows the
 * title (#5kcn4jfc). A task line (`- [ ]`, `- [x]`) keeps its state, so the
 * card shows a read-only box like page previews do (#vc4hivrr).
 */
export function previewLines(markdown: string, title?: string): PreviewLine[] {
  const lines: PreviewLine[] = [];
  let inFence = false;
  let first = true;
  for (const raw of markdown.split("\n")) {
    if (first && raw.trim()) {
      first = false;
      const heading = /^\s{0,3}#\s+(.*?)\s*#*\s*$/.exec(raw);
      if (heading && title && sameText(plainTextSnippet(heading[1] ?? ""), title)) continue;
    }
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // Structure isn't text (#jchhjepb): a column fence is skipped, a callout
    // shows its title (or its type, "Note") instead of `[!note] …`.
    if (FENCED_DIV.test(raw)) continue;
    const callout = CALLOUT.exec(raw);
    const task = callout ? null : TASK.exec(raw);
    if (callout) {
      const title = plainTextSnippet(callout[2] ?? "").trim();
      const type = callout[1]!;
      lines.push({ text: title || type.charAt(0).toUpperCase() + type.slice(1).toLowerCase() });
    } else if (task) {
      lines.push({ text: plainTextSnippet(raw.slice(task[0].length)).trim(), task: { checked: task[1] !== " " } });
    } else {
      const line = plainTextSnippet(raw).trim();
      if (!line || /^[-*_]{3,}$/.test(line) || /^\|?\s*:?-{2,}/.test(raw.trim())) continue;
      lines.push({ text: line });
    }
    if (lines.length >= PREVIEW_LINES) break;
  }
  return lines;
}


function usePagePreview(path: string, version: string | undefined, title: string | undefined): PreviewLine[] | null {
  const { loadPage } = useBoardContent();
  const key = `${path}\u0000${version ?? ""}\u0000${title ?? ""}`;
  const [text, setText] = useState<PreviewLine[] | null>(() => previewCache.get(key) ?? null);
  useEffect(() => {
    if (!loadPage) return;
    if (previewCache.has(key)) {
      setText(previewCache.get(key) ?? null);
      return;
    }
    let cancelled = false;
    void loadPage(path)
      .then((markdown) => {
        const value = markdown === null ? null : previewLines(markdown, title);
        previewCache.set(key, value);
        if (!cancelled) setText(value);
      })
      .catch(() => {
        if (!cancelled) setText(null);
      });
    return () => {
      cancelled = true;
    };
  }, [key, loadPage, path, title]);
  return text;
}

function PageCard({ node }: { node: CanvasNode }) {
  const { pages } = useBoardContent();
  const path = typeof node.file === "string" ? node.file : "";
  const page = pages.find((item) => item.path === path);
  const preview = usePagePreview(path, page?.updated, page?.title);
  if (!page) {
    return (
      <div className="board-card-body is-missing" data-testid="board-page-card" data-missing="true">
        <div className="board-card-title">
          <BoardIcon name="page" size={16} />
          <span>{baseName(path)}</span>
        </div>
        <div className="board-card-sub">{t("board.cards.pageMissing")}</div>
      </div>
    );
  }
  return (
    <div className="board-card-body" data-testid="board-page-card">
      <div className="board-card-title">
        {page.icon ? <span className="board-card-emoji" aria-hidden="true">{page.icon}</span> : <BoardIcon name="page" size={16} />}
        <span data-testid="board-page-card-title">{page.title}</span>
      </div>
      {preview && preview.length > 0 ? (
        <div className="board-card-preview" data-testid="board-page-card-preview">
          {preview.map((line, index) =>
            line.task ? (
              <div key={index} className={`board-card-task${line.task.checked ? " is-checked" : ""}`} data-testid="board-page-card-task">
                <input type="checkbox" disabled checked={line.task.checked} tabIndex={-1} aria-label={line.text} />
                <span>{line.text}</span>
              </div>
            ) : (
              <div key={index}>{line.text}</div>
            ),
          )}
        </div>
      ) : (
        <div className="board-card-sub">{preview === null ? "" : t("board.cards.emptyPage")}</div>
      )}
      <OpenButton node={node} label={t("board.cards.openPage")} />
    </div>
  );
}

function BoardRefCard({ node }: { node: CanvasNode }) {
  const { pages } = useBoardContent();
  const path = typeof node.file === "string" ? node.file : "";
  const board = pages.find((item) => item.path === path);
  return (
    <div className={`board-card-body${board ? "" : " is-missing"}`} data-testid="board-board-card">
      <div className="board-card-title">
        {board?.icon ? <span className="board-card-emoji" aria-hidden="true">{board.icon}</span> : <BoardIcon name="board" size={16} />}
        <span>{board?.title ?? baseName(path)}</span>
      </div>
      <div className="board-card-sub">{board ? t("board.cards.whiteboard") : t("board.cards.boardMissing")}</div>
      {board ? <OpenButton node={node} label={t("board.cards.openBoard")} /> : null}
    </div>
  );
}

function ImageCard({ node }: { node: CanvasNode }) {
  const path = typeof node.file === "string" ? node.file : "";
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div className="board-card-body is-missing" data-testid="board-image-missing">
        <div className="board-card-title">
          <BoardIcon name="image" size={16} />
          <span>{path.split("/").pop()}</span>
        </div>
        <div className="board-card-sub">{t("board.cards.imageMissing")}</div>
      </div>
    );
  }
  return (
    <img
      className="board-card-image"
      src={fileUrl(path)}
      alt={baseName(path)}
      draggable={false}
      referrerPolicy="no-referrer"
      data-testid="board-image"
      onError={() => setFailed(true)}
    />
  );
}

function FileCard({ node }: { node: CanvasNode }) {
  const path = typeof node.file === "string" ? node.file : "";
  return (
    <div className="board-card-body" data-testid="board-file-card">
      <div className="board-card-title">
        <BoardIcon name="page" size={16} />
        <span>{path.split("/").pop()}</span>
      </div>
      <div className="board-card-sub">{extension(path) ? t("board.cards.extFile", { ext: extension(path) }) : t("board.cards.file")}</div>
      <OpenButton node={node} label={t("board.cards.openFile")} />
    </div>
  );
}

function hostOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "mailto:" ? parsed.pathname : parsed.host || url;
  } catch {
    return url;
  }
}

function LinkCard({ node }: { node: CanvasNode }) {
  const url = typeof node.url === "string" ? node.url : "";
  const safe = safeWebUrl(url);
  return (
    <div className={`board-card-body${safe ? "" : " is-unsafe"}`} data-testid="board-link-card" data-safe={safe ? "true" : "false"}>
      <div className="board-card-title">
        <BoardIcon name="link" size={16} />
        <span>{safe ? hostOf(safe) : t("board.cards.blockedLink")}</span>
      </div>
      <div className="board-card-sub" title={url}>
        {url}
      </div>
      {safe ? <OpenButton node={node} label={t("board.cards.openLink")} /> : null}
    </div>
  );
}

export const BoardCard = memo(function BoardCard({ node, kind }: BoardCardRenderProps) {
  useT();
  switch (kind) {
    case "page":
      return <PageCard node={node} />;
    case "board":
      return <BoardRefCard node={node} />;
    case "image":
      return <ImageCard node={node} />;
    case "file":
      return <FileCard node={node} />;
    case "link":
      return <LinkCard node={node} />;
    default:
      return (
        <div className="board-card-body">
          <div className="board-card-sub">{t("board.cards.unsupported", { type: String(node.type) })}</div>
        </div>
      );
  }
});
