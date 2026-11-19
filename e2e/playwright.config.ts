import { defineConfig, devices } from '@playwright/test';
import { API_PORT, BASE_URL, E2E_VAULT } from './support/env';

/**
 * Gumply e2e config (owned by @qa — see wiki pages `spec/e2e-tests` and `decisions` D7).
 *
 * Ports per D7: web on 5173 (Vite strictPort), server on GUMPLY_PORT (8787).
 * The suite boots its own app instance against a throwaway vault, so stop any
 * running `npm run dev` first — 5173 is strictPort and the run will fail loudly
 * rather than attaching to your dev server (which would wipe your vault).
 */
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  // All specs share one app instance + one vault, so run them serially.
  // Parallel workers would let one test's fixtures leak into another (e.g. the
  // empty-vault smoke failing because a seeding test created a page mid-load).
  // Per-test isolation needs a vault+server per worker — revisit if the suite
  // gets slow enough to matter.
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: '../playwright-report' }],
  ],
  outputDir: '../test-results',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // One app instance for the whole suite. Tests isolate themselves through
  // the API (resetVault fixture) instead of restarting the server.
  // reuseExistingServer is deliberately false: attaching to an already running
  // dev server would let the suite delete pages from a real vault.
  webServer: {
    command: 'npm run dev',
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      GUMPLY_PORT: String(API_PORT),
      GUMPLY_VAULT: E2E_VAULT,
    },
  },
});
