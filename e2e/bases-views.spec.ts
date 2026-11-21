import fs from 'node:fs/promises';
import path from 'node:path';
import type { APIRequestContext, Page } from '@playwright/test';
import { api, expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * v0.7 B (#sg36ng2d, spec/api-bases): Kanban, Cards, List and Calendar, in
 * Obsidian 1.14.4's file shapes. Settings at their default aren't written.
 */

const read = (relative: string) => fs.readFile(path.join(E2E_VAULT, relative), 'utf8');

async function writeVault(request: APIRequestContext, files: Record<string, string>) {
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(E2E_VAULT, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, 'utf8');
  }
  const ids = Object.keys(files).map((file) => file.replace(/\.md$/, ''));
  await expect
    .poll(async () => {
      const listed = new Set((await api.listPages(request)).map((meta) => meta.id));
      return ids.every((id) => listed.has(id));
    }, { timeout: 10_000 })
    .toBe(true);
}

const BASE = `filters:
  and:
    - file.inFolder("Work")
views:
  - type: table
    name: Table
    order:
      - file.name
      - status
  - type: kanban
    name: Board
    groupBy:
      property: status
      direction: ASC
    groupOrder:
      - Todo
      - Doing
      - Done
    order:
      - file.name
      - due
  - type: cards
    name: Gallery
    order:
      - file.name
      - status
    image: note.cover
  - type: list
    name: List
    order:
      - file.name
      - status
      - due
  - type: calendar
    name: Calendar
    order:
      - file.name
    dateProperty: note.due
`;

const today = new Date();
const pad = (n: number) => String(n).padStart(2, '0');
const thisMonth = `${today.getFullYear()}-${pad(today.getMonth() + 1)}`;

const FILES = {
  'Work/Tasks.base': BASE,
  'Work/Alpha.md': `---\nstatus: Todo\ndue: ${thisMonth}-03\ncover: "#2a9d8f"\n---\nA\n`,
  'Work/Beta.md': `---\nstatus: Doing\ndue: ${thisMonth}-10\n---\nB\n`,
  'Work/Gamma.md': `---\nstatus: Done\ndue: ${thisMonth}-10\n---\nC\n`,
  'Work/Delta.md': '---\nstatus: Todo\n---\nD\n',
};

async function open(page: Page, request: APIRequestContext, tab: string) {
  await writeVault(request, FILES);
  await page.goto('/#/Work/Tasks.base');
  await page.getByTestId(`base-tab-${tab}`).click();
}

test.describe('database view layouts (D34)', () => {
  test('Kanban: columns in groupOrder, an empty one included, cards with their properties', async ({ page, request, vault }) => {
    void vault;
    await open(page, request, 'Board');
    const kanban = page.getByTestId('base-kanban');
    await expect(kanban.locator('.base-kanban-title > span:first-child')).toHaveText(['Todo', 'Doing', 'Done']);
    await expect(page.getByTestId('base-column-Todo').locator('.base-title-text')).toHaveText(['Alpha', 'Delta']);
    await expect(page.getByTestId('base-column-Done').locator('.base-title-text')).toHaveText(['Gamma']);
    // As in Obsidian: each property's name, small, above its value.
    const due = page.getByTestId('base-column-Done').getByTestId('base-card-prop-note.due');
    await expect(due.locator('.base-card-prop-name')).toHaveText('due');
    await expect(due.locator('.base-card-prop-value')).not.toBeEmpty();
    expect(await read('Work/Tasks.base')).toBe(BASE);
  });

  test('Kanban without a group asks for one; the Group panel writes groupBy', async ({ page, request, vault }) => {
    void vault;
    await open(page, request, 'Table');
    await page.getByTestId('base-add-view').click();
    await page.getByTestId('base-add-view-kanban').click();
    await expect(page.getByTestId('base-kanban-ungrouped')).toBeVisible();
    await page.getByTestId('base-kanban-pick-group').click();
    await page.getByTestId('base-group-property').selectOption('note.status');
    await expect(page.getByTestId('base-kanban')).toBeVisible();
    await expect.poll(() => read('Work/Tasks.base')).toContain(
      '  - type: kanban\n    name: Board 2\n    order:\n      - file.name\n    groupBy:\n      property: status\n      direction: ASC\n',
    );
  });

  test('Cards: a colour or image cover; size is a setting written only off its default', async ({ page, request, vault }) => {
    void vault;
    await open(page, request, 'Gallery');
    const alpha = page.getByTestId('base-card-Work/Alpha');
    await expect(alpha.locator('.base-card-image')).toHaveCSS('background-color', 'rgb(42, 157, 143)');
    await expect(page.getByTestId('base-card-Work/Beta').locator('.base-card-image')).toHaveCount(0);
    const status = alpha.getByTestId('base-card-prop-note.status');
    await expect(status.locator('.base-card-prop-name')).toHaveText('status');
    await expect(status.locator('.base-card-prop-value')).toHaveText('Todo');

    await page.getByTestId('base-settings-button').click();
    const size = page.getByTestId('base-setting-cardSize');
    await size.fill('300');
    await expect.poll(() => read('Work/Tasks.base')).toContain('    image: note.cover\n    cardSize: 300\n');
    await size.fill('200');
    await expect.poll(() => read('Work/Tasks.base')).toBe(BASE);
  });

  test('List: bullets by default, numbers as a setting', async ({ page, request, vault }) => {
    void vault;
    await open(page, request, 'List');
    await expect(page.getByTestId('base-list')).toHaveJSProperty('tagName', 'UL');
    await expect(page.getByTestId('base-item-Work/Alpha')).toContainText('Todo');
    await page.getByTestId('base-settings-button').click();
    await page.getByTestId('base-setting-markers').selectOption('number');
    await expect(page.getByTestId('base-list')).toHaveJSProperty('tagName', 'OL');
    await expect.poll(() => read('Work/Tasks.base')).toContain('      - due\n    markers: number\n');
    // Indented properties: a bullet with the value only, as in Obsidian.
    await page.getByTestId('base-setting-indentProperties').check();
    const item = page.getByTestId('base-item-Work/Alpha');
    await expect(item.getByTestId('base-list-prop-note.status')).toHaveText('Todo');
    await expect(item.locator('.base-list-props')).not.toContainText('status');
  });

  test('Calendar: pages on their day, two on one day, month navigation; undated ones counted', async ({ page, request, vault }) => {
    void vault;
    await open(page, request, 'Calendar');
    await expect(page.getByTestId(`base-day-${thisMonth}-03`).locator('.base-calendar-item')).toHaveText(['Alpha']);
    await expect(page.getByTestId(`base-day-${thisMonth}-10`).locator('.base-calendar-item')).toHaveText(['Beta', 'Gamma']);
    await expect(page.getByText('1 page has no date')).toBeVisible();
    const month = page.getByTestId('base-calendar-month');
    const shown = await month.textContent();
    await page.getByTestId('base-calendar-next').click();
    await expect(month).not.toHaveText(shown!);
    await expect(page.getByTestId(`base-day-${thisMonth}-03`)).toHaveCount(0);
    await page.getByTestId('base-calendar-today').click();
    await expect(month).toHaveText(shown!);
    // A Calendar view added later goes last, never first (Obsidian opens a base on its first view).
    await page.getByTestId('base-add-view').click();
    await page.getByTestId('base-add-view-calendar').click();
    await expect
      .poll(() => read('Work/Tasks.base'))
      .toBe(`${BASE}  - type: calendar\n    name: Calendar 2\n    order:\n      - file.name\n    dateProperty: note.due\n`);
  });

  test('"Embed existing database…" lists database views only, then embeds the picked one live', async ({ page, request, vault }) => {
    void vault;
    await writeVault(request, { ...FILES, 'Host.md': 'Host page\n' });
    await page.goto('/#/Host');
    await page.getByTestId('editor-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('/embed');
    await page.getByTestId('slash-menu-item-embed-database').click();
    const menu = page.getByTestId('link-menu');
    await expect(menu.getByRole('option')).toHaveCount(1);
    await expect(page.getByTestId('link-suggestion-Work/Tasks.base')).toBeVisible();
    await page.getByTestId('link-suggestion-Work/Tasks.base').click();
    await expect(page.getByTestId('base-embed').locator('.base-title-text').first()).toBeVisible();
    await expect.poll(async () => (await api.getPage(request, 'Host')).content, { timeout: 8_000 }).toBe('Host page\n\n![[Tasks.base]]');

    // A plain `![[` still offers pages too (page previews, #5dpxwac4).
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('![[');
    await expect(page.getByTestId('link-suggestion-Work/Alpha')).toBeVisible();
  });

  test('Kanban: dragging a card to another column writes only that page\'s status line', async ({ page, request, vault }) => {
    void vault;
    await open(page, request, 'Board');
    const card = page.getByTestId('base-column-Todo').locator('.base-kanban-card').filter({ hasText: 'Alpha' });
    await card.dragTo(page.getByTestId('base-column-Done'));
    await expect(page.getByTestId('base-column-Done').locator('.base-title-text')).toHaveText(['Alpha', 'Gamma']);
    await expect.poll(() => read('Work/Alpha.md')).toBe(FILES['Work/Alpha.md'].replace('status: Todo', 'status: Done'));
    // The base file is untouched; Obsidian reads the same column.
    expect(await read('Work/Tasks.base')).toBe(BASE);

    // + New in a column: a page with that column's value.
    await page.getByTestId('base-new-in-Doing').click();
    await expect(page.getByTestId('page-title-input').or(page.getByTestId('page-title'))).toBeVisible();
    await expect
      .poll(async () => (await api.listPages(request)).filter((meta) => meta.parentId === 'Work' && meta.title === 'Untitled').length)
      .toBe(1);
    await expect.poll(() => read('Work/Untitled.md')).toContain('status: Doing\n');
  });

  test('Calendar: dragging a page to another day writes its date; + on a day makes a page dated that day', async ({ page, request, vault }) => {
    void vault;
    await open(page, request, 'Calendar');
    await page.getByTestId('base-event-Work/Alpha').dragTo(page.getByTestId(`base-day-${thisMonth}-12`));
    await expect(page.getByTestId(`base-day-${thisMonth}-12`).locator('.base-calendar-item')).toHaveText(['Alpha']);
    await expect.poll(() => read('Work/Alpha.md')).toBe(FILES['Work/Alpha.md'].replace(`due: ${thisMonth}-03`, `due: ${thisMonth}-12`));
    expect(await read('Work/Tasks.base')).toBe(BASE);

    await page.getByTestId(`base-day-${thisMonth}-20`).hover();
    await page.getByTestId(`base-new-on-${thisMonth}-20`).click();
    await expect.poll(() => read('Work/Untitled.md').catch(() => '')).toContain(`due: ${thisMonth}-20\n`);
  });

  test('loading the app requests nothing that 404s (the favicon is served)', async ({ page, request, vault }) => {
    void vault;
    const missing: string[] = [];
    page.on('response', (response) => {
      if (response.status() === 404) missing.push(response.url());
    });
    await open(page, request, 'Table');
    await expect(page.getByTestId('base-table')).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(missing).toEqual([]);
    expect((await page.request.get('/favicon.svg')).headers()['content-type']).toContain('image/svg+xml');
  });
});
