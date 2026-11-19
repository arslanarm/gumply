/** D12: after a rename the server rewrites links in other pages. */
import type { PageId } from "@gumply/core";

/**
 * Whether the open page must be refetched (and the editor remounted) after a
 * rename. `rewritten` comes from `PUT /pages/:id`; when the server doesn't
 * report it we reload any other open page to stay safe.
 */
export function openPageNeedsReload(
  rewritten: readonly PageId[] | undefined,
  openId: PageId | null,
  renamedId: PageId,
): boolean {
  if (openId === null || openId === renamedId) return false;
  if (rewritten === undefined) return true;
  return rewritten.includes(openId);
}
