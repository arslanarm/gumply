/**
 * Write rate limits (spec/mcp §4): 30 a minute and 1,000 a day, per vault and
 * process. A runaway loop gets slow and visible in the audit log.
 */
import { ToolError } from "./errors.js";

const MINUTE = 60_000;
const DAY = 86_400_000;

export class RateLimiter {
  private readonly stamps: number[] = [];

  constructor(
    private readonly perMinute = 30,
    private readonly perDay = 1000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Count one write, or throw `RATE_LIMITED` with `retryAfterMs`. */
  take(): void {
    const now = this.now();
    while (this.stamps.length > 0 && this.stamps[0]! <= now - DAY) this.stamps.shift();
    const lastMinute = this.stamps.filter((stamp) => stamp > now - MINUTE);
    if (lastMinute.length >= this.perMinute) {
      throw new ToolError("RATE_LIMITED", `At most ${this.perMinute} writes a minute.`, {
        retryAfterMs: lastMinute[lastMinute.length - this.perMinute]! + MINUTE - now,
      });
    }
    if (this.stamps.length >= this.perDay) {
      throw new ToolError("RATE_LIMITED", `At most ${this.perDay} writes a day.`, {
        retryAfterMs: this.stamps[this.stamps.length - this.perDay]! + DAY - now,
      });
    }
    this.stamps.push(now);
  }
}
