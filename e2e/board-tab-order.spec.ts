import { expect, test, type Page } from '@playwright/test';

/**
 * #b9425ktw C (#fzrwse3y's P3 7 and P4 8): the tool toolbar is the board's first Tab stop (it's first on screen;
 * it was the last, 19 Tabs after the first object), and the React Flow attribution stays visible, as its licence
 * asks, but isn't a Tab stop. Driven through the board lab, like board-engine.
 */

/** The board's Tab stops in order: a label for each (the toolbar's tools, objects, other controls). */
const tabStops = (page: Page): Promise<string[]> =>
  page.getByTestId('board').evaluate((root) =>
    [...root.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]')]
      .filter((element) => element.tabIndex >= 0 && !(element as HTMLButtonElement).disabled && element.getClientRects().length > 0)
      // A node first: React Flow gives each its own data-testid (rf__node-…).
      .map((element) => (element.classList.contains('react-flow__node') ? 'node' : (element.dataset.testid ?? element.tagName.toLowerCase()))),
  );

test('the tool toolbar comes before the objects in Tab order, and the attribution is visible but not a Tab stop', async ({ page }) => {
  await page.goto('/board-lab.html?theme=light&reset=1');
  const view = (await page.getByTestId('board').boundingBox())!;
  for (const [dx, text] of [[-200, 'One'], [200, 'Two']] as const) {
    await page.mouse.dblclick(view.x + view.width / 2 + dx, view.y + view.height / 2);
    await expect(page.getByTestId('board-text-editor')).toBeFocused();
    await page.keyboard.type(text);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('board-text-editor')).toHaveCount(0);
  }
  const stops = await tabStops(page);
  const firstTool = stops.indexOf('board-tool-select');
  const firstNode = stops.indexOf('node');
  expect(firstTool, stops.join(', ')).toBeGreaterThanOrEqual(0);
  expect(firstNode, stops.join(', ')).toBeGreaterThanOrEqual(0);
  expect(firstTool, stops.join(', ')).toBeLessThan(firstNode);
  // From the first object, Shift+Tab goes to the toolbar (before, it left the board): one step back, not 19 Tabs on.
  await page.locator('.react-flow__node').first().focus();
  await page.keyboard.press('Shift+Tab');
  expect(await page.evaluate(() => document.activeElement?.closest('[data-testid="board-toolbar"]') !== null)).toBe(true);
  const attribution = page.locator('.react-flow__attribution a');
  await expect(attribution).toBeVisible();
  await expect(attribution).toHaveAttribute('tabindex', '-1');
});
