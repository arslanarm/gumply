import type { PageId, PageMeta } from "@gumply/core";
import { buildPageTree, type PageTreeNode } from "./tree.js";

/**
 * Choose the page to open on a cold start.
 *
 * The server's `X-Gumply-New-Vault` signal is one-shot. It can be missed if a
 * second tab, a poll or a page reload consumes it first — the old fallback then
 * opened the alphabetically-first root ("Gumply demo" instead of "Welcome").
 * Always prefer a root Welcome page when there is one, then the first page
 * or board in tree order.
 */
export function chooseLandingPage(
  pages: readonly PageMeta[],
  signalled: PageId | null,
): PageId | null {
  if (signalled && pages.some((page) => page.id === signalled)) return signalled;

  const welcome = pages.find(
    (page) => page.parentId === null && page.title.trim().toLowerCase() === "welcome",
  );
  if (welcome) return welcome.id;

  return firstDocument(buildPageTree(pages));
}

/**
 * The first page or board in tree order (folders first, depth-first). Never a
 * D33 folder: opening a vault on a folder overview read "This folder is
 * empty" when its first item was a folder of files (#z9b6zg47).
 */
function firstDocument(nodes: readonly PageTreeNode[]): PageId | null {
  for (const node of nodes) {
    if (node.page.kind !== "folder") return node.page.id;
    const inside = firstDocument(node.children);
    if (inside) return inside;
  }
  return null;
}
