import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * #5634v3df: blocks dragged the way people drag them, with the real mouse.
 * - ⋮⋮ dragged straight up or down keeps the pointer in the gutter, left of the
 *   text; 0.9.0 refused that drop and nothing moved (images and text alike).
 * - An image block dragged by the image itself moves like its ⋮⋮: one undo
 *   step, no copy (a decision). Inline images keep ⋮⋮ only.
 */

const svg = (fill: string) =>
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="${fill}"/></svg>`);

const A = '![A](attachments/a.svg)';
const B = '![B](attachments/b.svg)';
const C = '![C](attachments/c.svg)';

function pictures() {
  mkdirSync(path.join(E2E_VAULT, 'attachments'), { recursive: true });
  writeFileSync(path.join(E2E_VAULT, 'attachments', 'a.svg'), svg('#3b82f6'));
  writeFileSync(path.join(E2E_VAULT, 'attachments', 'b.svg'), svg('#ef4444'));
  writeFileSync(path.join(E2E_VAULT, 'attachments', 'c.svg'), svg('#22c55e'));
}

/** The page's non-empty lines on disk, without frontmatter. */
const lines = (title: string) => {
  const raw = readFileSync(path.join(E2E_VAULT, `${title}.md`), 'utf8');
  const text = raw.startsWith('---\n') ? raw.slice(raw.indexOf('\n---\n', 4) + 5) : raw;
  return text.split('\n').filter((line) => line.trim() !== '');
};

async function open(page: Page, title: string) {
  await page.goto(`/#/${encodeURIComponent(title)}`);
  await expect(page.getByTestId('editor-content')).toBeVisible();
}

const saved = (page: Page) => expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 });

/** Press, move in small steps, release: the way a person drags. */
async function mouseDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 3, from.y + 3, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 20 });
  await page.mouse.up();
}

/** Hover a point of a block and return the centre of its ⋮⋮. */
async function handleAt(page: Page, at: { x: number; y: number }) {
  await page.mouse.move(at.x, at.y, { steps: 5 });
  await expect(page.getByTestId('block-gutter')).toBeVisible();
  const box = (await page.getByTestId('block-handle').boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function boxOf(page: Page, text: string) {
  return (await page.getByTestId('editor-content').getByText(text, { exact: true }).boundingBox())!;
}

test.describe('blocks move when dragged the way people drag them (#5634v3df)', () => {
  test.beforeEach(async ({ page }) => {
    pictures();
    await page.setViewportSize({ width: 1280, height: 1400 });
  });

  test('⋮⋮ of an image dragged straight down the gutter moves it; then straight up', async ({ page, vault }) => {
    const title = 'Gutter image';
    await vault.seed([{ title, content: `First\n\n${A}\n\nMiddle\n\nLast` }]);
    await open(page, title);
    const img = (await page.getByTestId('image-block-img').boundingBox())!;
    let handle = await handleAt(page, { x: img.x + img.width / 2, y: img.y + 20 });
    const last = await boxOf(page, 'Last');
    await mouseDrag(page, handle, { x: handle.x, y: last.y + last.height - 2 });
    await saved(page);
    await expect.poll(() => lines(title)).toEqual(['First', 'Middle', 'Last', A]);

    const moved = (await page.getByTestId('image-block-img').boundingBox())!;
    handle = await handleAt(page, { x: moved.x + moved.width / 2, y: moved.y + 20 });
    const first = await boxOf(page, 'First');
    await mouseDrag(page, handle, { x: handle.x, y: first.y + 2 });
    await saved(page);
    await expect.poll(() => lines(title)).toEqual([A, 'First', 'Middle', 'Last']);
    await expect(page.getByTestId('column')).toHaveCount(0);
  });

  test('⋮⋮ of a paragraph dragged straight down the gutter moves it, and makes no columns', async ({ page, vault }) => {
    const title = 'Gutter text';
    await vault.seed([{ title, content: 'First\n\nMiddle\n\nLast' }]);
    await open(page, title);
    const first = await boxOf(page, 'First');
    const handle = await handleAt(page, { x: first.x + 10, y: first.y + first.height / 2 });
    const last = await boxOf(page, 'Last');
    await mouseDrag(page, handle, { x: handle.x, y: last.y + last.height - 2 });
    await saved(page);
    await expect.poll(() => lines(title)).toEqual(['Middle', 'Last', 'First']);
    await expect(page.getByTestId('column')).toHaveCount(0);
  });

  test('⋮⋮ of the third image dropped on the first one\'s upper half puts it above', async ({ page, vault }) => {
    const title = 'Three images';
    await vault.seed([{ title, content: `Top\n\n${A}\n\n${B}\n\n${C}\n\nEnd` }]);
    await open(page, title);
    const images = page.getByTestId('image-block-img');
    const c = (await images.nth(2).boundingBox())!;
    const handle = await handleAt(page, { x: c.x + c.width / 2, y: c.y + 20 });
    const a = (await images.nth(0).boundingBox())!;
    await mouseDrag(page, handle, { x: a.x + 40, y: a.y + 10 });
    await saved(page);
    await expect.poll(() => lines(title)).toEqual(['Top', C, A, B, 'End']);
  });

  test('an image block dragged by the image itself moves, one undo step, no copy', async ({ page, vault }) => {
    const title = 'Drag the image';
    await vault.seed([{ title, content: `First\n\n${A}\n\nLast` }]);
    await open(page, title);
    const img = (await page.getByTestId('image-block-img').boundingBox())!;
    const first = await boxOf(page, 'First');
    await mouseDrag(page, { x: img.x + img.width / 2, y: img.y + img.height / 2 }, { x: first.x + 20, y: first.y + 2 });
    await saved(page);
    await expect.poll(() => lines(title)).toEqual([A, 'First', 'Last']);
    await expect(page.getByTestId('image-block')).toHaveCount(1);

    await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+z`);
    await saved(page);
    await expect.poll(() => lines(title)).toEqual(['First', A, 'Last']);
  });

  test('selected caption text dragged into the page moves only the text, not the image', async ({ page, vault }) => {
    const title = 'Drag the caption';
    await vault.seed([{ title, content: 'First\n\n![Caption](attachments/a.svg)\n\nLast' }]);
    await open(page, title);
    const caption = page.getByTestId('image-caption');
    await expect(caption).toHaveValue('Caption');
    await caption.selectText();
    const box = (await caption.boundingBox())!;
    const last = await boxOf(page, 'Last');
    await mouseDrag(page, { x: box.x + 12, y: box.y + box.height / 2 }, { x: last.x + last.width + 2, y: last.y + last.height / 2 });
    await expect(page.getByTestId('editor-content')).toContainText('LastCaption');
    await saved(page);
    const after = lines(title);
    // The image stays where it was (its caption may go with the text), and the text landed in "Last".
    expect(after[0]).toBe('First');
    expect(after[1]).toMatch(/^!\[[^\]]*\]\(attachments\/a\.svg\)$/);
    expect(after[2]).toBe('LastCaption');
    await expect(page.getByTestId('image-block')).toHaveCount(1);
  });
});
