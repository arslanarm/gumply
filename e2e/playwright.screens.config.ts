import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import base from './playwright.config';
import { E2E_VAULT } from './support/env';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * Screenshot capture for review notes — **not** a pixel-diff gate.
 *
 * Runs only `screens.capture.ts` (excluded from the normal suite because its
 * name is not `*.spec.ts`) and writes PNGs under `test-results/screens/`.
 * Uses a throwaway vault: by default the fresh per-run directory from
 * `support/env.ts` (deleted in global teardown), so parallel runs by different
 * agents never share one. `GUMPLY_SCREENS_VAULT` overrides it.
 *
 *   npm run test:e2e:screens
 */
// #w284vn2u: the settings put-back (support/vault-settings.ts) acts on E2E_VAULT, so with GUMPLY_SCREENS_VAULT set
// to another folder it doesn't apply to this run (harmless: the capture isn't a gate).
const SCREENS_VAULT = process.env.GUMPLY_SCREENS_VAULT ?? E2E_VAULT;

const server = base.webServer as {
  command: string;
  env: Record<string, string>;
};

export default defineConfig({
  ...base,
  testMatch: /screens\.capture\.ts$/,
  testIgnore: [],
  reporter: [['list']],
  outputDir: path.join(repoRoot, 'test-results', 'screens-run'),
  webServer: {
    ...server,
    // Always capture from an empty vault so the screenshots are predictable.
    command: `rm -rf "${SCREENS_VAULT}" && ${server.command}`,
    env: { ...server.env, GUMPLY_VAULT: SCREENS_VAULT },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
