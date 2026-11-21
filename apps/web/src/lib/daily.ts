/**
 * Daily notes in the app (v0.7 C, #5hrsrqsj). Browsing never creates files:
 * ‹ › go to the previous/next daily note that already exists, as Obsidian's
 * "Open previous/next daily note" commands do.
 */
import { dailyNoteDay, formatMomentDate, type DailyNoteSettings, type PageId, type PageMeta } from "@gumply/core";

/** Today in local time, `YYYY-MM-DD` (what `POST /daily` expects). */
export function todayDay(now: Date = new Date()): string {
  return formatMomentDate(now, "YYYY-MM-DD");
}

export interface DailyNeighbours {
  /** The open page's day, `YYYY-MM-DD`. */
  day: string;
  previous: PageId | null;
  next: PageId | null;
}

/** The daily notes around `id`, or null when `id` isn't a daily note. */
export function dailyNeighbours(
  pages: readonly PageMeta[],
  settings: DailyNoteSettings,
  id: PageId,
): DailyNeighbours | null {
  const day = dailyNoteDay(id, settings);
  if (!day) return null;
  let previous: { id: PageId; day: string } | null = null;
  let next: { id: PageId; day: string } | null = null;
  for (const page of pages) {
    if (page.kind === "folder" || page.kind === "whiteboard" || page.id === id) continue;
    const other = dailyNoteDay(page.id, settings);
    if (!other || other === day) continue;
    if (other < day && (!previous || other > previous.day)) previous = { id: page.id, day: other };
    if (other > day && (!next || other < next.day)) next = { id: page.id, day: other };
  }
  return { day, previous: previous?.id ?? null, next: next?.id ?? null };
}
