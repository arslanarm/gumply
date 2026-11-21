/**
 * The pure part of the e2e timing budgets (#eiyrbvgx): how much to scale a
 * quiet-machine budget, given how contended the CPU is. No Playwright
 * imports, so vitest can test it (`e2e/support/perf-scale.test.ts`).
 */

/** Load average per core above which budgets start to scale. */
export const LOAD_PER_CORE_OK = 0.75;
/** CPU pressure (Linux PSI `some avg10`, % of time a task waited for a CPU) that still counts as quiet. */
export const PRESSURE_OK = 10;
/** Each further this-many % of CPU pressure adds 1× to the budget. */
export const PRESSURE_PER_STEP = 30;
/** Contention up to this factor counts as quiet (jitter). */
export const QUIET_TOLERANCE = 1.1;
/** Budgets never grow beyond this. */
export const MAX_SCALE = 3;
/** At or above this scale the machine is too busy to judge timing at all. */
export const UNMEASURABLE = 2.5;

export interface Contention {
  /** 1-minute load average. */
  load1: number;
  cores: number;
  /** Linux PSI `/proc/pressure/cpu` "some avg10" in %, or null where unavailable (macOS, Windows, old kernels). */
  cpuPressure: number | null;
}

/**
 * 1 on a quiet machine. Otherwise the larger of: CPU pressure above 10 %
 * (+1× per 30 %) and load per core above 0.75 (proportionally). Capped.
 * PSI is the better signal: 24 cores at load 10 look idle by load average,
 * but tasks can still be waiting for a CPU, and that is what makes frames late.
 */
export function budgetScale(c: Contention, strict = false): number {
  if (strict) return 1;
  const fromLoad = c.load1 / Math.max(1, c.cores) / LOAD_PER_CORE_OK;
  const fromPressure = c.cpuPressure === null ? 1 : 1 + Math.max(0, c.cpuPressure - PRESSURE_OK) / PRESSURE_PER_STEP;
  const scale = Math.max(1, fromLoad, fromPressure);
  return scale <= QUIET_TOLERANCE ? 1 : Math.min(scale, MAX_SCALE);
}

/**
 * How long a page open (navigation + the app booting) may take on a quiet machine.
 * 10 s, not 5: a cold boot of the dev build once took over 5 s at load ×1
 * (`board-export`, #2h4kig7s). Navigation-only waits can afford it.
 */
export const PAGE_OPEN_BASE_MS = 10_000;
/** A boot slower than this is annotated `slow-page-open` (still passes within the budget). */
export const SLOW_PAGE_OPEN_MS = 5_000;
/** Page opens never get more than this, however busy the machine is. */
export const PAGE_OPEN_MAX_MS = 15_000;

/**
 * The budget for one page open (#rqtacq4d), given the current `budgetScale`:
 * the quiet 10 s scaled for contention, and the full 15 s once the machine is
 * too busy to judge. Only navigation waits use this; in-page interactions keep
 * the strict 5 s `expect` timeout, so real slowness inside the app still fails.
 */
export function pageOpenTimeout(scale: number): number {
  if (scale >= UNMEASURABLE) return PAGE_OPEN_MAX_MS;
  return Math.min(PAGE_OPEN_MAX_MS, Math.round(PAGE_OPEN_BASE_MS * Math.max(1, scale)));
}

/** Parse `/proc/pressure/cpu`; null if it isn't in the expected format. */
export function parseCpuPressure(text: string): number | null {
  const match = /^some\s.*\bavg10=([\d.]+)/m.exec(text);
  return match ? Number(match[1]) : null;
}
