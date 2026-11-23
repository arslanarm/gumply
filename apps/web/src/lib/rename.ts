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

/**
 * #iihi4dg7: how to reload the open page without ever dropping its unsaved text.
 * - `auto`: the server changed it and the user didn't ask to see it (a rename's
 *   or a tag rename's link rewrite). A page with unsaved text is left alone: its
 *   next save meets the usual "changed on disk" bar.
 * - `replace`: the user asked for the file's version (History restore, AI apps
 *   Undo, resolving a sync copy). As the conflict bar's Reload (#chbpc9yb): the
 *   unsaved text is kept in History ("Before reload") first, or the user is asked.
 * - `refresh`: nothing changed on the server (the open page clicked again, a
 *   link to itself): save the typing first, then reload; if it can't be saved,
 *   leave the page.
 */
export type ReloadKind = "auto" | "replace" | "refresh";

export function reloadDecision(kind: ReloadKind, dirty: boolean): "reload" | "leave" | "keep-then-reload" | "flush-then-reload" {
  if (!dirty) return "reload";
  if (kind === "auto") return "leave";
  if (kind === "replace") return "keep-then-reload";
  return "flush-then-reload";
}
