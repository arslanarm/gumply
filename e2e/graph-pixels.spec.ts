import { test, expect } from './fixtures';

const THEME_KEY = 'gumply:theme';

/**
 * Q1b: the graph must actually paint, not just have an aria-label.
 * Reads the canvas pixels directly (the canvas background is transparent, so
 * any painted node/link/label has alpha > 0). Runs in Chromium and Firefox
 * via the Firefox project in `playwright.config.ts`.
 */
for (const theme of ['light', 'dark'] as const) {
  test(`graph paints real pixels (${theme})`, async ({ page, vault }) => {
    test.setTimeout(45_000);
    await vault.seed([
      { title: 'Alpha', content: 'Links to [[Beta]] and [[Gamma]].' },
      { title: 'Beta', content: 'Back to [[Alpha]].' },
      { title: 'Gamma', content: 'Another page.' },
    ]);

    await page.addInitScript(
      ({ key, value }) => window.localStorage.setItem(key, value),
      { key: THEME_KEY, value: theme },
    );
    await page.goto('/');
    await page.getByTestId('sidebar-graph').click();

    const canvas = page.getByTestId('graph-canvas').locator('canvas');
    await expect(canvas).toBeVisible();
    // Let the force layout settle and paint.
    await page.waitForTimeout(1_200);

    const stats = await canvas.evaluate((element) => {
      const node = element as HTMLCanvasElement;
      const context = node.getContext('2d');
      if (!context || node.width === 0 || node.height === 0) {
        return { width: node.width, height: node.height, drawn: 0 };
      }
      const data = context.getImageData(0, 0, node.width, node.height).data;
      let drawn = 0;
      for (let index = 3; index < data.length; index += 4) {
        if ((data[index] ?? 0) > 16) drawn += 1;
      }
      return { width: node.width, height: node.height, drawn };
    });

    expect(stats.width).toBeGreaterThan(0);
    expect(stats.height).toBeGreaterThan(0);
    // Three nodes + links + labels: far more than a blank canvas.
    expect(stats.drawn).toBeGreaterThan(200);
  });
}
