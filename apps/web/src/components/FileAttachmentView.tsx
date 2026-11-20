import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { fileUrl } from "../api/client.js";
import { useWikiLinkEnvironment } from "../editor/wikilink/link-store.js";
import { fileExtension, formatFileSize } from "../lib/files.js";
import { Icon } from "./Icon.js";

/** Inline file card: icon, name, size; opens the file in a new tab. */
export function FileAttachmentView({ node, selected }: NodeViewProps) {
  const path = String(node.attrs.path ?? "");
  const name = String(node.attrs.name ?? path.split("/").pop() ?? "file");
  const attachments = useWikiLinkEnvironment().attachments;
  const known = attachments.find((item) => item.path === path || item.name === name);
  const bytes = Number(node.attrs.size ?? 0) || known?.size || 0;
  const extension = fileExtension(name);
  const uploading = Boolean(node.attrs.uploading) || path.length === 0;

  if (uploading) {
    return (
      <NodeViewWrapper
        as="span"
        className="file-card is-uploading"
        data-testid="file-uploading"
        data-name={name}
      >
        <span className="file-card-link">
          <span className="file-card-icon" aria-hidden="true">
            <Icon name="file" size={16} />
          </span>
          <span className="file-card-name">{name}</span>
          <span className="file-card-size">Uploading…</span>
        </span>
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper
      as="span"
      className={`file-card${selected ? " is-selected" : ""}`}
      data-testid="file-attachment"
      data-name={name}
    >
      <a
        className="file-card-link"
        href={fileUrl(path)}
        target="_blank"
        rel="noopener noreferrer"
        title={name}
      >
        <span className="file-card-icon" aria-hidden="true">
          <Icon name="file" size={16} />
        </span>
        <span className="file-card-name">{name}</span>
        {bytes > 0 ? <span className="file-card-size">{formatFileSize(bytes)}</span> : null}
        <span className="file-card-ext" aria-hidden="true">
          {extension}
        </span>
      </a>
    </NodeViewWrapper>
  );
}
