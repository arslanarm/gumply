import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { APIRequestContext, Page } from '@playwright/test';
import { api, expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * #e9bd64bb (D46): block images with a width in Obsidian's `|N` syntax.
 * Untouched images keep their bytes; a resize (a side handle, or Shift+←/→
 * with the image selected) rewrites only that image's size, snapped to
 * 25/50/75/100% of the column; 100% writes no size, so the original returns.
 */

// A wide image, so its natural size fills the column.
const WIDE = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="400"><rect width="1600" height="400" fill="#3b82f6"/></svg>',
);

function addImage() {
  const dir = path.join(E2E_VAULT, 'attachments');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'wide.svg'), WIDE);
}

async function open(page: Page, id: string) {
  await page.goto(`/#/${encodeURIComponent(id)}`);
  await expect(page.getByTestId('editor-content')).toBeVisible();
}

async function saved(request: APIRequestContext, id: string, predicate: (content: string) => boolean) {
  let content = '';
  await expect.poll(async () => predicate((content = (await api.getPage(request, id)).content)), { timeout: 10_000 }).toBe(true);
  return content;
}

/** The width written in the line holding `marker`, or null. */
function widthIn(content: string, marker: string): number | null {
  const line = content.split('\n').find((candidate) => candidate.includes(marker)) ?? '';
  const match = /\|(\d+)(?:\]\]|\])/.exec(line);
  return match ? Number(match[1]) : null;
}

const columnWidth = (page: Page) =>
  page.getByTestId('image-block').first().evaluate((figure) => figure.parentElement?.clientWidth ?? figure.clientWidth);

test('untouched images keep their exact bytes, and show the width they have', async ({ page, request, vault }) => {
  addImage();
  const content = 'Intro\n\n![Sized|200](attachments/wide.svg)\n\n![Plain](<attachments/wide.svg>)\n\n![Tiny icon|16](attachments/wide.svg) in a line';
  await vault.seed([{ title: 'Images kept', content }]);
  await open(page, 'Images kept');
  const frames = page.getByTestId('image-block').locator('.image-frame');
  await expect(frames.first()).toHaveAttribute('style', /width: 200px/);
  await expect(page.getByTestId('image-block').first()).toHaveAttribute('data-width', '200');
  // An inline image with a size is that wide, as in Obsidian.
  await expect(page.getByTestId('inline-image')).toHaveAttribute('width', '16');
  // The caption shows the text only.
  await expect(page.getByTestId('image-caption').first()).toHaveValue('Sized');

  await page.getByTestId('editor-content').getByText('Intro', { exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' text');
  const after = await saved(request, 'Images kept', (text) => text.startsWith('Intro text'));
  expect(after).toBe(content.replace('Intro', 'Intro text'));
});

test('a side handle resizes to 50% of the column; only that image changes, as written', async ({ page, request, vault }) => {
  addImage();
  const content = 'Intro\n\n![Plain](<attachments/wide.svg>)\n\nAfter';
  await vault.seed([{ title: 'Resize drag', content }]);
  await open(page, 'Resize drag');
  const img = page.getByTestId('image-block-img');
  await img.click();
  const handle = page.getByTestId('image-resize-right');
  await expect(handle).toBeVisible();
  const column = await columnWidth(page);
  const box = (await handle.boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x - column * 0.25, y, { steps: 6 });
  await page.mouse.move(box.x - column * 0.48, y, { steps: 6 });
  await page.mouse.up();

  const after = await saved(request, 'Resize drag', (text) => /\|\d+\]/.test(text));
  const written = widthIn(after, 'Plain');
  expect(Math.abs(written! - column * 0.5)).toBeLessThanOrEqual(2);
  // The link keeps its angle brackets: only the size was added.
  expect(after).toBe(`Intro\n\n![Plain|${written}](<attachments/wide.svg>)\n\nAfter`);
  await expect(page.getByTestId('image-width-status')).toHaveText('Image width 50%');
});

test('Shift+←/→ step the width of a selected embed; back at 100% the original bytes return', async ({ page, request, vault }) => {
  addImage();
  const content = 'Intro\n\n![[wide.svg]]\n\nAfter';
  await vault.seed([{ title: 'Resize keys', content }]);
  await open(page, 'Resize keys');
  await page.getByTestId('image-block-img').click();
  const column = await columnWidth(page);

  await page.keyboard.press('Shift+ArrowLeft');
  let after = await saved(request, 'Resize keys', (text) => text.includes('![[wide.svg|'));
  expect(widthIn(after, 'wide.svg')).toBe(Math.round(column * 0.75));
  await page.keyboard.press('Shift+ArrowLeft');
  after = await saved(request, 'Resize keys', (text) => widthIn(text, 'wide.svg') === Math.round(column * 0.5));

  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  after = await saved(request, 'Resize keys', (text) => text.includes('![[wide.svg]]'));
  expect(after).toBe(content);
});

test('editing the caption keeps the size', async ({ page, request, vault }) => {
  addImage();
  await vault.seed([{ title: 'Caption size', content: '![Cat|200](attachments/wide.svg)' }]);
  await open(page, 'Caption size');
  const caption = page.getByTestId('image-caption');
  await caption.click();
  await page.keyboard.press('End');
  await page.keyboard.type('s');
  await saved(request, 'Caption size', (text) => text === '![Cats|200](attachments/wide.svg)');
});

test('an image block moves with ⋮⋮ like any block', async ({ page, request, vault }) => {
  addImage();
  await vault.seed([{ title: 'Image drag', content: 'First\n\n![Pic](attachments/wide.svg)\n\nLast' }]);
  await open(page, 'Image drag');
  await page.getByTestId('image-block-img').hover();
  await expect(page.getByTestId('block-gutter')).toBeVisible();
  await page.getByTestId('block-handle').dragTo(page.getByTestId('editor-content').getByText('First', { exact: true }), {
    targetPosition: { x: 20, y: 2 },
  });
  await saved(request, 'Image drag', (text) => text === '![Pic](attachments/wide.svg)\n\nFirst\n\nLast');
});

test('dragging the image itself never leaves a copy (#n6cy66ib)', async ({ page, request, vault }) => {
  addImage();
  await vault.seed([{ title: 'Image self drag', content: 'First\n\n![Pic](attachments/wide.svg)\n\nLast' }]);
  await open(page, 'Image self drag');
  const img = page.getByTestId('image-block-img');
  await expect(img).toBeVisible();
  // A real mouse drag of the picture onto "Last" (not the ⋮⋮ handle): press,
  // move in steps, release, as a hand would.
  const from = (await img.boundingBox())!;
  const to = (await page.getByTestId('editor-content').getByText('Last', { exact: true }).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + 20, to.y + to.height + 4, { steps: 12 });
  await page.mouse.up();
  await page.getByTestId('editor-content').getByText('First', { exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  const after = await saved(request, 'Image self drag', (text) => text.startsWith('First!'));
  // Moved or left in place, but exactly one image either way.
  expect(after.match(/!\[Pic\]\(attachments\/wide\.svg\)/g)).toHaveLength(1);
  await expect(page.getByTestId('image-block')).toHaveCount(1);
});
