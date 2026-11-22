import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { api, expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * #hwrv5hvk (a11y): a `data-tooltip` is drawn with CSS `::after`, and Chrome
 * reads generated content into an element's accessible name. So a button with
 * visible text was announced as its text plus its tooltip. The tooltip's
 * `content` now carries empty alt text (`attr(data-tooltip) / ""`).
 *
 * The rule checked on every visible `[data-tooltip]` of the main screens: its
 * accessible name is its `aria-label` when it has one, else exactly its own
 * visible text, and never empty (an icon-only button names itself with
 * `aria-label`). A name with the tooltip appended fails.
 */

async function expectTooltipNames(page: Page, where: string) {
  const elements = page.locator('[data-tooltip]:visible');
  const count = await elements.count();
  expect(count, `${where}: no tooltips found`).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) {
    const element = elements.nth(index);
    const { label, text, tooltip } = await element.evaluate((node) => ({
      label: node.getAttribute('aria-label'),
      text: (node.textContent ?? '').replace(/\s+/g, ' ').trim(),
      tooltip: node.getAttribute('data-tooltip') ?? '',
    }));
    const expected = label ?? text;
    expect(expected, `${where}: [data-tooltip="${tooltip}"] has no name (icon-only without aria-label)`).not.toBe('');
    await expect(element, `${where}: [data-tooltip="${tooltip}"]`).toHaveAccessibleName(expected);
  }
}

for (const language of ['en', 'ru'] as const) {
  test(`every visible tooltip stays out of its element's accessible name (${language})`, async ({ page, request, vault }) => {
    void vault;
    test.setTimeout(90_000);
    await page.addInitScript((lang) => window.localStorage.setItem('gumply:language', lang), language);
    await fs.writeFile(path.join(E2E_VAULT, 'Notes.md'), '---\ntags: five, six\n---\n\nSome text to select.\n');
    const board = await request.post('/api/boards', { data: { title: 'Map' } });
    expect(board.status()).toBe(201);
    const boardId = ((await board.json()) as { meta: { id: string } }).meta.id;
    await expect.poll(async () => (await api.listPages(request)).map((meta) => meta.id)).toContain('Notes');

    // The page: top bar, sidebar, header, properties (the tags flag and its fix button).
    await page.goto('/#/Notes');
    const body = page.getByTestId('editor-content');
    await expect(body).toContainText('Some text to select.');
    await expect(page.getByTestId('property-issue-tags-string')).toBeVisible();
    await expectTooltipNames(page, 'page');

    // The selection toolbar: Turn into shows the block's name; the mark buttons are icon-only.
    await body.getByText('Some text to select.').selectText();
    await expect(page.getByTestId('selection-turn-into')).toBeVisible();
    await expectTooltipNames(page, 'selection toolbar');
    await expect(page.getByTestId('selection-turn-into')).toHaveAccessibleName(language === 'en' ? 'Turn into: Text' : 'Превратить в: Текст');
    await page.keyboard.press('Escape');

    // Settings and the AI apps dialog.
    await page.getByTestId('settings-button').click();
    await expect(page.getByTestId('settings-popover')).toBeVisible();
    await expectTooltipNames(page, 'settings');
    await page.getByTestId('settings-mcp').click();
    await expect(page.getByTestId('mcp-settings')).toBeVisible();
    await expect(page.getByTestId('mcp-loading')).toHaveCount(0);
    await expectTooltipNames(page, 'AI apps dialog');
    await page.getByTestId('mcp-close').click();

    // Export and Import from Notion, from the page's ⋯ menu.
    if (!(await page.getByTestId('page-item-Notes').isVisible())) await page.getByTestId('sidebar-toggle').click();
    await page.getByTestId('page-item-Notes').hover();
    await expectTooltipNames(page, 'sidebar row');
    await page.getByTestId('page-menu-button-Notes').click();
    await page.getByTestId('export-html-Notes').click();
    await expect(page.getByTestId('export-dialog')).toBeVisible();
    await expectTooltipNames(page, 'export dialog');
    await page.getByTestId('export-cancel').click();

    // A board: its toolbar is icon buttons with tooltips.
    await page.goto(`/#/${encodeURIComponent(boardId)}`);
    await expect(page.locator('[data-testid^="board-tool-"]').first()).toBeVisible();
    await expectTooltipNames(page, 'board');
  });
}
