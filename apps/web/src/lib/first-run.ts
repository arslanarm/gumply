import type { PageId, PageMeta } from "@gumply/core";
import { buildPageTree } from "./tree.js";

/**
 * Choose the page to open on a cold start.
 *
 * The server's `X-Gumply-New-Vault` signal is one-shot. It can be missed if a
 * second tab, a poll or a page reload consumes it first — the old fallback then
 * opened the alphabetically-first root ("Gumply demo" instead of "Welcome").
 * Always prefer a root Welcome page when there is one, then the first root.
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

  return buildPageTree(pages)[0]?.page.id ?? null;
}
