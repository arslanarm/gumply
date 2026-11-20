import { defineConfig } from '@playwright/test';

/**
 * Desktop smoke tests (D26): Playwright's `_electron` drives the real app.
 * Run with `npm run desktop:test` (headless via xvfb-run on Linux).
 */
export default defineConfig({
  testDir: '.',
  testMatch: /\.spec\.ts$/,
  timeout: 60_000,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: '../../../test-results/desktop',
});
