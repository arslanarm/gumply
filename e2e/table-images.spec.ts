import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * #sv5cwevx (D37): an image in a table cell stays in its cell. It used to be lifted to the end of
 * the page, so each save of an edit elsewhere appended another copy of it there (the table itself
 * kept its bytes). The shapes are @opus-hunter's D37 sweep shapes.
 */

/** A 1×1 PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const body = (raw: string) => (raw.startsWith('---\n') ? raw.slice(raw.indexOf('\n---\n', 4) + 5) : raw);

const shapes: Array<{ name: string; table: string }> = [
  { name: 'an embed', table: '| A | B |\n|---|---|\n| text | ![[a.png]] |\n' },
  { name: 'an embed with a width', table: '| A | B |\n|---|---|\n| text | ![[a.png\\|300]] |\n' },
  { name: 'a Markdown image', table: '| A | B |\n|---|---|\n| text | ![](attachments/a.png) |\n' },
  { name: 'two images in a row, and a link row', table: '| A | B |\n|---|---|\n| ![[a.png]] | ![[a.png\\|40]] |\n| [[file\\|T]] | x |\n' },
];

async function editTarget(page: Page, suffix: string) {
  const target = page.getByTestId('editor-content').getByText(/^Target paragraph\./);
  await target.click();
  await page.keyboard.press('End');
  await page.keyboard.type(suffix);
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 });
}

test.describe('an image in a table cell stays in its cell (#sv5cwevx)', () => {
  test.beforeEach(() => {
    mkdirSync(path.join(E2E_VAULT, 'attachments'), { recursive: true });
    writeFileSync(path.join(E2E_VAULT, 'attachments', 'a.png'), PNG);
  });

  for (const [index, { name, table }] of shapes.entries()) {
    test(`${name}: edits elsewhere, a reopen and another edit leave the table and add nothing`, async ({ page, vault }) => {
      const title = `Table image ${index}`;
      await vault.seed([{ title, content: `${table}\nTarget paragraph.\n` }]);
      const file = path.join(E2E_VAULT, `${title}.md`);
      const before = body(readFileSync(file, 'utf8'));
      await page.goto(`/#/${encodeURIComponent(title)}`);
      await expect(page.getByTestId('editor-content')).toBeVisible();
      // The image shows inside the table.
      await expect(page.getByTestId('editor-content').locator('td, th').getByTestId('inline-image').first()).toBeVisible();

      await editTarget(page, ' One.');
      await expect.poll(() => body(readFileSync(file, 'utf8'))).toBe(before.replace('Target paragraph.', 'Target paragraph. One.'));

      await page.reload();
      await expect(page.getByTestId('editor-content')).toBeVisible();
      await editTarget(page, ' Two.');
      await expect.poll(() => body(readFileSync(file, 'utf8'))).toBe(before.replace('Target paragraph.', 'Target paragraph. One. Two.'));
      await expect(page.getByTestId('image-block')).toHaveCount(0);
    });
  }

  test('an edit in the row next to a resized embed writes the row back with its escaped pipe', async ({ page, vault }) => {
    const title = 'Table image edit row';
    await vault.seed([{ title, content: '| A | B |\n|---|---|\n| text | ![[a.png\\|300]] |\n\nTarget paragraph.\n' }]);
    const file = path.join(E2E_VAULT, `${title}.md`);
    const before = body(readFileSync(file, 'utf8'));
    await page.goto(`/#/${encodeURIComponent(title)}`);
    const cell = page.getByTestId('editor-content').getByText('text', { exact: true });
    await cell.click();
    await page.keyboard.press('End');
    await page.keyboard.type(' more');
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 });
    await expect
      .poll(() => body(readFileSync(file, 'utf8')))
      .toBe(before.replace('| text |', '| text more |'));
    await expect(page.getByTestId('image-block')).toHaveCount(0);
  });

  test('typing inside the image\'s own cell keeps the image there, with its escaped pipe', async ({ page, vault }) => {
    const title = 'Table image edit cell';
    await vault.seed([{ title, content: '| A | B |\n|---|---|\n| x | ![[a.png\\|300]] |\n\nTarget paragraph.\n' }]);
    const file = path.join(E2E_VAULT, `${title}.md`);
    const before = body(readFileSync(file, 'utf8'));
    await page.goto(`/#/${encodeURIComponent(title)}`);
    const image = page.getByTestId('editor-content').locator('td').getByTestId('inline-image');
    await expect(image).toBeVisible();
    await image.click();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.type('text more ');
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 });
    const expected = before.replace('| x | ![[a.png', '| x | text more ![[a.png');
    await expect.poll(() => body(readFileSync(file, 'utf8'))).toBe(expected);
    await page.reload();
    await expect(page.getByTestId('editor-content').locator('td').getByTestId('inline-image')).toBeVisible();
    await page.getByTestId('editor-content').getByText(/^Target paragraph\./).click();
    await page.keyboard.press('End');
    await page.keyboard.type('!');
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 });
    await expect.poll(() => body(readFileSync(file, 'utf8'))).toBe(expected.replace('Target paragraph.', 'Target paragraph.!'));
    await expect(page.getByTestId('image-block')).toHaveCount(0);
  });
});
