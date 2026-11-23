import { describe, expect, it } from "vitest";
import { ApiRequestError } from "../src/api/client.js";
import { isNotFound } from "../src/lib/errors.js";
import { freshRetrySchedule, nextRetryDelay, takeRetry } from "../src/lib/save-retry.js";

/** #2xx3uae4: reconnecting after the local server was down. */
describe("save retry after the server is back", () => {
  it("waits 2, 4, 8, 16, then 30 seconds between tries", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(nextRetryDelay)).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
    expect(nextRetryDelay(-1)).toBe(2_000);
  });

  it("retries at once the first time, then not before the gap has passed", () => {
    let schedule = freshRetrySchedule();
    let step = takeRetry(schedule, 1_000);
    expect(step.retry).toBe(true);
    schedule = step.schedule;
    expect(schedule).toEqual({ attempt: 1, notBefore: 3_000 });
    expect(takeRetry(schedule, 2_999).retry).toBe(false);
    step = takeRetry(schedule, 3_000);
    expect(step.retry).toBe(true);
    expect(step.schedule).toEqual({ attempt: 2, notBefore: 7_000 });
  });
});

describe("a page that can't be loaded", () => {
  it("is 'not found' only for a real 404; a 5xx or a failed fetch means unreachable", () => {
    expect(isNotFound(new ApiRequestError(404, "Not found"))).toBe(true);
    expect(isNotFound(new ApiRequestError(500, "Internal Server Error"))).toBe(false);
    expect(isNotFound(new ApiRequestError(502, "Bad Gateway"))).toBe(false);
    expect(isNotFound(new TypeError("Failed to fetch"))).toBe(false);
    expect(isNotFound(undefined)).toBe(false);
  });
});
