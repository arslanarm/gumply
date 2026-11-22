/**
 * `[[links]]` inside property values, shown as links (#vc4hivrr), as in
 * Obsidian: the properties block, database cells and cards. The value itself
 * stays plain text: editing shows it raw, and nothing is written back.
 *
 * A page link opens the page; an attachment link (`[[cover.png]]`) opens the
 * file, resolved from the note that holds it (#8k4ssrkb).
 */
import { hasAttachmentExtension, resolveWikilink, type PageMeta } from "@gumply/core";
import { Fragment, type MouseEvent } from "react";
import { fileUrl } from "../api/client.js";
import { resolvedFileLink, useFileLinkVersion } from "../lib/file-links.js";
import { parseWikiLinkText } from "../lib/wikilinks.js";

export type LinkedPart =
  | { kind: "text"; text: string }
  | { kind: "link"; target: string; heading: string; label: string };

/**
 * `text` cut at its `[[…]]` links. As in the editor, a link never holds a
 * bracket or a line break; anything else stays text.
 */
export function splitWikilinks(text: string): LinkedPart[] {
  const parts: LinkedPart[] = [];
  let plain = 0;
  let at = 0;
  for (;;) {
    const open = text.indexOf("[[", at);
    if (open === -1) break;
    const close = text.indexOf("]]", open + 2);
    if (close === -1) break;
    const inner = text.slice(open + 2, close);
    const link = /[\r\n]/.test(inner) ? null : parseWikiLinkText(text.slice(open, close + 2));
    if (!link) {
      at = open + 1;
      continue;
    }
    if (open > plain) parts.push({ kind: "text", text: text.slice(plain, open) });
    parts.push({ kind: "link", target: link.title, heading: link.heading, label: link.alias || link.title });
    plain = close + 2;
    at = plain;
  }
  if (plain < text.length) parts.push({ kind: "text", text: text.slice(plain) });
  return parts;
}

/** Whether `text` holds at least one `[[link]]`. */
export function hasWikilink(text: string): boolean {
  return text.includes("[[") && splitWikilinks(text).some((part) => part.kind === "link");
}

export interface LinkedTextProps {
  text: string;
  pages: readonly PageMeta[];
  /** The note holding the value: attachment links resolve from it. */
  from: string;
  fileLinks?: Readonly<Record<string, string | null>> | null;
  /** Open a page link. */
  onOpen: (link: { targetTitle: string; heading: string }) => void;
  /** Whether a link to a page that doesn't exist is clickable (it creates the page, as in the editor). */
  openMissing?: boolean;
}

// Clicks on a link must not reach the field or cell around it (which would
// start editing), and pressing it must not focus that field first.
const keepFocus = (event: MouseEvent) => event.preventDefault();
const stop = (event: MouseEvent) => event.stopPropagation();

/** `text` with its `[[links]]` as links. */
export function LinkedText({ text, pages, from, fileLinks, onOpen, openMissing = false }: LinkedTextProps) {
  useFileLinkVersion();
  return (
    <>
      {splitWikilinks(text).map((part, index) => {
        if (part.kind === "text") return <Fragment key={index}>{part.text}</Fragment>;
        const label = (
          <>
            <span className="wiki-link-label">{part.label}</span>
            {part.heading && part.label === part.target ? <span className="wiki-link-heading">#{part.heading}</span> : null}
          </>
        );
        if (hasAttachmentExtension(part.target)) {
          const path = resolvedFileLink(part.target, from, fileLinks);
          if (!path) {
            return (
              <span key={index} className="wiki-link property-link is-unresolved" data-testid="property-link">
                {label}
              </span>
            );
          }
          return (
            <a
              key={index}
              className="wiki-link property-link"
              data-testid="property-link"
              href={fileUrl(path)}
              target="_blank"
              rel="noopener noreferrer"
              onMouseDown={keepFocus}
              onClick={stop}
            >
              {label}
            </a>
          );
        }
        const found = resolveWikilink(part.target, pages) !== null;
        if (!found && !openMissing) {
          return (
            <span key={index} className="wiki-link property-link is-unresolved" data-testid="property-link">
              {label}
            </span>
          );
        }
        return (
          <a
            key={index}
            className={`wiki-link property-link${found ? "" : " is-unresolved"}`}
            data-testid="property-link"
            href="#"
            onMouseDown={keepFocus}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onOpen({ targetTitle: part.target, heading: part.heading });
            }}
          >
            {label}
          </a>
        );
      })}
    </>
  );
}
