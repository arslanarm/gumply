import { test as base, expect } from '@playwright/test';
import * as apiClient from './support/api';
import { waitForBootOnNavigation } from './support/nav';

export interface Vault {
  /** Delete every page, leaving an empty vault. */
  reset(): Promise<void>;
  /** Create pages in order (parents before children). Returns the created pages. */
  seed(pages: apiClient.NewPage[]): Promise<apiClient.Page[]>;
  pages(): Promise<apiClient.PageMeta[]>;
}

/**
 * `vault` gives every test a clean vault and a fast way to build fixtures
 * through the API instead of the UI. See wiki `spec/e2e-tests`.
 */
export const test = base.extend<{ vault: Vault }>({
  // #rqtacq4d: `page.goto` / `page.reload` return once the app has booted, with a
  // load-aware budget (support/nav.ts); in-page assertions keep the strict 5 s.
  page: async ({ page }, use, testInfo) => {
    waitForBootOnNavigation(page, testInfo);
    await use(page);
  },
  vault: async ({ request }, use) => {
    const vault: Vault = {
      reset: () => apiClient.resetVault(request),
      pages: () => apiClient.listPages(request),
      async seed(pages) {
        const created: apiClient.Page[] = [];
        for (const p of pages) created.push(await apiClient.createPage(request, p));
        return created;
      },
    };

    await vault.reset();
    await use(vault);

    // Don't mask a failed test with a cleanup error (e.g. server crashed).
    await vault.reset().catch(() => {});
  },
});

export { expect };
export * as api from './support/api';
