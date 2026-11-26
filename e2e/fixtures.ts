import { test as base, expect } from '@playwright/test';
import * as apiClient from './support/api';
import { waitForBootOnNavigation } from './support/nav';
import { restoreSettings, runSettingsBaseline, type SettingsSnapshot } from './support/vault-settings';

export interface Vault {
  /** Delete every page, leaving an empty vault. */
  reset(): Promise<void>;
  /** Create pages in order (parents before children). Returns the created pages. */
  seed(pages: apiClient.NewPage[]): Promise<apiClient.Page[]>;
  pages(): Promise<apiClient.PageMeta[]>;
}

/**
 * `vault` gives every test a clean vault (it runs for every test, asked for or not) and a fast way to build
 * fixtures through the API instead of the UI. See wiki `spec/e2e-tests`.
 */
export const test = base.extend<{ vault: Vault }, { settingsBaseline: SettingsSnapshot }>({
  // #w284vn2u: the vault's settings files as the run started (taken once, in the main process), put back
  // around every test.
  settingsBaseline: [async ({}, use) => use(runSettingsBaseline()), { scope: 'worker' }],
  // #rqtacq4d: `page.goto` / `page.reload` return once the app has booted, with a
  // load-aware budget (support/nav.ts); in-page assertions keep the strict 5 s.
  page: async ({ page }, use, testInfo) => {
    waitForBootOnNavigation(page, testInfo);
    await use(page);
  },
  // #dh3jdu7g: automatic, so every test (named `vault` or not) starts from an empty vault and leaves one behind;
  // a page or board created by a test that never asked for `vault` can't change what `/` opens or what a
  // listing shows in a later spec (trial-main21: board-engine opened whiteboards.spec's leftover "Drops").
  vault: [async ({ request, settingsBaseline }, use) => {
    const vault: Vault = {
      reset: () => apiClient.resetVault(request),
      pages: () => apiClient.listPages(request),
      async seed(pages) {
        const created: apiClient.Page[] = [];
        for (const p of pages) created.push(await apiClient.createPage(request, p));
        return created;
      },
    };

    // #w284vn2u: before too, so a test that doesn't use `vault` can't leak into one that does.
    await restoreSettings(settingsBaseline);
    await vault.reset();
    await use(vault);

    // Don't mask a failed test with a cleanup error (e.g. server crashed).
    await vault.reset().catch(() => {});
    await restoreSettings(settingsBaseline).catch(() => {});
  }, { auto: true }],
});

export { expect };
export * as api from './support/api';
