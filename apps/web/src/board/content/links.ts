/**
 * Links on boards (W2b, #5hme2fwj): resolving `[[links]]` in board text to
 * pages/boards, the link text Gumply writes, and which web links may open.
 */
import type { BoardPageOption } from "../BoardEditor.js";

const norm = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");

function stem(path: string): string {
  return path.replace(/\.(md|canvas)$/i, "");
}

function base(path: string): string {
  return path.split("/").pop() ?? path;
}

export function isBoardPath(path: string): boolean {
  return /\.canvas$/i.test(path);
}

/**
 * The page or board a `[[target]]` points at: title first (D4), then the
 * path without extension, the file name, and `Map.canvas` forms (spec/api
 * v1.7: board links are written with their extension).
 */
export function resolveBoardLink(target: string, pages: readonly BoardPageOption[]): BoardPageOption | null {
  const wanted = norm(target.split("#")[0] ?? target);
  if (!wanted) return null;
  const checks: Array<(page: BoardPageOption) => boolean> = [
    (page) => norm(page.title) === wanted && !isBoardPath(page.path),
    (page) => norm(page.title) === wanted,
    (page) => norm(stem(page.path)) === wanted,
    (page) => norm(page.path) === wanted,
    (page) => norm(stem(base(page.path))) === wanted,
    (page) => norm(base(page.path)) === wanted,
  ];
  for (const check of checks) {
    const found = pages.find(check);
    if (found) return found;
  }
  return null;
}

/**
 * The `[[…]]` Gumply writes for a page or board: plain `[[Title]]` when the
 * title is the file name, else `[[file name|Title]]` (#mp8eadhk). Boards
 * always carry `.canvas`, which Obsidian needs: `[[Map.canvas|Map]]`.
 */
export function wikiLinkFor(page: BoardPageOption, pages: readonly BoardPageOption[]): string {
  const name = base(page.path);
  if (isBoardPath(page.path)) {
    const shared = pages.some((other) => other !== page && norm(base(other.path)) === norm(name));
    return `[[${shared ? page.path : name}|${page.title}]]`;
  }
  const fileName = stem(name);
  const titleShared = pages.some((other) => other !== page && norm(other.title) === norm(page.title));
  if (fileName === page.title && !titleShared) return `[[${page.title}]]`;
  const baseShared = pages.some(
    (other) => other !== page && (norm(stem(base(other.path))) === norm(fileName) || norm(other.title) === norm(fileName)),
  );
  const target = baseShared ? stem(page.path) : fileName;
  return target === page.title ? `[[${target}]]` : `[[${target}|${page.title}]]`;
}

/** Web links that may be opened from a board: the engine's one check (http(s)/mailto). */
export { safeExternalUrl as safeWebUrl } from "../model.js";
