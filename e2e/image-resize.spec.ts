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

// A small image: its natural size is well under the column.
const SMALL = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#f59e0b"/></svg>',
);

function addImage() {
  const dir = path.join(E2E_VAULT, 'attachments');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'wide.svg'), WIDE);
  writeFileSync(path.join(dir, 'small.svg'), SMALL);
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

// The image's own column: its figure's width (the handles, the keys and the announcement all use it).
const columnWidth = (page: Page) => page.getByTestId('image-block').first().evaluate((figure) => figure.clientWidth);

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

test('edit the caption, then resize: the file has the new caption and the width (D37)', async ({ page, request, vault }) => {
  addImage();
  await vault.seed([{ title: 'Caption then size', content: 'Intro\n\n![Old](<attachments/wide.svg>)\n\nAfter' }]);
  await open(page, 'Caption then size');
  const caption = page.getByTestId('image-caption');
  await caption.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('New');
  await saved(request, 'Caption then size', (text) => text.includes('![New]'));

  await page.getByTestId('image-block-img').click();
  const column = await columnWidth(page);
  await page.keyboard.press('Shift+ArrowLeft');
  const after = await saved(request, 'Caption then size', (text) => /!\[New\|\d+\]/.test(text));
  expect(after).not.toContain('Old');
  expect(widthIn(after, 'New')).toBe(Math.round(column * 0.75));
  await expect(page.getByTestId('image-caption')).toHaveValue('New');
});

