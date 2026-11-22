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
    // #2su9ikg4: a card without a cover gets an empty one of the same size, so the titles line up.
    const beta = page.getByTestId('base-card-Work/Beta');
    await expect(beta.getByTestId('base-card-image-empty')).toBeVisible();
    const box = async (locator: import('@playwright/test').Locator) => (await locator.boundingBox())!;
    expect((await box(beta.getByTestId('base-card-image-empty'))).height).toBeCloseTo((await box(alpha.getByTestId('base-card-image'))).height, 0);
    expect((await box(beta.locator('.base-title-text'))).y).toBeCloseTo((await box(alpha.locator('.base-title-text'))).y, 0);
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

  test('Cards: a view without `image` draws no cover boxes', async ({ page, request, vault }) => {
    void vault;
    await writeVault(request, { ...FILES, 'Work/Tasks.base': BASE.replace('    image: note.cover\n', '') });
    await page.goto('/#/Work/Tasks.base');
    await page.getByTestId('base-tab-Gallery').click();
    await expect(page.getByTestId('base-card-Work/Beta')).toBeVisible();
    // Alpha has a cover value, but the view doesn't show covers.
    await expect(page.locator('.base-card-image')).toHaveCount(0);
  });

  test('Cards: with `image` set and no cover anywhere, every card gets a 1:1 empty box; a long title is one line with an ellipsis', async ({ page, request, vault }) => {
    void vault;
    // As Obsidian 1.14.4 draws it (#2su9ikg4): boxes follow the view's `image` key, not whether any card has a cover.
    const long = 'A rather long page title that cannot possibly fit on one line of a card';
    await writeVault(request, {
      'Work/Tasks.base': BASE,
      'Work/Alpha.md': '---\nstatus: Todo\n---\nA\n',
      'Work/Beta.md': '---\nstatus: Doing\n---\nB\n',
      [`Work/${long}.md`]: '---\nstatus: Doing\n---\nL\n',
    });
    await page.goto('/#/Work/Tasks.base');
    await page.getByTestId('base-tab-Gallery').click();
    const beta = page.getByTestId('base-card-Work/Beta');
    const card = page.getByTestId(`base-card-Work/${long}`);
    await expect(beta).toBeVisible();
    await expect(page.getByTestId('base-card-image')).toHaveCount(0);
    for (const one of [beta, card]) {
      const empty = (await one.getByTestId('base-card-image-empty').boundingBox())!;
      expect(Math.abs(empty.width - empty.height)).toBeLessThanOrEqual(1);
    }
    const title = card.locator('.base-title-text');
    const betaTitle = beta.locator('.base-title-text');
    // One line, cut with an ellipsis, left-aligned; the card is as tall as its neighbour.
    expect(Math.abs((await title.boundingBox())!.height - (await betaTitle.boundingBox())!.height)).toBeLessThanOrEqual(1);
    expect(await title.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    await expect(title).toHaveCSS('text-overflow', 'ellipsis');
    await expect(card.locator('.base-title-link')).toHaveCSS('text-align', 'left');
    // The full title is the app's tooltip, only while it's cut off (#2su9ikg4 follow-up).
    await card.locator('.base-title-link').hover();
    await expect(card.locator('.base-title-link')).toHaveAttribute('data-tooltip', long);
    await beta.locator('.base-title-link').hover();
    await expect(beta.locator('.base-title-link')).not.toHaveAttribute('data-tooltip');
    expect(Math.abs((await card.boundingBox())!.height - (await beta.boundingBox())!.height)).toBeLessThanOrEqual(1);
    expect((await title.boundingBox())!.y).toBeCloseTo((await betaTitle.boundingBox())!.y, 0);
  });

  test('Properties panel: Shown (in view order), then Hidden; a click moves a property and writes order as before', async ({ page, request, vault }) => {
    void vault;
    await open(page, request, 'Gallery');
    await page.getByTestId('base-properties-button').click();
    const shown = page.getByTestId('base-properties-shown');
    const hidden = page.getByTestId('base-properties-hidden');
    await expect(shown.locator('.base-check span')).toHaveText(['Name', 'status']);
    await expect(shown.locator('.base-panel-title')).toHaveText(/shown/i);
    await expect(hidden.locator('.base-panel-title')).toHaveText(/hidden/i);
    await expect(hidden.getByTestId('base-property-note.due')).not.toBeChecked();
    // The app's own checkbox, not the browser's.
    await expect(shown.getByTestId('base-property-note.status')).toHaveCSS('appearance', 'none');
    // The search field keeps its full height.
    expect((await page.getByTestId('base-properties-panel').locator('input.base-input').boundingBox())!.height).toBeGreaterThanOrEqual(27);

    // It moves to the other section (so click, not check()).
    await hidden.getByTestId('base-property-note.due').click();
    await expect(shown.locator('.base-check span')).toHaveText(['Name', 'status', 'due']);
    await expect(shown.getByTestId('base-property-note.due')).toBeChecked();
    await expect.poll(() => read('Work/Tasks.base')).toContain('  - type: cards\n    name: Gallery\n    order:\n      - file.name\n      - status\n      - due\n');
    await shown.getByTestId('base-property-note.due').click();
    await expect(hidden.getByTestId('base-property-note.due')).not.toBeChecked();
    await expect.poll(() => read('Work/Tasks.base')).toBe(BASE);
  });

  test('toolbar panels open under their button: right edges line up when the panel would run past the window', async ({ page, request, vault }) => {
    void vault;
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(page, request, 'Gallery');
    for (const panel of ['properties', 'settings', 'sort', 'source']) {
      const button = (await page.getByTestId(`base-${panel}-button`).boundingBox())!;
      await page.getByTestId(`base-${panel}-button`).click();
      const popover = page.getByTestId(`base-${panel}-panel`);
      // Measured once its open animation (a slight scale) has finished.
      await popover.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
      const box = (await popover.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(1280 - 8 + 1);
      if (button.x + box.width > 1280 - 8) expect(Math.abs(box.x + box.width - (button.x + button.width))).toBeLessThanOrEqual(1);
      else expect(Math.abs(box.x - button.x)).toBeLessThanOrEqual(1);
      await page.keyboard.press('Escape');
      await expect(page.getByTestId(`base-${panel}-panel`)).toHaveCount(0);
    }
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
    // Obsidian's look: a thin guide line on the left and a small filled dot per value.
    const props = item.locator('.base-list-props');
    await expect(props).toHaveCSS('border-left-width', '1px');
    await expect(props).toHaveCSS('list-style-type', 'none');
    const dot = await item.getByTestId('base-list-prop-note.status').evaluate((li) => {
      const style = getComputedStyle(li, '::before');
      return { width: style.width, radius: style.borderRadius, background: style.backgroundColor };
    });
    expect(dot).toMatchObject({ width: '4px', radius: '50%' });
    expect(dot.background).not.toBe('rgba(0, 0, 0, 0)');
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

  for (const [kind, file, body, ready] of [
    ['a database view', 'All.base', 'views:\n  - type: table\n    name: Table\n', 'base-page'],
    ['a whiteboard', 'Map.canvas', '{"nodes":[],"edges":[]}', 'board-page'],
  ] as const) {
    test(`a vault that opens on ${kind} loads with no 404 (the page prefetch skips it)`, async ({ page, request, vault }) => {
      void vault;
      // Its only other item is a folder, so the first item is the one opened.
      await writeVault(request, { [file]: body, 'Notes/Inside.md': 'Inside\n' });
      const missing: string[] = [];
      page.on('response', (response) => {
        if (response.status() === 404) missing.push(response.url());
      });
      await page.goto('/');
      await expect(page.getByTestId(ready)).toBeVisible();
      await page.waitForLoadState('networkidle');
      expect(missing).toEqual([]);
    });
  }

  test('Kanban covers are a fixed box, columnWidth × imageAspectRatio tall, as in Obsidian', async ({ page, request, vault }) => {
    void vault;
    const svg = (w: number, h: number) =>
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#2a9d8f"/></svg>`;
    const shapes = { tall: svg(50, 200), wide: svg(500, 300), square: svg(200, 200) };
    // Attachments, not pages: written directly (writeVault waits for pages).
    await fs.mkdir(path.join(E2E_VAULT, 'attachments'), { recursive: true });
    for (const [name, body] of Object.entries(shapes)) await fs.writeFile(path.join(E2E_VAULT, 'attachments', `${name}.svg`), body, 'utf8');
    const board = (settings: string) =>
      `filters: 'file.inFolder("Work")'\nviews:\n  - type: kanban\n    name: Board\n    groupBy:\n      property: status\n      direction: ASC\n    image: note.cover\n    imageFit: contain\n${settings}`;
    await writeVault(request, {
      'Work/Board.base': board(''),
      'Work/Tall.md': '---\nstatus: Todo\ncover: "[[tall.svg]]"\n---\nT\n',
      'Work/Wide.md': '---\nstatus: Todo\ncover: "[[wide.svg]]"\n---\nW\n',
      'Work/Square.md': '---\nstatus: Todo\ncover: "[[square.svg]]"\n---\nS\n',
      'Work/Colour.md': '---\nstatus: Todo\ncover: "#e76f51"\n---\nC\n',
    });
    const heights = async () => {
      const out: Record<string, number> = {};
      for (const id of ['Tall', 'Wide', 'Square', 'Colour']) {
        const card = page.getByTestId(`base-card-Work/${id}`);
        const cover = card.getByTestId('base-card-image');
        const [cardBox, coverBox] = [(await card.boundingBox())!, (await cover.boundingBox())!];
        // Card-wide, whatever the image's shape (part of the polled value:
        // a throw here isn't retried, and the columns settle a moment late).
        out[id] = Math.abs(coverBox.width - cardBox.width) <= 2 ? Math.round(coverBox.height) : -1;
      }
      return out;
    };

    await page.goto('/#/Work/Board.base');
    await expect(page.getByTestId('base-card-Work/Colour')).toBeVisible();
    // Defaults: 280 × 0.5.
    // Polled: covers load and the columns settle a moment after the first card shows.
    await expect.poll(heights, { timeout: 10_000 }).toEqual({ Tall: 140, Wide: 140, Square: 140, Colour: 140 });
    // contain letterboxes inside the box (cover would crop).
    await expect(page.getByTestId('base-card-Work/Tall').locator('img')).toHaveCSS('object-fit', 'contain');

    await fs.writeFile(path.join(E2E_VAULT, 'Work/Board.base'), board('    columnWidth: 400\n    imageAspectRatio: 1\n'), 'utf8');
    await expect.poll(heights, { timeout: 10_000 }).toEqual({ Tall: 400, Wide: 400, Square: 400, Colour: 400 });

    // The vault reset removes pages only; don't leave attachments for other specs.
    for (const name of Object.keys(shapes)) await fs.rm(path.join(E2E_VAULT, 'attachments', `${name}.svg`), { force: true });
  });
});
