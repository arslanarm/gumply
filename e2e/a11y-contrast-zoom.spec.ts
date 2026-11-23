import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from './fixtures';
import { contrastFailures } from './support/contrast';
import { E2E_VAULT } from './support/env';

/**
 * #3nnx98m4 (v0.9 a11y audit #6–7): text contrast ≥ 4.5:1 on the audited
 * screens in light and dark (WCAG 1.4.3), and every board tool reachable at
 * 200% zoom (WCAG 1.4.10).
 */

const SAMPLE = [
  'Plain text with a #project tag and an [[Other]] link.',
  '',
  '> [!note] Note title',
  '> Body.',
  '',
  '> [!tip] Tip title',
  '> Body.',
  '',
  '> [!success] Success title',
  '> Body.',
  '',
  '> [!warning] Warning title',
  '> Body.',
  '',
  '> [!bug] Bug title',
  '> Body.',
  '',
  '> [!example] Example title',
  '> Body.',
  '',
  '> [!quote] Quote title',
  '> Body.',
  '',
  '```js',
  'const answer = 42; // the answer',
  'function hello() { return "hi"; }',
  '```',
].join('\n');

for (const scheme of ['light', 'dark'] as const) {
  test(`text contrast ≥ 4.5:1 on the page, Settings and AI apps (${scheme})`, async ({ page, vault }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await vault.seed([{ title: 'Other', content: 'Other.' }, { title: 'Sample', content: SAMPLE }]);
    await page.goto('/#/Sample');
    await expect(page.getByTestId('editor-content')).toContainText('Quote title');
    await expect(page.locator('.code-block-language').first()).toBeVisible();

    expect(await contrastFailures(page.locator('body'))).toEqual([]);

    await page.getByTestId('settings-button').click();
    await expect(page.getByTestId('settings-popover')).toBeVisible();
    expect(await contrastFailures(page.getByTestId('settings-popover'))).toEqual([]);

    await page.getByTestId('settings-mcp').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await page.waitForTimeout(300);
    expect(await contrastFailures(dialog)).toEqual([]);
  });
}

test('at 200% zoom every board tool can be reached and used, nothing clipped', async ({ page }) => {
  // 1280×860 at 200% is 640×430 CSS pixels.
  await page.setViewportSize({ width: 640, height: 430 });
  const board = JSON.stringify({ nodes: [{ id: 'a', type: 'text', text: 'Card', x: 0, y: 0, width: 200, height: 80 }], edges: [] });
  await writeFile(path.join(E2E_VAULT, 'Plan.canvas'), `${board}\n`, 'utf8');
  await page.goto('/#/Plan.canvas');
  const toolbar = page.getByTestId('board-toolbar');
  await expect(toolbar).toBeVisible({ timeout: 15_000 });
  const canvas = await page.locator('.board-root').first().boundingBox();
  const buttons = toolbar.locator('button');
  const count = await buttons.count();
  expect(count).toBeGreaterThanOrEqual(12);
  for (let index = 0; index < count; index += 1) {
    const box = await buttons.nth(index).boundingBox();
    // Wholly inside the board: nothing cut off at the top or bottom.
    expect(box, `tool ${index}`).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(canvas!.y);
    expect(box!.y + box!.height).toBeLessThanOrEqual(canvas!.y + canvas!.height);
    expect(box!.x + box!.width).toBeLessThanOrEqual(canvas!.x + canvas!.width);
  }
  // The last drawing tool works from a click, and the card stays in view.
  await toolbar.getByRole('button', { name: /^Text/ }).click();
  await expect(toolbar.getByRole('button', { name: /^Text/ })).toHaveClass(/is-active/);
  await expect(page.locator('.board-root').getByText('Card')).toBeInViewport();
});
