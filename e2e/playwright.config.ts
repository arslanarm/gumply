import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import { API_PORT, BASE_URL, E2E_VAULT, WEB_PORT } from './support/env';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * Gumply e2e config (owned by @opus-hunter — see wiki pages `spec/e2e-tests` and `decisions` D7).
 *
 * The suite runs its own app instance on **dedicated ports** (web 5273, API 8973
 * by default — override with GUMPLY_WEB_PORT / GUMPLY_PORT) so it never collides
 * with someone's `npm run dev` on 5173/8787. It always uses a throwaway vault and
 * refuses to reuse an existing server: attaching to a dev server would mean
 * testing the wrong code and deleting pages from a real vault.
 */
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  // Deletes the per-run vault created by support/env.ts (unless GUMPLY_VAULT was given).
  globalTeardown: './support/teardown.ts',
  // All specs share one app instance + one vault, so run them serially.
  // Parallel workers would let one test's fixtures leak into another (e.g. the
  // empty-vault smoke failing because a seeding test created a page mid-load).
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
  // Keep run artifacts in a subdirectory: `test-results/screens/` holds review
  // screenshots and must survive a normal suite run (Playwright clears outputDir).
  outputDir: '../test-results/run',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // Q1b cross-browser graph check: Firefox runs only the canvas-pixel specs,
    // not the whole suite (keeps runtime and unrelated browser quirks out).
    // `graph-visual` (dev-graph: fit geometry, resize, filter, DPR) supersedes
    // the earlier `graph-pixels` smoke check, which is kept as a cheap guard.
    {
      name: 'firefox',
      testMatch: /graph-(visual|pixels|interaction)\.spec\.ts$/,
      use: { ...devices['Desktop Firefox'] },
    },
  ],
  // One app instance for the whole suite. Tests isolate themselves through
  // the API (resetVault fixture) instead of restarting the server.
  // reuseExistingServer is deliberately false: attaching to an already running
  // dev server would let the suite delete pages from a real vault.
  webServer: {
    command: `npm run build -w @gumply/core && npx concurrently -k -n server,web "npm run dev:server" "npx vite apps/web --port ${WEB_PORT} --strictPort"`,
    cwd: repoRoot,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
    env: {
      GUMPLY_PORT: String(API_PORT),
      GUMPLY_VAULT: E2E_VAULT,
      // The suite starts from an empty vault unless a test opts into first-run
      // seeding; server-side demo seeding is covered by its own unit tests.
      GUMPLY_SEED_DEMO: '0',
    },
  },
});
