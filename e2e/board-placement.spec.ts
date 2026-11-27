import { expect, test, type Page } from '@playwright/test';

/**
 * #b9425ktw (#fzrwse3y's P3 5): "Add page…" puts the new card in free space near the view's centre, not on top of
 * what's there (it covered two items and took their clicks). Driven through the board lab, like board-engine.
 */

interface Box {
  type: string;
  file?: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const nodes = (page: Page): Promise<Box[]> =>
  page.evaluate(() => (window as unknown as { __board: { get(): { nodes: Box[] } } }).__board.get().nodes);

const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test('a page card added from the toolbar lands next to the items at the view\'s centre, covering none of them', async ({ page }) => {
  await page.goto('/board-lab.html?theme=light&reset=1');
  const view = (await page.getByTestId('board').boundingBox())!;
  const cx = view.x + view.width / 2;
  const cy = view.y + view.height / 2;
  for (const [dx, text] of [[-60, 'Tomatoes'], [140, 'Pond']] as const) {
    await page.mouse.dblclick(cx + dx, cy);
    await expect(page.getByTestId('board-text-editor')).toBeFocused();
    await page.keyboard.type(text);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('board-text-editor')).toHaveCount(0);
  }
  const before = await nodes(page);
  expect(before).toHaveLength(2);
  await page.keyboard.press('v');
  await page.getByTestId('board-tool-page').click();
  await page.getByTestId('board-page-picker-input').fill('q1');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('board-card-page')).toBeVisible();
  const card = (await nodes(page)).find((node) => node.type === 'file')!;
  for (const item of before) expect(overlaps(card, item), `covers an item at ${item.x},${item.y}`).toBe(false);
  // Still near the centre: within a card's width or so of where it was asked for.
  const centreFlow = before.reduce((sum, item) => sum + item.x + item.width / 2, 0) / before.length;
  expect(Math.abs(card.x + card.width / 2 - centreFlow)).toBeLessThan(700);
});
