import fs from 'node:fs/promises';
import path from 'node:path';
import type { APIRequestContext, Page } from '@playwright/test';
import { api, expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * #7prbquxu, spec/database-tables §8 follow-ups (@lead): a Kanban grouped by a Select shows each column's head in
 * its option's colour; the colour swatches in "Edit options…" have an edge readable in both themes (≥ 3:1 against
 * the popover); and a Select cell's picker closes when its cell scrolls out of the table's visible box (it's fixed on
 * the page, so it used to float over the sticky header). Invented content.
 */

const COLOURS = ['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'];
const SELECT =
  'properties:\n  note.stage:\n    gumplyType: select\n    gumplyOptions:\n' +
  COLOURS.map((c, i) => `      - value: Stage ${i + 1}\n        color: ${c}\n`).join('');
const NAMES = Array.from({ length: 60 }, (_, i) => `Person ${String(i + 1).padStart(2, '0')}`);

function team(view: string): Record<string, string> {
  const files: Record<string, string> = {
    'Team.base': `gumply:\n  rows: Team\nfilters:\n  and:\n    - file.folder == "Team"\n${SELECT}views:\n${view}`,
  };
  NAMES.forEach((name, i) => (files[`Team/${name}.md`] = `---\nstage: Stage ${(i % 3) + 1}\n---\n${name}\n`));
  return files;
}
const TABLE = '  - type: table\n    name: Table\n    order:\n      - file.name\n      - stage\n';
const BOARD = '  - type: kanban\n    name: Board\n    order:\n      - file.name\n    groupBy:\n      property: stage\n      direction: ASC\n';

async function writeVault(request: APIRequestContext, files: Record<string, string>) {
  for (const [relative, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(E2E_VAULT, relative)), { recursive: true });
    await fs.writeFile(path.join(E2E_VAULT, relative), content, 'utf8');
  }
  await expect
    .poll(async () => (await api.listPages(request)).filter((meta) => meta.id.startsWith('Team/')).length, { timeout: 15_000 })
    .toBe(NAMES.length);
}

async function openTeam(page: Page) {
  await page.goto(`/#/${encodeURIComponent('Team.base')}`);
  await expect(page.getByTestId('base-view')).toBeVisible();
}

test('a Kanban grouped by a Select shows each column head in its option\'s colour', async ({ page, request, vault }) => {
  void vault;
  await writeVault(request, team(BOARD));
  await openTeam(page);
  const kanban = page.getByTestId('base-kanban');
  await expect(kanban).toBeVisible();
  for (const [index, colour] of [[1, 'gray'], [2, 'brown'], [3, 'orange']] as const) {
    const head = page.getByTestId(`base-column-Stage ${index}`).locator('.base-kanban-title');
    await expect(head.locator(`.base-option[data-color="${colour}"]`), `Stage ${index}`).toHaveText(`Stage ${index}`);
  }
  // The label stays the head's first span (other tests and screen readers read it there).
  await expect(kanban.locator('.base-kanban-title > span:first-child').first()).toHaveText('Stage 1');
});

