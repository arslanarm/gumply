import { defineConfig } from '@playwright/test';

/**
 * Desktop smoke tests (D26): Playwright's `_electron` drives the real app.
 * Run with `npm run desktop:test` (headless via xvfb-run on Linux).
 */
export default defineConfig({
  testDir: '.',
  testMatch: /\.spec\.ts$/,
  // A cold first launch may take up to 45 s on a loaded machine (#tcw8r7vc), plus the test itself.
  timeout: 90_000,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: '../../../test-results/desktop',
});
