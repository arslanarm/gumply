/**
 * The tags pane (#9bx3aznb): every tag in the vault as a tree (`#a/b` nests
 * under `#a`), from the pages' `tags` (frontmatter and inline, as the server
 * indexes them). Pure, unit-tested.
 */
import type { PageMeta } from "@gumply/core";

export interface TagNode {
  /** Full tag without `#`, in the first spelling met (`Work/Ideas`). */
  tag: string;
  /** The last level (`Ideas`). */
  label: string;
  /** Pages and boards with this tag or one nested under it, each once. */
  count: number;
  children: TagNode[];
}

interface Building {
  tag: string;
  label: string;
  pages: Set<string>;
  children: Map<string, Building>;
}

const byLabel = (a: TagNode, b: TagNode) =>
  a.label.localeCompare(b.label, undefined, { sensitivity: "base", numeric: true }) || a.label.localeCompare(b.label);

function finish(node: Building): TagNode {
  return {
    tag: node.tag,
    label: node.label,
    count: node.pages.size,
    children: [...node.children.values()].map(finish).sort(byLabel),
  };
}

/** The tag tree, sorted by name at every level (case-insensitive, like Obsidian). */
export function buildTagTree(pages: readonly PageMeta[]): TagNode[] {
  const roots = new Map<string, Building>();
  for (const page of pages) {
    if (page.kind === "folder") continue;
    for (const tag of page.tags) {
      const levels = tag.split("/").filter((level) => level.length > 0);
      let siblings = roots;
      for (let depth = 0; depth < levels.length; depth += 1) {
        const label = levels[depth] ?? "";
        const key = label.toLowerCase();
        let node = siblings.get(key);
        if (!node) {
          node = { tag: levels.slice(0, depth + 1).join("/"), label, pages: new Set(), children: new Map() };
          siblings.set(key, node);
        }
        node.pages.add(page.id);
        siblings = node.children;
      }
    }
  }
  return [...roots.values()].map(finish).sort(byLabel);
}

/** How many tags there are, nested ones included. */
export function countTags(nodes: readonly TagNode[]): number {
  return nodes.reduce((total, node) => total + 1 + countTags(node.children), 0);
}

/** The node for `tag` (case-insensitive), if any page has it. */
export function findTag(nodes: readonly TagNode[], tag: string): TagNode | null {
  const levels = tag.toLowerCase().split("/");
  let current: readonly TagNode[] = nodes;
  let found: TagNode | null = null;
  for (const level of levels) {
    found = current.find((node) => node.label.toLowerCase() === level) ?? null;
    if (!found) return null;
    current = found.children;
  }
  return found;
}
