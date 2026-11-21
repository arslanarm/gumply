import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { api, expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/** v0.7 C (#5hrsrqsj): page templates and daily notes, Obsidian-compatible. */

async function writeVault(files: Record<string, string>) {
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(E2E_VAULT, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, 'utf8');
  }
}

const read = (relative: string) => fs.readFile(path.join(E2E_VAULT, relative), 'utf8');
const exists = (relative: string) =>
  fs.access(path.join(E2E_VAULT, relative)).then(
    () => true,
    () => false,
  );

const pad = (value: number) => String(value).padStart(2, '0');
const ymd = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

const MEETING = '---\nstatus: draft\ncreated: {{date}}\n---\n\n# {{title}}\n\n- [ ] Agenda\n';

async function withTemplate(request: Parameters<typeof api.listPages>[0]) {
  await writeVault({ 'Templates/Meeting.md': MEETING, 'Inbox.md': 'Start' });
  await expect.poll(async () => (await api.listPages(request)).map((meta) => meta.id)).toContain('Templates/Meeting');
}

async function openSearch(page: Page) {
  await expect(page.getByTestId('editor-content')).toBeVisible();
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('quick-switcher-input')).toBeFocused();
}

test.describe('page templates (v0.7 C)', () => {
  test('Cmd+K → New page from template: properties copied, variables filled, title selected to rename', async ({ page, request, vault }) => {
    void vault;
    await withTemplate(request);
    await page.goto('/#/Inbox');
    await openSearch(page);
    await page.getByTestId('quick-switcher-input').fill('template');
    // Both commands are offered (the page and the board template), ranked
    // above "Create “template”" because the query names them.
    await expect(page.getByTestId('search-from-template')).toBeVisible();
    const order = await page
      .getByTestId('quick-switcher')
      .getByRole('option')
      .evaluateAll((options) => options.map((option) => option.getAttribute('data-testid')));
    expect(order.indexOf('search-page-template')).toBeLessThan(order.indexOf('search-create'));
    expect(order.indexOf('search-from-template')).toBeLessThan(order.indexOf('search-create'));
    await page.getByTestId('search-page-template').click();
    const picker = page.getByTestId('template-picker');
    await expect(picker.getByRole('option')).toHaveText(['Meeting']);
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL(/#\/Meeting$/);
    await expect(page.getByTestId('editor-content')).toContainText('Agenda');
    await expect(page.getByTestId('editor-content').locator('h1')).toHaveText('Meeting');
    const text = await read('Meeting.md');
    expect(text).toMatch(new RegExp(`^---\\nstatus: draft\\ncreated: ${ymd(new Date())}\\n`));
    expect(text).toContain('title: Meeting');
    // The title is selected: typing renames it (D20 renames the file).
    await page.keyboard.type('Weekly sync');
    await page.keyboard.press('Enter');
    await expect.poll(() => exists('Weekly sync.md')).toBe(true);
  });

  test('⋯ on a folder → New page from template makes it inside', async ({ page, request, vault }) => {
    void vault;
    await withTemplate(request);
    await writeVault({ 'Work/Plan.md': 'Plan' });
    await expect.poll(async () => (await api.listPages(request)).map((meta) => meta.id)).toContain('Work/Plan');
    await page.goto('/#/Inbox');
    await page.getByTestId('page-item-Work').hover();
    await page.getByTestId('page-menu-button-Work').click();
    await page.getByTestId('new-from-template-Work').click();
    await page.getByTestId('template-option-Templates/Meeting').click();
    await expect(page).toHaveURL(/#\/Work\/Meeting$/);
    expect(await exists('Work/Meeting.md')).toBe(true);
  });

  test('/template fills an empty page (body and properties) and inserts at the caret in a page with text', async ({ page, request, vault }) => {
    void vault;
    await withTemplate(request);
    await writeVault({ 'Empty.md': '---\nstatus: final\n---\n' });
    await expect.poll(async () => (await api.listPages(request)).map((meta) => meta.id)).toContain('Empty');
    await page.goto('/#/Empty');
    await page.getByTestId('editor-content').click();
    await page.keyboard.type('/template');
    await expect(page.getByTestId('slash-menu-item-page-template')).toBeVisible();
    await expect(page.getByTestId('slash-menu-item-board-template')).toBeVisible();
    await page.getByTestId('slash-menu-item-page-template').click();
    await page.getByTestId('template-option-Templates/Meeting').click();
    await expect(page.getByTestId('editor-content')).toContainText('Agenda');
    const filled = await read('Empty.md');
    // The page's own key wins; the template's missing ones are added.
    expect(filled).toMatch(/^---\nstatus: final\ncreated: \d{4}-\d{2}-\d{2}\n---/);
    expect(filled).toMatch(/# Empty\n\n- \[ \] Agenda\n$/);

    await page.goto('/#/Inbox');
    const body = page.getByTestId('editor-content');
    await body.getByText('Start', { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('/template');
    await page.getByTestId('slash-menu-item-page-template').click();
    await page.getByTestId('template-option-Templates/Meeting').click();
    await expect(body).toContainText('Agenda');
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 });
    // Inbox.md had no final newline, and keeps it that way (#5fv7c25w).
    await expect.poll(() => read('Inbox.md')).toBe('Start\n\n# Inbox\n\n- [ ] Agenda');
  });

  test('no templates yet: the picker says where to put them', async ({ page, vault }) => {
    await vault.seed([{ title: 'Alone', content: 'x' }]);
    await page.goto('/#/Alone');
    await openSearch(page);
    await page.getByTestId('quick-switcher-input').fill('new page from template');
    await page.getByTestId('search-page-template').click();
    await expect(page.getByTestId('template-empty')).toContainText('“Templates” folder');
  });
});

test.describe('daily notes (v0.7 C)', () => {
  test('Today makes the note once and opens the same note again; ‹ › go to existing notes only', async ({ page, request, vault }) => {
    void vault;
    const today = new Date();
    const id = `Daily/${ymd(today)}`;
    await writeVault({ 'Daily/2020-01-01.md': 'Long ago', 'Daily/2020-01-05.md': 'Later', 'Inbox.md': 'Start' });
    await expect.poll(async () => (await api.listPages(request)).map((meta) => meta.id)).toContain('Daily/2020-01-05');
    await page.goto('/#/Inbox');

    await page.getByTestId('sidebar-today').click();
    await expect(page).toHaveURL(new RegExp(`#/Daily/${ymd(today)}$`));
    expect(await read(`${id}.md`)).toBe('');
    const made = (await fs.stat(path.join(E2E_VAULT, `${id}.md`))).mtimeMs;

    await page.goto('/#/Inbox');
    await page.getByTestId('sidebar-today').click();
    await expect(page).toHaveURL(new RegExp(`#/Daily/${ymd(today)}$`));
    expect((await fs.stat(path.join(E2E_VAULT, `${id}.md`))).mtimeMs).toBe(made);

    // ‹ goes to the nearest existing earlier note; › is disabled on the last one.
    await expect(page.getByTestId('daily-next')).toBeDisabled();
    await page.getByTestId('daily-previous').click();
    await expect(page).toHaveURL(/#\/Daily\/2020-01-05$/);
    await page.getByTestId('daily-previous').click();
    await expect(page).toHaveURL(/#\/Daily\/2020-01-01$/);
    await expect(page.getByTestId('daily-previous')).toBeDisabled();
    await page.getByTestId('daily-next').click();
    await expect(page).toHaveURL(/#\/Daily\/2020-01-05$/);
    // Browsing created nothing new.
    expect((await fs.readdir(path.join(E2E_VAULT, 'Daily'))).sort()).toEqual(['2020-01-01.md', '2020-01-05.md', `${ymd(today)}.md`]);
    // Other pages have no ‹ ›.
    await page.goto('/#/Inbox');
    await expect(page.getByTestId('daily-nav')).toHaveCount(0);
  });

  test('Cmd+K "today" opens today\'s note, following Obsidian\'s daily-notes settings', async ({ page, request, vault }) => {
    void vault;
    await writeVault({
      '.obsidian/daily-notes.json': JSON.stringify({ folder: 'Journal', format: 'YYYY-MM-DD', template: 'Templates/Day' }),
      'Templates/Day.md': '# {{title}}\n\n## Notes\n',
      'Inbox.md': 'Start',
    });
    try {
      await expect.poll(async () => (await api.listPages(request)).map((meta) => meta.id)).toContain('Templates/Day');
      await page.goto('/#/Inbox');
      await openSearch(page);
      await page.getByTestId('quick-switcher-input').fill('today');
      await page.getByTestId('search-today').click();
      const day = ymd(new Date());
      await expect(page).toHaveURL(new RegExp(`#/Journal/${day}$`));
      expect(await read(`Journal/${day}.md`)).toBe(`# ${day}\n\n## Notes\n`);
    } finally {
      // Other tests expect the default settings.
      await fs.rm(path.join(E2E_VAULT, '.obsidian'), { recursive: true, force: true });
    }
  });
});
