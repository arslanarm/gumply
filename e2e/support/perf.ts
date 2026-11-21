import { readFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { expect, type TestInfo } from '@playwright/test';
import { budgetScale, parseCpuPressure, UNMEASURABLE, type Contention } from './perf-scale';

/**
 * Load-aware timing budgets for e2e (#eiyrbvgx, wiki `dev/board-perf`).
 *
 * Frame-time and wall-time assertions are written for a quiet machine (CI:
 * 2 vCPU, one suite). On a shared dev machine running several suites at once
 * the same build misses them, and a red test that passes on rerun teaches
 * everyone to ignore red. Two things keep these specs meaningful without
 * flaking:
 *
 * 1. **Budgets scale with contention measured right before the measurement**
 *    (`perf-scale.ts`): Linux CPU pressure (PSI `some avg10`, the share of
 *    time a task waited for a CPU) and load per core. A quiet machine gets the
 *    strict numbers (×1). Past ×2.5 the machine is too busy to judge: timing
 *    is logged and annotated but not asserted; functional assertions still run.
 * 2. **Repeatable measurements get a second try** (`measure`, `attempts: 2`):
 *    a passing-load spike fails one run, a real regression fails both.
 *
 * Every decision lands in the test's annotations (`perf-budget`) and the log.
 * `GUMPLY_PERF_STRICT=1` forces ×1 and a single attempt (reproduce CI locally).
 * Absolute numbers for a release belong in the perf scripts
 * (`scripts/board-perf.mjs`, `scripts/export-perf.mjs --check`) on a quiet machine.
 */

const strict = () => process.env.GUMPLY_PERF_STRICT === '1';

export function contention(): Contention {
  let cpuPressure: number | null = null;
  try {
    cpuPressure = parseCpuPressure(readFileSync('/proc/pressure/cpu', 'utf8'));
  } catch {
    // No PSI (macOS, Windows, kernels without CONFIG_PSI): load average only.
  }
  return { load1: loadavg()[0] ?? 0, cores: Math.max(1, cpus().length), cpuPressure };
}

/** A check: [measured value, quiet-machine budget, description]. */
export type Check = readonly [value: number, base: number, what: string];

/**
 * Run `measure` and hold its numbers to budgets scaled for the current
 * contention. With `attempts: 2`, a run over budget is measured once more
 * (fresh contention reading) before failing. Returns the last result.
 */
export async function measure<T>(
  testInfo: TestInfo,
  label: string,
  run: () => Promise<T>,
  checks: (result: T) => Check[],
  { attempts = 1 }: { attempts?: number } = {},
): Promise<T> {
  const tries = strict() ? 1 : Math.max(1, attempts);
  for (let attempt = 1; ; attempt += 1) {
    const c = contention();
    const scale = budgetScale(c, strict());
    const unmeasurable = !strict() && scale >= UNMEASURABLE;
    const signal =
      `load ${c.load1.toFixed(1)} on ${c.cores} cores` + (c.cpuPressure === null ? '' : `, CPU pressure ${c.cpuPressure.toFixed(1)} %`);
    const verdict = strict()
      ? 'strict budgets (GUMPLY_PERF_STRICT=1)'
      : unmeasurable
        ? `×${scale.toFixed(2)}: too busy to judge, timing logged only`
        : `budgets ×${scale.toFixed(2)}`;
    const note = `${label}${tries > 1 ? ` (try ${attempt}/${tries})` : ''}: ${signal} → ${verdict}`;
    testInfo.annotations.push({ type: 'perf-budget', description: note });
    console.log(`[perf-budget] ${note}`);

    const result = await run();
    const results = checks(result).map(([value, base, what]) => ({ value, limit: base * scale, base, what }));
    for (const r of results) console.log(`[perf-budget]   ${r.what} = ${r.value.toFixed(1)} (limit ${r.limit.toFixed(1)})`);
    if (unmeasurable) return result;
    const over = results.filter((r) => !(r.value < r.limit));
    if (over.length === 0) return result;
    if (attempt < tries) {
      const retry = `${label}: over budget on try ${attempt} (${over.map((r) => r.what).join(', ')}); measuring again`;
      testInfo.annotations.push({ type: 'perf-budget', description: retry });
      console.log(`[perf-budget] ${retry}`);
      continue;
    }
    for (const r of results) {
      expect(r.value, `${r.what}: budget ${r.base} × ${scale.toFixed(2)} = ${r.limit.toFixed(1)} (${note})`).toBeLessThan(r.limit);
    }
    return result;
  }
}