for (const scheme of ['light', 'dark'] as const) {
  test(`"Edit options…": every colour swatch has an edge of at least 3:1 against the popover (${scheme})`, async ({ page, request, vault }) => {
    void vault;
    await page.emulateMedia({ colorScheme: scheme });
    await writeVault(request, team(TABLE));
    await openTeam(page);
    await page.getByTestId('base-th-note.stage').click();
    await page.getByTestId('base-edit-options').click();
    const editor = page.getByTestId('base-options-editor');
    await expect(editor).toBeVisible();
    const ratios = await editor.evaluate((popover) => {
      // Any CSS colour to sRGB through a canvas (it resolves color-mix, color(), alpha).
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d')!;
      const rgb = (colour: string, under: number[] = [255, 255, 255]) => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = `rgb(${under.join(',')})`;
        context.fillRect(0, 0, 1, 1);
        context.fillStyle = colour;
        context.fillRect(0, 0, 1, 1);
        return Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3));
      };
      const luminance = ([r, g, b]: number[]) =>
        [r!, g!, b!].map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0);
      const contrast = (a: number[], b: number[]) => {
        const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
        return (x! + 0.05) / (y! + 0.05);
      };
      // The popover's own background, over the page's.
      let element: Element | null = popover;
      let background = 'rgb(255, 255, 255)';
      while (element) {
        const value = getComputedStyle(element).backgroundColor;
        if (value && value !== 'rgba(0, 0, 0, 0)' && value !== 'transparent') {
          background = value;
          break;
        }
        element = element.parentElement;
      }
      const behind = rgb(background);
      return Array.from(popover.querySelectorAll<HTMLElement>('.base-option-swatch[aria-checked="false"]')).map((swatch) => ({
        colour: swatch.dataset.color,
        ratio: Math.round(contrast(rgb(getComputedStyle(swatch).borderTopColor, behind), behind) * 100) / 100,
      }));
    });
    expect(ratios.length).toBeGreaterThan(0);
    const low = ratios.filter((entry) => entry.ratio < 3);
    expect(low, JSON.stringify(ratios)).toEqual([]);
  });
}

test('a Select cell\'s picker closes when its cell scrolls out of the table\'s visible box', async ({ page, request, vault }) => {
  void vault;
  await page.setViewportSize({ width: 1280, height: 800 });
  await writeVault(request, team(TABLE));
  await openTeam(page);
  const scroller = page.getByTestId('base-table-scroll');
  await expect(page.getByTestId('base-table').locator('.base-title-text').first()).toHaveText(NAMES[0]!);
  // The second row's Select cell: a click opens its picker.
  await page.locator('[data-row-id="Team/Person 02"] [data-grid-col="1"]').click();
  await expect(page.getByTestId('base-select-picker')).toBeVisible();
  // Scroll the table just enough that the row sits under the sticky header while it's still mounted (a farther
  // scroll unmounts the row, and the picker with it, even without this fix).
  const row = page.getByTestId('base-row-Team/Person 02');
  const offset = await page.evaluate(() => {
    const head = document.querySelector('.base-table-head')!.getBoundingClientRect();
    const cell = document.querySelector('[data-row-id="Team/Person 02"]')!.getBoundingClientRect();
    return Math.ceil((cell.top + cell.bottom) / 2 - head.bottom) + 4;
  });
  await scroller.evaluate((element, by) => {
    element.scrollTop = by;
    element.dispatchEvent(new Event('scroll'));
  }, offset);
  await expect(row, 'the row is still there, under the header').toHaveCount(1);
  await expect(page.getByTestId('base-select-picker')).toHaveCount(0);
  // Nothing was written by closing it.
  expect(await fs.readFile(path.join(E2E_VAULT, 'Team/Person 02.md'), 'utf8')).toBe('---\nstage: Stage 2\n---\nPerson 02\n');
});

test('a resize (a phone keyboard showing) doesn\'t close an open picker, even when its cell ends up below the fold (@polish-dev)', async ({ page, request, vault }) => {
  void vault;
  await page.setViewportSize({ width: 1280, height: 800 });
  await writeVault(request, team(TABLE));
  await openTeam(page);
  await expect(page.getByTestId('base-table').locator('.base-title-text').first()).toHaveText(NAMES[0]!);
  // A row in the lower half of the table.
  await page.locator('[data-row-id="Team/Person 15"] [data-grid-col="1"]').click();
  await expect(page.getByTestId('base-select-picker')).toBeVisible();
  // The visible area shrinks, as when an on-screen keyboard appears. The browser may then move the table's
  // scroll by itself (scroll anchoring keeps what's on screen in place), which fires a scroll event: do that
  // here, every time, as it happened in some runs only (trial-main25).
  await page.setViewportSize({ width: 1280, height: 420 });
  await page.getByTestId('base-table-scroll').evaluate((element) => {
    element.scrollTop += 120;
  });
  // Past the settle window: the picker is still open, **seen** (its cell brought back into the table's visible
  // box, @opus-hunter, @lead), and the search keeps the focus.
  await page.waitForTimeout(800);
  await expect(page.getByTestId('base-select-picker')).toBeVisible();
  expect(await pickerAndCellInView(page, 'Team/Person 15')).toEqual({ picker: true, cell: true });
  await expect(page.getByTestId('base-select-search')).toBeFocused();
});

