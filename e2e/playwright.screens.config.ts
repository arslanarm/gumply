import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import base from './playwright.config';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * Screenshot capture for review notes — **not** a pixel-diff gate.
 *
 * Runs only `screens.capture.ts` (excluded from the normal suite because its
 * name is not `*.spec.ts`) and writes PNGs under `test-results/screens/`.
 * Uses its own throwaway vault so it never touches the normal e2e vault.
 *
 *   npm run test:e2e:screens
 */
const SCREENS_VAULT =
  process.env.GUMPLY_SCREENS_VAULT ?? path.join(os.tmpdir(), 'gumply-e2e-screens-vault');

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
