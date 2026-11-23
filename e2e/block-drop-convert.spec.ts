import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * #2kafk39m: a ⋮⋮ drop the block can't make as it is is converted, the Notion way, and only the moved
 * block's lines change on disk (D37); a drop that can't be converted changes nothing.
 */
const body = async (title: string) => {
  const raw = await readFile(path.join(E2E_VAULT, `${title}.md`), 'utf8');
  const text = raw.startsWith('---\n') ? raw.slice(raw.indexOf('\n---\n', 4) + 5) : raw;
  return text.split('\n').filter((line) => line.trim() !== '');
};

async function drag(page: Page, from: string, onto: string, where: 'above' | 'below') {
  const editor = page.getByTestId('editor-content');
  await editor.getByText(from, { exact: true }).hover();
  await expect(page.getByTestId('block-gutter')).toBeVisible();
  const target = editor.getByText(onto, { exact: true });
  const box = (await target.boundingBox())!;
  await page.getByTestId('block-handle').dragTo(target, { targetPosition: { x: 20, y: where === 'above' ? 2 : box.height - 2 } });
}

async function open(page: Page, title: string) {
  await page.goto(`/#/${encodeURIComponent(title)}`);
  await expect(page.getByTestId('editor-content')).toBeVisible();
}

const saved = (page: Page) => expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 });

test.describe('a refused block drop is converted or refused (#2kafk39m)', () => {
  test('a to-do dragged out of its list to the top becomes its own one-item list, its line byte for byte', async ({ page, vault }) => {
    await vault.seed([{ title: 'Out of list', content: 'Top\n\n- [ ] one\n- [ ] two\n\nEnd' }]);
    await open(page, 'Out of list');
    await drag(page, 'one', 'Top', 'above');
    await saved(page);
    await expect.poll(() => body('Out of list')).toEqual(['- [ ] one', 'Top', '- [ ] two', 'End']);
    await page.reload();
    await expect(page.getByTestId('editor-content').locator('li')).toHaveCount(2);
  });

  test('a paragraph dropped between bullets becomes a bullet; nothing else changes', async ({ page, vault }) => {
    await vault.seed([{ title: 'Into bullets', content: 'Para\n\n- a\n- b' }]);
    await open(page, 'Into bullets');
    await drag(page, 'Para', 'a', 'below');
    await saved(page);
    await expect.poll(() => body('Into bullets')).toEqual(['- a', '- Para', '- b']);
  });

  test('in a numbered list it takes the number its neighbours imply, and no other item is renumbered', async ({ page, vault }) => {
    await vault.seed([{ title: 'Into numbers', content: 'Para\n\n1. one\n2. two\n3. three' }]);
    await open(page, 'Into numbers');
    await drag(page, 'Para', 'one', 'below');
    await saved(page);
    await expect.poll(() => body('Into numbers')).toEqual(['1. one', '2. Para', '2. two', '3. three']);
  });

  test('a multi-line paragraph keeps its lines inside the item, and the next save changes nothing', async ({ page, vault }) => {
    await vault.seed([{ title: 'Two lines', content: 'Line one\nline two\n\n- a\n- b' }]);
    await open(page, 'Two lines');
    await drag(page, 'Line one', 'a', 'below');
    await saved(page);
    await expect.poll(() => body('Two lines')).toEqual(['- a', '- Line one', '  line two', '- b']);
    const after = await readFile(path.join(E2E_VAULT, 'Two lines.md'), 'utf8');
    // round trip: reload, type and undo a character elsewhere, save again: the same bytes
    await page.reload();
    const b = page.getByTestId('editor-content').getByText('b', { exact: true });
    await b.click();
    await page.keyboard.press('End');
    await page.keyboard.type('x');
    await page.keyboard.press('Backspace');
    await saved(page);
    expect(await readFile(path.join(E2E_VAULT, 'Two lines.md'), 'utf8')).toBe(after);
  });

  test('a heading dragged onto a list is refused: the file is untouched', async ({ page, vault }) => {
    await vault.seed([{ title: 'No drop', content: '## Head\n\n- a\n- b' }]);
    await open(page, 'No drop');
    const before = await readFile(path.join(E2E_VAULT, 'No drop.md'), 'utf8');
    await drag(page, 'Head', 'b', 'below');
    await page.waitForTimeout(1500);
    expect(await readFile(path.join(E2E_VAULT, 'No drop.md'), 'utf8')).toBe(before);
    await expect(page.getByTestId('editor-content').locator('h2')).toHaveText('Head');
  });
});
