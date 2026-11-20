/**
 * Recently used emoji, shared by the page-icon picker and the editor. Most
 * recent first, de-duplicated, stored in localStorage (per browser, like
 * Notion's "Recent" row).
 */

export const RECENT_EMOJI_KEY = "gumply:recent-emoji";
export const RECENT_EMOJI_LIMIT = 27;

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function getRecentEmoji(): string[] {
  try {
    const raw = storage()?.getItem(RECENT_EMOJI_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string" && item.length > 0)
      : [];
  } catch {
    return [];
  }
}

/** Move `emoji` to the front of the recent list and return the new list. */
export function pushRecentEmoji(emoji: string): string[] {
  const next = [emoji, ...getRecentEmoji().filter((item) => item !== emoji)].slice(
    0,
    RECENT_EMOJI_LIMIT,
  );
  try {
    storage()?.setItem(RECENT_EMOJI_KEY, JSON.stringify(next));
  } catch {
    // Private mode / quota: the list just isn't remembered.
  }
  return next;
}
