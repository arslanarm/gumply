import { expect, test, type Page } from '@playwright/test';

/**
 * #b9425ktw D (#fzrwse3y's P3 6): a multi-selection can be aligned and distributed from the context toolbar's
 * Align panel; each action is one undo step, and is said aloud. Driven through the board lab, like board-engine.
 */

interface Box {
  id: string;
  text?: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const nodes = (page: Page): Promise<Box[]> =>
  page.evaluate(() => (window as unknown as { __board: { get(): { nodes: Box[] } } }).__board.get().nodes);

async function threeStickies(page: Page) {
  await page.goto('/board-lab.html?theme=light&reset=1');
  const view = (await page.getByTestId('board').boundingBox())!;
  for (const [dx, dy, text] of [[-300, -120, 'One'], [-20, 60, 'Two'], [320, -40, 'Three']] as const) {
    await page.mouse.dblclick(view.x + view.width / 2 + dx, view.y + view.height / 2 + dy);
    await expect(page.getByTestId('board-text-editor')).toBeFocused();
    await page.keyboard.type(text);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('board-text-editor')).toHaveCount(0);
  }
  expect(await nodes(page)).toHaveLength(3);
}

test('Align: left lines up the selection\'s left edges in one undo step; one object has no Align button', async ({ page }) => {
  await threeStickies(page);
  // One object selected: no Align.
  await page.getByTestId('board-sticky').first().click();
  await expect(page.getByTestId('board-context-toolbar')).toBeVisible();
  await expect(page.getByTestId('board-align')).toHaveCount(0);
  await page.keyboard.press('Control+a');
  await page.getByTestId('board-align').click();
  await expect(page.getByTestId('board-align-menu')).toBeVisible();
  const before = await nodes(page);
  await page.getByTestId('board-align-left').click();
  const left = Math.min(...before.map((node) => node.x));
  await expect.poll(async () => (await nodes(page)).map((node) => node.x)).toEqual([left, left, left]);
  // y untouched.
  expect((await nodes(page)).map((node) => node.y)).toEqual(before.map((node) => node.y));
  await expect(page.getByTestId('board-announcer')).toContainText(/Aligned 3 objects/);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await nodes(page)).map((node) => node.x)).toEqual(before.map((node) => node.x));
});

test('Distribute horizontally: equal gaps, the outer two stay; it needs three objects', async ({ page }) => {
  await threeStickies(page);
  await page.keyboard.press('Control+a');
  await page.getByTestId('board-align').click();
  const before = (await nodes(page)).sort((a, b) => a.x - b.x);
  await page.getByTestId('board-align-horizontal').click();
  const after = (await nodes(page)).sort((a, b) => a.x - b.x);
  expect(after[0]!.x).toBe(before[0]!.x);
  expect(after[2]!.x).toBe(before[2]!.x);
  const gap1 = after[1]!.x - (after[0]!.x + after[0]!.width);
  const gap2 = after[2]!.x - (after[1]!.x + after[1]!.width);
  expect(Math.abs(gap1 - gap2)).toBeLessThanOrEqual(1);
  // Two selected: distribute is offered but disabled. (Escape closes the panel first: it sits over the board.)
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('board-align-menu')).toHaveCount(0);
  await page.getByTestId('board-sticky').nth(0).click();
  await page.getByTestId('board-sticky').nth(1).click({ modifiers: ['Shift'] });
  await page.getByTestId('board-align').click();
  await expect(page.getByTestId('board-align-horizontal')).toBeDisabled();
  await expect(page.getByTestId('board-align-left')).toBeEnabled();
});

test('Align by keyboard (@lead): Alt+Shift shortcuts on a multi-selection (Tab would select one object), and the panel\'s own keys', async ({ page }) => {
  await threeStickies(page);
  await page.keyboard.press('Control+a');
  const before = await nodes(page);
  // Alt+Shift+L: align left, one undo step.
  await page.keyboard.press('Alt+Shift+KeyL');
  const left = Math.min(...before.map((node) => node.x));
  await expect.poll(async () => (await nodes(page)).map((node) => node.x)).toEqual([left, left, left]);
  // Alt+Shift+M: align middles (same height stickies: one centre line).
  await page.keyboard.press('Alt+Shift+KeyM');
  await expect.poll(async () => new Set((await nodes(page)).map((node) => node.y + node.height / 2)).size).toBe(1);
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await nodes(page)).map((node) => [node.x, node.y])).toEqual(before.map((node) => [node.x, node.y]));
  // The panel: a focused Align button opens it with Enter on its first action; arrows move in the 3×3 (objects
  // stay put); Enter applies without opening an editor; Escape closes it back to the button, selection kept.
  const button = page.getByTestId('board-align');
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('board-align-menu')).toBeVisible();
  await expect(page.getByTestId('board-align-left')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('board-align-center')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('board-align-middle')).toBeFocused();
  expect((await nodes(page)).map((node) => [node.x, node.y])).toEqual(before.map((node) => [node.x, node.y]));
  await page.keyboard.press('Enter');
  await expect.poll(async () => new Set((await nodes(page)).map((node) => node.y + node.height / 2)).size).toBe(1);
  await expect(page.getByTestId('board-text-editor')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('board-align-menu')).toHaveCount(0);
  await expect(button).toBeFocused();
  await expect(page.getByTestId('board-context-toolbar')).toBeVisible();
});
