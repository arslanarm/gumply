/**
 * The tags pane (#9bx3aznb): every tag in the vault as a tree (`#a/b` nests
 * under `#a`), counted like Obsidian's tags pane (measured in Obsidian
 * 1.14.4): occurrences, a parent including its children, case-insensitive,
 * the first spelling shown. Pure, unit-tested.
 */
import type { PageId, TagCount } from "@gumply/core";

export type TagSort = "count" | "name";

export interface TagNode {
  /** Full tag without `#`, in the first spelling met (`Work/Ideas`). */
  tag: string;
  /** The last level (`Ideas`). */
  label: string;
  /** Occurrences of this tag and every tag nested under it. */
  count: number;
  /** Pages and boards with this tag or one nested under it, each once. */
  pages: number;
  children: TagNode[];
}

interface Building {
  tag: string;
  label: string;
  count: number;
  pages: Set<PageId>;
  children: Map<string, Building>;
}

const byName = (a: TagNode, b: TagNode) =>
  a.label.localeCompare(b.label, undefined, { sensitivity: "base", numeric: true }) || a.label.localeCompare(b.label);

/** Obsidian's default: most used first, then by name. */
const byCount = (a: TagNode, b: TagNode) => b.count - a.count || byName(a, b);

function finish(node: Building, sort: TagSort): TagNode {
  return {
    tag: node.tag,
    label: node.label,
    count: node.count,
    pages: node.pages.size,
    children: [...node.children.values()].map((child) => finish(child, sort)).sort(sort === "name" ? byName : byCount),
  };
}

/** The tag tree from `GET /api/tags`, sorted at every level. */
export function buildTagTree(tags: readonly TagCount[], sort: TagSort = "count"): TagNode[] {
  const roots = new Map<string, Building>();
  for (const entry of tags) {
    const levels = entry.tag.split("/").filter((level) => level.length > 0);
    let siblings = roots;
    for (let depth = 0; depth < levels.length; depth += 1) {
      const label = levels[depth] ?? "";
      const key = label.toLowerCase();
      let node = siblings.get(key);
      if (!node) {
        node = { tag: levels.slice(0, depth + 1).join("/"), label, count: 0, pages: new Set(), children: new Map() };
        siblings.set(key, node);
      }
      node.count += entry.count;
      for (const page of entry.pages) node.pages.add(page);
      siblings = node.children;
    }
  }
  return [...roots.values()].map((node) => finish(node, sort)).sort(sort === "name" ? byName : byCount);
}

/** The node for `tag` (case-insensitive), if any page has it. */
export function findTag(nodes: readonly TagNode[], tag: string): TagNode | null {
  let current: readonly TagNode[] = nodes;
  let found: TagNode | null = null;
  for (const level of tag.toLowerCase().split("/")) {
    found = current.find((node) => node.label.toLowerCase() === level) ?? null;
    if (!found) return null;
    current = found.children;
  }
  return found;
}
