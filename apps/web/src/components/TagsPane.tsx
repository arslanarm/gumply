import type { PageMeta, TagCount } from "@gumply/core";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client.js";
import { useT } from "../i18n/index.js";
import { buildTagTree, findTag, type TagNode, type TagSort } from "../lib/tags.js";
import { Icon } from "./Icon.js";

/** `gumply:` so the desktop app keeps them across launches (#c7fzzxk8). */
const OPEN_KEY = "gumply:tags-pane";
const SORT_KEY = "gumply:tags-sort";

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage disabled: this session only.
  }
}

export interface TagRenameRequest {
  tag: string;
  /** Pages and boards with it (nested tags included). */
  pages: number;
  /** Occurrences, nested tags included. */
  count: number;
  /** Whether another tag already has `name` (the two would merge). */
  exists: (name: string) => boolean;
}

export interface TagsPaneProps {
  /** The page list: a new one means tags may have changed. */
  pages: readonly PageMeta[];
  /** Cmd+K with `#tag`: the pages with it. */
  onOpenTag: (tag: string) => void;
  onRenameTag: (request: TagRenameRequest) => void;
}

/**
 * The sidebar's Tags section (#9bx3aznb), counted and sorted like Obsidian's
 * tags pane: occurrences with a parent including its children, most used
 * first (or by name), `#a/b` nested under `#a`. Click a tag to list its
 * pages; ✎ or right-click to rename it everywhere.
 */
export function TagsPane({ pages, onOpenTag, onRenameTag }: TagsPaneProps) {
  const t = useT();
  const [open, setOpen] = useState(() => read(OPEN_KEY) === "open");
  const [sort, setSort] = useState<TagSort>(() => (read(SORT_KEY) === "name" ? "name" : "count"));
  const [tags, setTags] = useState<TagCount[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  // Fetched only while open, again whenever the page list changes.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api.listTags().then(
      (next) => {
        if (cancelled) return;
        setTags(next);
        setFailed(false);
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, pages]);

  const tree = useMemo(() => (tags ? buildTagTree(tags, sort) : []), [tags, sort]);

  const toggleOpen = () => {
    setOpen(!open);
    write(OPEN_KEY, open ? "closed" : "open");
  };
  const toggleSort = () => {
    const next = sort === "name" ? "count" : "name";
    setSort(next);
    write(SORT_KEY, next);
  };
  const toggle = (tag: string) =>
    setExpanded((previous) => {
      const next = new Set(previous);
      const key = tag.toLowerCase();
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const rename = (node: TagNode) =>
    onRenameTag({
      tag: node.tag,
      pages: node.pages,
      count: node.count,
      exists: (name) => findTag(tree, name) !== null,
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
            rename(node);
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
            onClick={() => rename(node)}
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
      <div className="tags-pane-header">
        <button
          type="button"
          className="tags-pane-toggle"
          aria-expanded={open}
          aria-label={open ? t("tags.hide") : t("tags.show")}
          data-testid="tags-pane-toggle"
          onClick={toggleOpen}
        >
          <Icon name={open ? "chevronDown" : "chevronRight"} size={13} />
          <span className="sidebar-title">{t("tags.title")}</span>
        </button>
        {open && tree.length > 1 ? (
          <button
            type="button"
            className="icon-button tags-pane-sort"
            aria-pressed={sort === "name"}
            data-tooltip={sort === "name" ? t("tags.sortByCount") : t("tags.sortByName")}
            aria-label={sort === "name" ? t("tags.sortByCount") : t("tags.sortByName")}
            data-testid="tags-pane-sort"
            onClick={toggleSort}
          >
            <Icon name={sort === "name" ? "listOrdered" : "list"} size={14} />
          </button>
        ) : null}
      </div>
      {!open ? null : failed && tags === null ? (
        <p className="tags-pane-empty">{t("tags.loadFailed")}</p>
      ) : tags === null ? null : tree.length === 0 ? (
        <p className="tags-pane-empty" data-testid="tags-pane-empty">
          {t("tags.empty")}
        </p>
      ) : (
        <ul className="tags-list" role="tree" aria-label={t("tags.listLabel")} data-testid="tags-list">
          {tree.map((node) => row(node, 0))}
        </ul>
      )}
    </section>
  );
}