test('a small image with no width: Shift+← steps down from its drawn size, and the limit is announced', async ({ page, request, vault }) => {
  addImage();
  const content = 'Intro\n\n![[small.svg]]\n\nAfter';
  await vault.seed([{ title: 'Small keys', content }]);
  await open(page, 'Small keys');
  const img = page.getByTestId('image-block-img');
  await expect(img).toBeVisible();
  // From the keyboard: arrow down from the line above selects the image.
  await page.getByTestId('editor-content').getByText('Intro', { exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('image-block')).toHaveClass(/is-selected/);
  const column = await columnWidth(page);
  const drawn = await img.evaluate((element) => element.getBoundingClientRect().width);
  expect(drawn).toBeLessThan(column * 0.5);

  // 200 px in a wider column is under 50%: one step down is 25%, never a bigger 75%.
  await page.keyboard.press('Shift+ArrowLeft');
  const after = await saved(request, 'Small keys', (text) => text.includes('![[small.svg|'));
  expect(widthIn(after, 'small.svg')).toBe(Math.round(column * 0.25));
  const status = page.getByTestId('image-width-status');
  await expect(status).toHaveText('Image width 25%');
  // At the smallest step another Shift+← changes nothing, and says so.
  await page.keyboard.press('Shift+ArrowLeft');
  await expect(status).toHaveText('Image width 25%: the smallest step');
  expect((await api.getPage(request, 'Small keys')).content).toBe(after);
});

test('a small image stepped up to full width is the column wide, not back at its natural size', async ({ page, request, vault }) => {
  addImage();
  await vault.seed([{ title: 'Small full', content: 'Intro\n\n![[small.svg]]\n\nAfter' }]);
  await open(page, 'Small full');
  await page.getByTestId('image-block-img').click();
  const column = await columnWidth(page);
  for (const share of [0.5, 0.75]) {
    await page.keyboard.press('Shift+ArrowRight');
    await saved(request, 'Small full', (text) => widthIn(text, 'small.svg') === Math.round(column * share));
  }
  await page.keyboard.press('Shift+ArrowRight');
  const full = await saved(request, 'Small full', (text) => widthIn(text, 'small.svg') === Math.round(column));
  const status = page.getByTestId('image-width-status');
  await expect(status).toHaveText('Image width 100%');
  // Drawn at the column's width, not its natural 200 px.
  const drawn = await page.getByTestId('image-block-img').evaluate((element) => element.getBoundingClientRect().width);
  expect(Math.abs(drawn - column)).toBeLessThanOrEqual(2);
  // At the full width another Shift+→ changes nothing, and says so.
  await page.keyboard.press('Shift+ArrowRight');
  await expect(status).toHaveText('Image width 100%: the full page width');
  expect((await api.getPage(request, 'Small full')).content).toBe(full);
});

test('a caption typed ending in |digits stays a caption, and a resize after it keeps it', async ({ page, request, vault }) => {
  addImage();
  await vault.seed([{ title: 'Caption pipe', content: 'Intro\n\n![Old](attachments/wide.svg)\n\nAfter' }]);
  await open(page, 'Caption pipe');
  await page.getByTestId('image-caption').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('B|300');
  await saved(request, 'Caption pipe', (text) => text.includes('![B\\|300](attachments/wide.svg)'));
  // Not a width: the picture keeps the full column, and the caption reads as typed.
  await expect(page.getByTestId('image-block')).not.toHaveAttribute('data-width');
  await expect(page.getByTestId('image-caption')).toHaveValue('B|300');

  await page.getByTestId('image-block-img').click();
  const column = await columnWidth(page);
  await page.keyboard.press('Shift+ArrowLeft');
  const after = await saved(request, 'Caption pipe', (text) => text.includes(`![B\\|300|${Math.round(column * 0.75)}](attachments/wide.svg)`));
  expect(after).toContain('Intro');
  await expect(page.getByTestId('image-caption')).toHaveValue('B|300');
});

test('a copied and pasted «B|300» image keeps it a caption', async ({ page, request, vault, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  addImage();
  await vault.seed([{ title: 'Caption paste', content: 'Intro\n\n![Old](attachments/wide.svg)\n\nAfter' }]);
  await open(page, 'Caption paste');
  await page.getByTestId('image-caption').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('B|300');
  await saved(request, 'Caption paste', (text) => text.includes('![B\\|300](attachments/wide.svg)'));

  await page.getByTestId('image-block-img').click();
  await page.keyboard.press('ControlOrMeta+c');
  await page.getByTestId('editor-content').getByText('After', { exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.press('ControlOrMeta+v');
  await expect(page.getByTestId('image-block')).toHaveCount(2);
  const after = await saved(request, 'Caption paste', (text) => text.split('![B\\|300](attachments/wide.svg)').length === 3);
  expect(after).not.toMatch(/!\[B\|300\]/);
  await expect(page.getByTestId('image-block').nth(1)).not.toHaveAttribute('data-width');
});

test('an image pasted from another app keeps an alt ending in «| 2024» as its caption, not a width', async ({ page, request, vault }) => {
  addImage();
  await vault.seed([{ title: 'Foreign paste', content: 'Intro' }]);
  await open(page, 'Foreign paste');
  const body = page.getByTestId('editor-content');
  await body.getByText('Intro', { exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  // A web page's HTML: alt text has no Obsidian meaning, so «| 2024» is part of the caption.
  await body.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.setData('text/html', '<p><img src="attachments/wide.svg" alt="Revenue | 2024"></p>');
    transfer.setData('text/plain', '');
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
  });
  await expect(page.getByTestId('image-block')).toHaveCount(1);
  await expect(page.getByTestId('image-block')).not.toHaveAttribute('data-width');
  await expect(page.getByTestId('image-caption')).toHaveValue('Revenue | 2024');
  const content = await saved(request, 'Foreign paste', (text) => text.includes('wide.svg'));
  expect(content).toContain('![Revenue \\| 2024](attachments/wide.svg)');
});

test('a copied and pasted sized image keeps its width', async ({ page, request, vault, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  addImage();
  await vault.seed([{ title: 'Sized paste', content: 'Intro\n\n![Cap|300](attachments/wide.svg)\n\nAfter' }]);
  await open(page, 'Sized paste');
  await expect(page.getByTestId('image-block').first()).toHaveAttribute('data-width', '300');
  await page.getByTestId('image-block-img').click();
  await page.keyboard.press('ControlOrMeta+c');
  await page.getByTestId('editor-content').getByText('After', { exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.press('ControlOrMeta+v');
  await expect(page.getByTestId('image-block')).toHaveCount(2);
  await expect(page.getByTestId('image-block').nth(1)).toHaveAttribute('data-width', '300');
  await saved(request, 'Sized paste', (text) => text.split('![Cap|300](attachments/wide.svg)').length === 3);
});

test('a copied and pasted file caption «A\\|301» stays a caption', async ({ page, request, vault, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  addImage();
  await vault.seed([{ title: 'Escaped paste', content: 'Intro\n\n![A\\|301](attachments/wide.svg)\n\nAfter' }]);
  await open(page, 'Escaped paste');
  await expect(page.getByTestId('image-block').first()).not.toHaveAttribute('data-width');
  await page.getByTestId('image-block-img').click();
  await page.keyboard.press('ControlOrMeta+c');
  await page.getByTestId('editor-content').getByText('After', { exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.press('ControlOrMeta+v');
  await expect(page.getByTestId('image-block')).toHaveCount(2);
  await expect(page.getByTestId('image-block').nth(1)).not.toHaveAttribute('data-width');
  await expect(page.getByTestId('image-caption').nth(1)).toHaveValue('A|301');
  const after = await saved(request, 'Escaped paste', (text) => text.split('![A\\|301](attachments/wide.svg)').length === 3);
  expect(after).not.toMatch(/!\[A\|301\]/);
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
