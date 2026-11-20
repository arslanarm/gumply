import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { useEffect, useState } from "react";
import { urlForLink } from "../lib/attachment-links.js";
import { useWikiLinkEnvironment } from "../editor/wikilink/link-store.js";

/** Image block with a loading skeleton and an editable caption (= alt text). */
export function ImageBlockView({ node, updateAttributes, selected }: NodeViewProps) {
  const src = String(node.attrs.src ?? "");
  const alt = String(node.attrs.alt ?? "");
  // D23: `src` is the link as written; resolve it against the open page.
  const env = useWikiLinkEnvironment();
  const url = urlForLink(src, env, "image");
  const uploading = Boolean(node.attrs.uploading) || src.length === 0;
  const [caption, setCaption] = useState(alt);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setCaption(alt);
    setFailed(false);
  }, [alt, src]);

  if (uploading) {
    return (
      <NodeViewWrapper as="figure" className="image-block is-uploading" data-testid="image-uploading">
        <div className="image-skeleton" aria-live="polite">
          Uploading image…
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
        placeholder="Add a caption"
        aria-label="Image caption"
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
