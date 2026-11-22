import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * v0.8 D1 (#bwibdggm, spec/outline): the Outline | Local graph column. The
 * outline lists the page's top-level headings (a board's frames), jumps to
 * them, follows the reading position, and never writes to the file.
 */
const filler = (n: number) => Array.from({ length: n }, (_, i) => `Paragraph ${i + 1} of filler text that takes up a line or two of the page.`).join('\n\n');
const DOC = [
  '# Intro',
  '',
  filler(12),
  '',
  '## Details',
  '',
  filler(12),
  '',
  '### Deep',
  '',
  filler(12),
  '',
  '> ## In a quote',
  '',
  '- item',
  '  ## In a list',
  '',
  '#',
  '',
  '# Ending',
  '',
  filler(30),
  '',
].join('\n');

const file = (name: string) => path.join(E2E_VAULT, name);

async function openDoc(page: Page) {
  writeFileSync(file('Doc.md'), DOC);
  await page.goto('/#/Doc');
  await expect(page.getByTestId('editor-content')).toContainText('Paragraph 1 of filler');
}

const items = (page: Page) => page.getByTestId('outline-item');

test.describe('outline pane (v0.8 D1)', () => {
  test('closed by default; the header button opens it on Outline; the choice survives a reload', async ({ page, vault }) => {
    await vault.seed([{ title: 'Anchor' }]);
    await openDoc(page);
    await expect(page.getByTestId('right-panel')).toHaveCount(0);
    await page.getByTestId('outline-toggle').click();
    await expect(page.getByTestId('right-panel-tab-outline')).toHaveAttribute('aria-selected', 'true');
    // Top-level headings only; an empty one shows a placeholder; H2 → H3 nests, skipped levels indent one step.
    await expect(items(page)).toHaveText(['Intro', 'Details', 'Deep', '(empty heading)', 'Ending']);
    await expect(items(page).nth(2)).toHaveAttribute('aria-level', '3');
    await expect(items(page).nth(3)).toHaveAttribute('aria-label', 'Empty heading, level 1');
    await page.reload();
    await expect(page.getByTestId('right-panel-tab-outline')).toHaveAttribute('aria-selected', 'true');
    // The Local graph tab still works, and the header button opens it.
    await page.getByTestId('local-graph-toggle').click();
    await expect(page.getByTestId('right-panel-tab-graph')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('local-graph')).toBeVisible();
    await page.getByTestId('right-panel-close').click();
    await expect(page.getByTestId('right-panel')).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('editor-content')).toContainText('Paragraph 1 of filler');
    await expect(page.getByTestId('right-panel')).toHaveCount(0);
    expect(readFileSync(file('Doc.md'), 'utf8')).toBe(DOC);
  });

  test('a click jumps to the heading with the caret in it; scrolling moves the highlight; the file is untouched', async ({ page, vault }) => {
    await vault.seed([{ title: 'Anchor' }]);
    await openDoc(page);
    await page.getByTestId('outline-toggle').click();
    await expect(items(page).first()).toHaveAttribute('aria-current', 'location');
    await items(page).filter({ hasText: 'Ending' }).click();
    const heading = page.getByTestId('editor-content').locator('h1', { hasText: 'Ending' });
    await expect
      .poll(async () => {
        const [box, content] = [await heading.boundingBox(), await page.locator('.content').boundingBox()];
        return box && content ? Math.round(box.y - content.y) : null;
      })
      .toBeLessThan(60);
    await expect(items(page).filter({ hasText: 'Ending' })).toHaveAttribute('aria-current', 'location');
    // The caret sits at the end of that heading.
    const caret = await page.evaluate(() => {
      const selection = window.getSelection();
      return selection?.anchorNode?.parentElement?.closest('h1')?.textContent ?? null;
    });
    expect(caret).toBe('Ending');
    // Scrolling back up moves the highlight.
    await page.locator('.content').evaluate((element) => element.scrollTo({ top: 0 }));
    await expect(items(page).filter({ hasText: 'Intro' })).toHaveAttribute('aria-current', 'location');
    expect(readFileSync(file('Doc.md'), 'utf8')).toBe(DOC);
  });

  test('typing a heading adds it live; collapse and expand; keyboard tree', async ({ page, vault }) => {
    await vault.seed([{ title: 'Anchor' }]);
    await openDoc(page);
    await page.getByTestId('outline-toggle').click();
    await expect(items(page)).toHaveCount(5);

    // Collapse "Details": "Deep" hides; Expand all brings it back.
    await items(page).filter({ hasText: 'Details' }).getByTestId('outline-twisty').click();
    await expect(items(page)).toHaveText(['Intro', 'Details', '(empty heading)', 'Ending']);
    await expect(items(page).filter({ hasText: 'Details' })).toHaveAttribute('aria-expanded', 'false');
    await page.getByTestId('outline-expand-all').click();
    await expect(items(page)).toHaveCount(5);
    await page.getByTestId('outline-collapse-all').click();
    await expect(items(page)).toHaveText(['Intro', '(empty heading)', 'Ending']);
    await page.getByTestId('outline-expand-all').click();

    // Keyboard: ↓ moves, ← / → collapse and expand, Enter jumps, Esc returns to the editor.
    await items(page).first().focus();
    await page.keyboard.press('ArrowDown');
    await expect(items(page).nth(1)).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(items(page)).toHaveCount(4);
    await page.keyboard.press('ArrowRight');
    await expect(items(page)).toHaveCount(5);
    await page.keyboard.press('ArrowRight');
    await expect(items(page).nth(2)).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(items(page).nth(1)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(items(page).nth(1)).toHaveAttribute('aria-current', 'location');
    await items(page).nth(1).focus();
    await page.keyboard.press('Escape');
    await expect(page.locator('.ProseMirror')).toBeFocused();
    expect(readFileSync(file('Doc.md'), 'utf8')).toBe(DOC);

    // A new heading shows up while typing.
    await page.getByTestId('editor-content').getByText('Paragraph 1 of filler', { exact: false }).first().click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('## Fresh');
    await expect(items(page)).toHaveText(['Intro', 'Fresh', 'Details', 'Deep', '(empty heading)', 'Ending']);
  });

  test('Cmd+K "Toggle outline"; an old session with the local graph open opens on Graph', async ({ page, vault }) => {
    await vault.seed([{ title: 'Anchor' }]);
    await openDoc(page);
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.press(`${modifier}+K`);
    await page.keyboard.type('outline');
    await page.getByTestId('search-outline').click();
    await expect(page.getByTestId('right-panel-tab-outline')).toHaveAttribute('aria-selected', 'true');
    await page.getByTestId('right-panel-close').click();

    await page.evaluate(() => {
      window.localStorage.removeItem('gumply:right-panel');
      window.sessionStorage.setItem('gumply:local-graph', 'open');
    });
    await page.reload();
    await expect(page.getByTestId('right-panel-tab-graph')).toHaveAttribute('aria-selected', 'true');
    expect(await page.evaluate(() => window.sessionStorage.getItem('gumply:local-graph'))).toBeNull();
    // Carried over once: closed now, it stays closed (the old key is gone).
    await page.getByTestId('right-panel-close').click();
    await page.reload();
    await expect(page.getByTestId('editor-content')).toContainText('Paragraph 1 of filler');
    await expect(page.getByTestId('right-panel')).toHaveCount(0);
  });

  test('a board lists its frames in reading order; a click zooms to the frame', async ({ page, request, vault }) => {
    await vault.seed([{ title: 'Anchor' }]);
    const frame = (id: string, label: string, x: number, y: number) => ({ id, type: 'group', label, x, y, width: 400, height: 300 });
    writeFileSync(
      file('Plan.canvas'),
      JSON.stringify({ nodes: [frame('c', 'Third', 0, 900), frame('b', 'Second', 3000, 20), frame('a', 'First', 0, 0)], edges: [] }, null, '\t'),
    );
    const before = readFileSync(file('Plan.canvas'), 'utf8');
    await waitForBoard(request, 'Plan.canvas');
    await page.goto('/#/Plan.canvas');
    await expect(page.getByTestId('board')).toBeVisible();
    await page.getByTestId('outline-toggle').click();
    await expect(items(page)).toHaveText(['First', 'Second', 'Third']);
    const zoom = async () => page.locator('.react-flow__viewport').evaluate((element) => getComputedStyle(element).transform);
    const start = await zoom();
    await items(page).filter({ hasText: 'Second' }).click();
    await expect.poll(zoom).not.toBe(start);
    // The frame is on screen.
    const box = await page.locator('[data-id="b"]').boundingBox();
    const view = await page.getByTestId('board').boundingBox();
    expect(box && view && box.x >= view.x - 2 && box.x + box.width <= view.x + view.width + 2).toBe(true);
    expect(readFileSync(file('Plan.canvas'), 'utf8')).toBe(before);
  });
});

async function waitForBoard(request: APIRequestContext, id: string) {
  await expect.poll(async () => (await request.get(`/api/boards/${encodeURIComponent(id)}`)).status()).toBe(200);
}
