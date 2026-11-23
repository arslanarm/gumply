/**
 * #2xx3uae4: a failed save ("Couldn't save — Retry") is tried again by itself
 * once Gumply's local server answers again, with growing gaps in case the
 * server answers but still refuses: 2, 4, 8, 16, then every 30 seconds. A save
 * conflict (409) is never retried this way: it needs the user's choice.
 */
export const SAVE_RETRY_DELAYS_MS: readonly number[] = [2_000, 4_000, 8_000, 16_000, 30_000];

/** The wait before automatic retry number `attempt` (0 = the first) may run again. */
export function nextRetryDelay(attempt: number): number {
  const index = Math.min(Math.max(0, Math.floor(attempt)), SAVE_RETRY_DELAYS_MS.length - 1);
  return SAVE_RETRY_DELAYS_MS[index]!;
}

/** Retry bookkeeping for one stretch of failed saves (reset when the save state leaves "error"). */
export interface RetrySchedule {
  attempt: number;
  /** Not before this time (ms since the epoch). */
  notBefore: number;
}

export const freshRetrySchedule = (): RetrySchedule => ({ attempt: 0, notBefore: 0 });

/**
 * Whether to retry now, and the schedule after it. The caller only asks while
 * the server answers (a poll succeeded) and the save state is "error".
 */
export function takeRetry(schedule: RetrySchedule, now: number): { retry: boolean; schedule: RetrySchedule } {
  if (now < schedule.notBefore) return { retry: false, schedule };
  return { retry: true, schedule: { attempt: schedule.attempt + 1, notBefore: now + nextRetryDelay(schedule.attempt) } };
}