test('a resize that leaves the cell below the fold brings it back above the sticky footer row, the picker open (@polish-dev)', async ({ page, request, vault }) => {
  void vault;
  await page.setViewportSize({ width: 1280, height: 800 });
  await writeVault(request, team(TABLE));
  await openTeam(page);
  await expect(page.getByTestId('base-table').locator('.base-title-text').first()).toHaveText(NAMES[0]!);
  await page.locator('[data-row-id="Team/Person 15"] [data-grid-col="1"]').click();
  await expect(page.getByTestId('base-select-picker')).toBeVisible();
  // The window shrinks (a phone keyboard) and nothing else scrolls: the row is now below the fold, and is brought
  // back from below. It must stop above the sticky "N rows" foot, not under it.
  await page.setViewportSize({ width: 1280, height: 420 });
  await page.waitForTimeout(800);
  await expect(page.getByTestId('base-select-picker')).toBeVisible();
  expect(await pickerAndCellInView(page, 'Team/Person 15')).toEqual({ picker: true, cell: true });
});

test('a resize whose own scroll moves the cell up under the sticky header brings it back below it, and the picker stays open (@polish-dev, @lead)', async ({ page, request, vault }) => {
  void vault;
  await page.setViewportSize({ width: 1280, height: 800 });
  await writeVault(request, team(TABLE));
  await openTeam(page);
  await expect(page.getByTestId('base-table').locator('.base-title-text').first()).toHaveText(NAMES[0]!);
  await page.locator('[data-row-id="Team/Person 03"] [data-grid-col="1"]').click();
  await expect(page.getByTestId('base-select-picker')).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 600 });
  // The browser's own scroll after the resize takes the row up under the header.
  await page.getByTestId('base-table-scroll').evaluate((element) => {
    element.scrollTop += 90;
  });
  await page.waitForTimeout(800);
  await expect(page.getByTestId('base-select-picker')).toBeVisible();
  expect(await pickerAndCellInView(page, 'Team/Person 03')).toEqual({ picker: true, cell: true });
});

/**
 * Whether the open picker lies inside the window, and the row's Select cell's middle inside the table's visible
 * box (below the sticky head, above the sticky foot and the scroller's bottom): seen, not just present.
 */
async function pickerAndCellInView(page: Page, rowId: string): Promise<{ picker: boolean; cell: boolean }> {
  return page.evaluate((id) => {
    const picker = document.querySelector('[data-testid="base-select-picker"]')!.getBoundingClientRect();
    const inWindow = picker.top >= 0 && picker.bottom <= window.innerHeight && picker.height > 0;
    const scroller = document.querySelector('[data-testid="base-table-scroll"]')!.getBoundingClientRect();
    const head = document.querySelector('.base-table-head')!.getBoundingClientRect();
    // The footer row is sticky too (@polish-dev): a cell under it isn't seen either.
    const foot = document.querySelector('.base-table-foot')?.getBoundingClientRect();
    const cell = document.querySelector(`[data-row-id="${id}"] [data-grid-col="1"]`)!.getBoundingClientRect();
    const middle = (cell.top + cell.bottom) / 2;
    return { picker: inWindow, cell: middle >= Math.max(scroller.top, head.bottom) && middle <= Math.min(scroller.bottom, foot?.top ?? Infinity) };
  }, rowId);
}
