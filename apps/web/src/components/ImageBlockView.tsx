import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { useEffect, useState } from "react";
import { api } from "../api/client.js";
import { hrefForAttachment, isExternalLink, urlForLink } from "../lib/attachment-links.js";
import { errorMessage } from "../lib/errors.js";
import { useWikiLinkEnvironment } from "../editor/wikilink/link-store.js";
import { t, useT } from "../i18n/index.js";

/** Image block with a loading skeleton and an editable caption (= alt text). */
export function ImageBlockView({ node, updateAttributes, selected }: NodeViewProps) {
  const t = useT();
  const src = String(node.attrs.src ?? "");
  const alt = String(node.attrs.alt ?? "");
  // D23: `src` is the link as written; resolve it against the open page.
  const env = useWikiLinkEnvironment();
  const url = urlForLink(src, env, "image");
  const uploading = Boolean(node.attrs.uploading) || src.length === 0;
  const [caption, setCaption] = useState(alt);
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
    setCaption(alt);
    setFailed(false);
  }, [alt, src]);

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
      className={`image-block${selected ? " is-selected" : ""}${failed ? " is-missing" : ""}`}
      data-testid="image-block"
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
        <div className="image-skeleton">Image unavailable · {node.attrs.alt || "attachment"}</div>
      ) : (
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
      )}
      <input
        className="image-caption"
        data-testid="image-caption"
        value={caption}
        placeholder={t("image.captionPlaceholder")}
        aria-label={t("image.captionLabel")}
        onChange={(event) => {
          setCaption(event.target.value);
          updateAttributes({ alt: event.target.value });
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
