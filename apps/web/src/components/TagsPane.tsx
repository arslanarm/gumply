import type { PageMeta } from "@gumply/core";
import { useMemo, useState } from "react";
import { useT } from "../i18n/index.js";
import { buildTagTree, type TagNode } from "../lib/tags.js";
import { Icon } from "./Icon.js";

/** `gumply:` so the desktop app keeps it across launches (#c7fzzxk8). */
const OPEN_KEY = "gumply:tags-pane";

function readOpen(): boolean {
  try {
    return window.localStorage.getItem(OPEN_KEY) === "open";
  } catch {
    return false;
  }
}

export interface TagsPaneProps {
  pages: readonly PageMeta[];
  /** Cmd+K with `#tag`: the pages with it. */
  onOpenTag: (tag: string) => void;
  onRenameTag: (tag: string) => void;
}

/**
 * The sidebar's Tags section (#9bx3aznb): every tag with how many pages and
 * boards have it, `#a/b` nested under `#a` (collapsed, as in Obsidian).
 * Click a tag to list its pages; ✎ or right-click to rename it everywhere.
 */
export function TagsPane({ pages, onOpenTag, onRenameTag }: TagsPaneProps) {
  const t = useT();
  const [open, setOpen] = useState(readOpen);
  // Built only while the section is open (about 17 ms for 5,000 pages).
  const tree = useMemo(() => (open ? buildTagTree(pages) : []), [open, pages]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  const toggleOpen = () => {
    const next = !open;
    setOpen(next);
    try {
      window.localStorage.setItem(OPEN_KEY, next ? "open" : "closed");
    } catch {
      // Storage disabled: open for this session only.
    }
  };
  const toggle = (tag: string) =>
    setExpanded((previous) => {
      const next = new Set(previous);
      const key = tag.toLowerCase();
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const row = (node: TagNode, depth: number) => {
    const isOpen = expanded.has(node.tag.toLowerCase());
    return (
      <li key={node.tag} role="treeitem" aria-expanded={node.children.length > 0 ? isOpen : undefined} aria-selected={false}>
        <div
          className="tag-row"
          style={{ paddingLeft: `${depth * 0.9 + 0.2}rem` }}
          data-testid={`tag-row-${node.tag}`}
          onContextMenu={(event) => {
            event.preventDefault();
            onRenameTag(node.tag);
          }}
        >
          {node.children.length > 0 ? (
            <button
              type="button"
              className="tag-chevron"
              aria-label={isOpen ? t("tags.collapse") : t("tags.expand")}
              data-testid={`tag-toggle-${node.tag}`}
              onClick={() => toggle(node.tag)}
            >
              <Icon name={isOpen ? "chevronDown" : "chevronRight"} size={13} />
            </button>
          ) : (
            <span className="tag-chevron" aria-hidden="true" />
          )}
          <button
            type="button"
            className="tag-name"
            aria-label={t("tags.showPages", { tag: node.tag })}
            data-testid={`tag-open-${node.tag}`}
            onClick={() => onOpenTag(node.tag)}
          >
            <span className="tag-hash" aria-hidden="true">
              #
            </span>
            <span className="tag-label">{node.label}</span>
          </button>
          <button
            type="button"
            className="icon-button tag-rename"
            data-tooltip={t("tags.rename")}
            aria-label={t("tags.rename")}
            data-testid={`tag-rename-${node.tag}`}
            onClick={() => onRenameTag(node.tag)}
          >
            <Icon name="pencil" size={13} />
          </button>
          <span className="tag-count" data-testid={`tag-count-${node.tag}`}>
            {node.count}
          </span>
        </div>
        {isOpen && node.children.length > 0 ? <ul role="group">{node.children.map((child) => row(child, depth + 1))}</ul> : null}
      </li>
    );
  };

  return (
    <section className={`tags-pane${open ? " tags-pane-open" : ""}`} data-testid="tags-pane">
      <button
        type="button"
        className="tags-pane-header"
        aria-expanded={open}
        aria-label={open ? t("tags.hide") : t("tags.show")}
        data-testid="tags-pane-toggle"
        onClick={toggleOpen}
      >
        <Icon name={open ? "chevronDown" : "chevronRight"} size={13} />
        <span className="sidebar-title">{t("tags.title")}</span>
        {tree.length > 0 ? <span className="tags-pane-total">{tree.length}</span> : null}
      </button>
      {open ? (
        tree.length === 0 ? (
          <p className="tags-pane-empty" data-testid="tags-pane-empty">
            {t("tags.empty")}
          </p>
        ) : (
          <ul className="tags-list" role="tree" aria-label={t("tags.listLabel")} data-testid="tags-list">
            {tree.map((node) => row(node, 0))}
          </ul>
        )
      ) : null}
    </section>
  );
}
