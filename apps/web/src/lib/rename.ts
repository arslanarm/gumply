/** D12: after a rename the server rewrites links in other pages. */
import type { PageId } from "@gumply/core";

/**
 * Decide whether a title draft should be sent to the server.
 *
 * `origin` is the title the draft started from. Comparing against it instead
 * of the live `page.title` prop makes a commit single-shot: an untouched
 * header draft cannot overwrite a rename that came from elsewhere (the
 * sidebar) when the header input blurs a moment later (#n8kk26sc).
 */
export function plannedTitleRename(draft: string, origin: string): string | null {
  const title = draft.trim();
  if (title.length === 0 || title === origin) return null;
  return title;
}

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
