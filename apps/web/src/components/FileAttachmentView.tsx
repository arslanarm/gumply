import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { resolveLink, urlForLink } from "../lib/attachment-links.js";
import { useWikiLinkEnvironment } from "../editor/wikilink/link-store.js";
import { fileExtension, formatFileSize } from "../lib/files.js";
import { Icon } from "./Icon.js";
import { useT } from "../i18n/index.js";

/** Inline file card: icon, name, size; opens the file in a new tab. */
export function FileAttachmentView({ node, selected }: NodeViewProps) {
  const t = useT();
  const path = String(node.attrs.path ?? "");
  const name = String(node.attrs.name ?? path.split("/").pop() ?? "file");
  const env = useWikiLinkEnvironment();
  // D23: `path` is the link as written; resolve it against the open page.
  const vaultPath = resolveLink(path, env);
  const known = env.attachments.find((item) => item.path === vaultPath || item.name === name);
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
          <span className="file-card-size">{t("files.uploading")}</span>
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
        // External cards open the URL itself; unsafe links get no href.
        href={urlForLink(path, env, "file") ?? undefined}
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
