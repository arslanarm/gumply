import { describe, expect, it } from 'vitest';
import {
  budgetScale,
  MAX_SCALE,
  PAGE_OPEN_BASE_MS,
  PAGE_OPEN_MAX_MS,
  pageOpenTimeout,
  parseCpuPressure,
  UNMEASURABLE,
} from './perf-scale';

const ci = { load1: 1, cores: 2, cpuPressure: 2 };

describe('e2e timing budgets (#eiyrbvgx)', () => {
  it('keeps the strict numbers on a quiet machine (CI: 2 vCPU, one suite)', () => {
    expect(budgetScale(ci)).toBe(1);
    expect(budgetScale({ load1: 1.6, cores: 2, cpuPressure: 12 })).toBe(1); // within the 10 % tolerance
    expect(budgetScale({ load1: 0.5, cores: 2, cpuPressure: null })).toBe(1);
  });

  it('scales with CPU pressure even when load per core looks fine', () => {
    // The flake: 24 cores at load ≈ 10 (0.42 per core), but tasks wait for a CPU.
    expect(budgetScale({ load1: 10, cores: 24, cpuPressure: 40 })).toBeCloseTo(2, 5);
  });

  it('falls back to load per core without PSI', () => {
    expect(budgetScale({ load1: 3, cores: 2, cpuPressure: null })).toBeCloseTo(2, 5);
  });

  it('is capped, and a very busy machine crosses the "too busy to judge" line', () => {
    expect(budgetScale({ load1: 40, cores: 2, cpuPressure: 95 })).toBe(MAX_SCALE);
    expect(budgetScale({ load1: 4, cores: 24, cpuPressure: 60 })).toBeGreaterThanOrEqual(UNMEASURABLE);
  });

  it('GUMPLY_PERF_STRICT forces 1', () => {
    expect(budgetScale({ load1: 40, cores: 2, cpuPressure: 95 }, true)).toBe(1);
  });

  it('page opens get 10 s when quiet, more under load, never over 15 s (#rqtacq4d, #2h4kig7s)', () => {
    expect(pageOpenTimeout(budgetScale(ci))).toBe(PAGE_OPEN_BASE_MS);
    expect(pageOpenTimeout(budgetScale({ load1: 10, cores: 24, cpuPressure: 16 }))).toBe(12_000); // ×1.2
    expect(pageOpenTimeout(budgetScale({ load1: 10, cores: 24, cpuPressure: 25 }))).toBe(PAGE_OPEN_MAX_MS); // ×1.5, capped
    expect(pageOpenTimeout(budgetScale({ load1: 4, cores: 24, cpuPressure: 60 }))).toBe(PAGE_OPEN_MAX_MS);
    expect(pageOpenTimeout(budgetScale({ load1: 40, cores: 2, cpuPressure: 95 }))).toBe(PAGE_OPEN_MAX_MS);
    expect(pageOpenTimeout(budgetScale({ load1: 40, cores: 2, cpuPressure: 95 }, true))).toBe(PAGE_OPEN_BASE_MS);
  });

  it('parses /proc/pressure/cpu', () => {
    const text = 'some avg10=7.03 avg60=6.50 avg300=4.80 total=516964825\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n';
    expect(parseCpuPressure(text)).toBe(7.03);
    expect(parseCpuPressure('garbage')).toBeNull();
  });
});
