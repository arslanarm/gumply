import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * v0.8 F1 (#qx3w5qew): math rendered with KaTeX over the raw `$…$` / `$$…$$`
 * atoms. Render, edit as source, Esc back, and the file stays byte-exact;
 * /math and /equation; previews and stickies; no network outside the app.
 */

const file = (name: string) => path.join(E2E_VAULT, name);
/** A note's body on disk, after its frontmatter: the exact bytes. */
const body = async (name: string) => (await readFile(file(name), 'utf8')).replace(/^---\n[\s\S]*?\n---\n\n?/, '');

const SOURCE = 'Euler: $e^{i\\pi}+1=0$ here.\n\n$$\n\\frac{a}{b}\n$$\n\nPrice $5 and $10.\n';

async function open(page: Page, title: string) {
  await page.goto(`/#/${encodeURIComponent(title)}`);
  await expect(page.getByTestId('editor-content')).toBeVisible();
}

test.afterEach(async () => {
  await rm(file('F1 Board.canvas'), { force: true });
});

test('math renders, edits as source, Esc goes back, and the file stays byte-exact', async ({ page, vault }) => {
  const outside: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!['localhost', '127.0.0.1'].includes(url.hostname) && url.protocol !== 'data:') outside.push(request.url());
  });
  await vault.seed([{ title: 'Formulas', content: SOURCE }]);
  const original = await body('Formulas.md');
  await open(page, 'Formulas');
  const editor = page.getByTestId('editor-content');

  const block = editor.locator('.raw-block-math');
  const inline = editor.locator('.raw-inline-math');
  await expect(block.locator('.katex')).toBeVisible();
  await expect(inline.locator('.katex')).toBeVisible();
  // Prices stay text.
  await expect(editor).toContainText('Price $5 and $10.');

  // Block: click shows the source; Esc goes back unchanged.
  await block.click();
  const area = page.getByTestId('raw-block-editor');
  await expect(area).toHaveValue('$$\n\\frac{a}{b}\n$$');
  await area.press('Escape');
  await expect(block.locator('.katex')).toBeVisible();
  // Inline: click shows the source; Esc goes back unchanged.
  await inline.click();
  await expect(page.getByTestId('math-inline-editor')).toHaveValue('$e^{i\\pi}+1=0$');
  await page.getByTestId('math-inline-editor').press('Escape');
  await expect(inline.locator('.katex')).toBeVisible();
  await page.waitForTimeout(800);
  expect(await body('Formulas.md')).toBe(original);

  // Edits: the block on blur, the inline on Enter; only those bytes change.
  await block.click();
  await area.fill('$$\n\\frac{a}{c}\n$$');
  await editor.getByText('Price').click();
  await expect(block.locator('.katex')).toBeVisible();
  await inline.click();
  await page.getByTestId('math-inline-editor').fill('$x^2$');
  await page.getByTestId('math-inline-editor').press('Enter');
  await expect(inline.locator('.katex')).toBeVisible();
  await expect.poll(() => body('Formulas.md'), { timeout: 5_000 }).toBe(
    original.replace('\\frac{a}{b}', '\\frac{a}{c}').replace('$e^{i\\pi}+1=0$', '$x^2$'),
  );

  // Bad TeX shows inline, the page keeps working.
  await inline.click();
  await page.getByTestId('math-inline-editor').fill('$\\frac{a}{$');
  await page.getByTestId('math-inline-editor').press('Enter');
  await expect(inline.locator('.math-error')).toHaveText('\\frac{a}{');
  expect(outside).toEqual([]);
});

test('/math and /equation insert math opened as source', async ({ page, vault }) => {
  await vault.seed([{ title: 'Slash math', content: 'Start.' }]);
  await open(page, 'Slash math');
  const editor = page.getByTestId('editor-content');
  await editor.getByText('Start.').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/math');
  await page.getByTestId('slash-menu-item-math').click();
  const area = page.getByTestId('raw-block-editor');
  await expect(area).toBeFocused();
  await area.fill('$$\n\\sqrt{2}\n$$');
  await area.press('Control+Enter');
  await expect(editor.locator('.raw-block-math .katex')).toBeVisible();

  await editor.getByText('Start.').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Then /equation');
  await page.getByTestId('slash-menu-item-equation').click();
  const input = page.getByTestId('math-inline-editor');
  await expect(input).toBeFocused();
  await page.keyboard.type('y^2');
  await input.press('Enter');
  await expect(editor.locator('.raw-inline-math .katex')).toBeVisible();
  await expect.poll(() => body('Slash math.md'), { timeout: 5_000 }).toBe('Start. Then $y^2$\n\n$$\n\\sqrt{2}\n$$\n');
});

test('page previews and board stickies render math too', async ({ page, vault }) => {
  await vault.seed([
    { title: 'Formulas', content: SOURCE },
    { title: 'Host', content: '![[Formulas]]' },
  ]);
  await open(page, 'Host');
  const preview = page.getByTestId('editor-content').locator('.page-embed-body');
  await expect(preview.locator('.math-block .katex')).toBeVisible();
  await expect(preview.locator('.math-inline .katex')).toBeVisible();
  await expect(preview).toContainText('Price $5 and $10.');

  await writeFile(
    file('F1 Board.canvas'),
    JSON.stringify({ nodes: [{ id: 's', type: 'text', text: 'Area: $\\pi r^2$', x: 0, y: 0, width: 240, height: 160, gumply: { kind: 'sticky' } }], edges: [] }),
  );
  await expect.poll(async () => (await vault.pages()).some((meta) => meta.id === 'F1 Board.canvas'), { timeout: 5_000 }).toBe(true);
  await page.goto(`/#/${encodeURIComponent('F1 Board.canvas')}`);
  await expect(page.getByTestId('board-rich-text').locator('.katex')).toBeVisible();
});
