import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { api } from "../api/client.js";
import { hrefForAttachment, isExternalLink, urlForLink } from "../lib/attachment-links.js";
import { errorMessage } from "../lib/errors.js";
import { useWikiLinkEnvironment } from "../editor/wikilink/link-store.js";
import { useFileLinkVersion } from "../lib/file-links.js";
import { t, useT } from "../i18n/index.js";
import { altWithCaption, imageCaptionOf, imageWidthOf, nearestStep, widthPatch } from "../editor/attachments/image-width.js";
import { IMAGE_WIDTH_LIMIT_EVENT, imageColumnWidth, imageWidthPercent } from "../editor/attachments/image-measure.js";

/**
 * Image block with a loading skeleton, an editable caption (the alt text) and,
 * when selected, side handles that resize it (#e9bd64bb, D46): snapped to
 * 25/50/75/100% of the column (Alt: free), written as Obsidian's `|width`.
 */
export function ImageBlockView({ node, updateAttributes, selected }: NodeViewProps) {
  const t = useT();
  const src = String(node.attrs.src ?? "");
  const alt = String(node.attrs.alt ?? "");
  const width = imageWidthOf(node.attrs);
  const figureRef = useRef<HTMLElement | null>(null);
  const [liveWidth, setLiveWidth] = useState<number | null>(null);
  const [announce, setAnnounce] = useState("");
  const shownWidth = liveWidth ?? width;
  // D23: `src` is the link as written; resolve it against the open page.
  const env = useWikiLinkEnvironment();
  // An Obsidian link resolves across the vault (#8k4ssrkb); re-render once a new one is resolved.
  useFileLinkVersion();
  const url = urlForLink(src, env, "image", node.attrs.obsidian as string | null);
  const uploading = Boolean(node.attrs.uploading) || src.length === 0;
  const [caption, setCaption] = useState(imageCaptionOf(node.attrs));
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  // Web images (not vault files, not data: URLs) can be saved into the vault.
  const remote = isExternalLink(src) && url !== null && /^https?:/i.test(url);

  const saveToVault = async () => {
    if (saving || !url) return;
    setSaving(true);
    try {
      const attachment = await api.importAttachment(url);
      env.addAttachment?.(attachment);
      // Only this image changes; the caption (alt) stays. One step to undo.
      updateAttributes({ src: hrefForAttachment(attachment.path) });
    } catch (error) {
      env.reportError?.(t("image.saveFailed", { error: errorMessage(error) }));
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    setCaption(imageCaptionOf({ alt }));
    setFailed(false);
  }, [alt, src]);

  // A width set while the image is selected (a handle, or Shift+arrows) is announced, as the
  // share of the column it really takes (an image with no width may be narrower than 100%).
  const announcedWidth = useRef(width);
  useEffect(() => {
    if (announcedWidth.current === width) return;
    announcedWidth.current = width;
    if (selected) setAnnounce(t("image.widthAnnounce", { percent: imageWidthPercent(width, figureRef.current) }));
  }, [width, selected, t]);

  // Shift+←/→ at 25% or at the full column changes nothing: say where it is, every time.
  useEffect(() => {
    const figure = figureRef.current;
    if (!figure) return;
    const onLimit = (event: Event) => {
      const direction = (event as CustomEvent<{ direction: 1 | -1 }>).detail?.direction;
      const percent = imageWidthPercent(imageWidthOf(node.attrs), figure);
      const message = t(direction > 0 ? "image.widthAtLargest" : "image.widthAtSmallest", { percent });
      // Cleared first, so the same words are read again on a repeated key.
      setAnnounce("");
      window.requestAnimationFrame(() => setAnnounce(message));
    };
    figure.addEventListener(IMAGE_WIDTH_LIMIT_EVENT, onLimit);
    return () => figure.removeEventListener(IMAGE_WIDTH_LIMIT_EVENT, onLimit);
  }, [node.attrs, t]);

  const startResize = (side: "left" | "right") => (event: ReactPointerEvent<HTMLSpanElement>) => {
    const figure = figureRef.current;
    const image = figure?.querySelector("img");
    if (!figure || !image) return;
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = image.getBoundingClientRect().width;
    const column = imageColumnWidth(figure);
    let next: number | null = width;
    const move = (moveEvent: PointerEvent) => {
      const delta = (moveEvent.clientX - startX) * (side === "right" ? 1 : -1);
      const raw = Math.max(48, Math.min(column, startWidth + delta));
      const snapped = moveEvent.altKey ? raw : nearestStep(raw, column) * column;
      next = snapped >= column - 1 ? null : Math.round(snapped);
      setLiveWidth(next ?? column);
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      setLiveWidth(null);
      if (next !== width) updateAttributes(widthPatch(node.attrs, next));
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };

  if (uploading) {
    return (
      <NodeViewWrapper as="figure" className="image-block is-uploading" data-testid="image-uploading">
        <div className="image-skeleton" aria-live="polite">
          {t("image.uploading")}
        </div>
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper
      as="figure"
      ref={figureRef}
      className={`image-block${selected ? " is-selected" : ""}${failed ? " is-missing" : ""}`}
      data-testid="image-block"
      data-width={width ?? undefined}
    >
      {remote ? (
        <button
          type="button"
          className="image-save-to-vault"
          data-testid="image-save-to-vault"
          disabled={saving}
          aria-busy={saving}
          title={t("image.saveHint")}
          contentEditable={false}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void saveToVault()}
        >
          {saving ? t("image.saving") : t("image.save")}
        </button>
      ) : null}
      {failed || url === null ? (
        <div className="image-skeleton">{t("image.unavailable", { name: imageCaptionOf(node.attrs) || src.split("/").pop() || src })}</div>
      ) : (
        <div className="image-frame" style={shownWidth !== null ? { width: `${shownWidth}px` } : undefined} contentEditable={false}>
        <img
          src={url}
          alt={caption}
          // Remote images (pasted web content, imported notes) load directly;
          // many hosts refuse hot-linked images that carry a referrer.
          referrerPolicy="no-referrer"
          draggable={false}
          onError={() => setFailed(true)}
          data-testid="image-block-img"
        />
        {selected
          ? (["left", "right"] as const).map((side) => (
              <span
                key={side}
                className={`image-resize-handle is-${side}`}
                data-testid={`image-resize-${side}`}
                role="presentation"
                title={t("image.resizeHint")}
                onPointerDown={startResize(side)}
              />
            ))
          : null}
        </div>
      )}
      <span className="visually-hidden" aria-live="polite" data-testid="image-width-status">
        {announce}
      </span>
      <input
        className="image-caption"
        data-testid="image-caption"
        value={caption}
        placeholder={t("image.captionPlaceholder")}
        aria-label={t("image.captionLabel")}
        onChange={(event) => {
          setCaption(event.target.value);
          // The size (`Caption|300`) stays; only the caption text changes.
          updateAttributes({ alt: altWithCaption(node.attrs, event.target.value) });
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
      />
    </NodeViewWrapper>
  );
}
