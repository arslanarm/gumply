import fs from 'node:fs/promises';
import path from 'node:path';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { api, expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * #pzqmduua (visual QA pass 8, New database phases 2-3): what the tests of those phases didn't look at.
 * 1. A Select cell's picker is seen: the row's paint containment clipped it to the row, so it was there, focused and
 *    taking keys, but invisible (Enter then added the typed text as an option).
 * 2. The paste preview has its own width: the generic modal width (420 px) won over it on every window, so its
 *    columns were cut off.
 * 3. "Edit options…": the delete question is brought into sight; it opened below the popover's scrolled fold.
 * Invented content.
 */

const COLOURS = ['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'];
const TEAM = {
  'Team.base':
    'gumply:\n  rows: Team\nfilters:\n  and:\n    - file.folder == "Team"\n' +
    'properties:\n  note.stage:\n    gumplyType: select\n    gumplyOptions:\n' +
    COLOURS.map((c, i) => `      - value: Stage ${i + 1}\n        color: ${c}\n`).join('') +
    'views:\n  - type: table\n    name: Table\n    order:\n      - file.name\n      - stage\n',
  'Team/Avery.md': '---\nstage: Stage 1\n---\nAvery\n',
  'Team/Blake.md': '---\nstage: Stage 2\n---\nBlake\n',
};

async function writeVault(request: APIRequestContext, files: Record<string, string>) {
  for (const [relative, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(E2E_VAULT, relative)), { recursive: true });
    await fs.writeFile(path.join(E2E_VAULT, relative), content, 'utf8');
  }
  const ids = Object.keys(files).filter((file) => file.endsWith('.md')).map((file) => file.replace(/\.md$/, ''));
  await expect
    .poll(async () => {
      const listed = new Set((await api.listPages(request)).map((meta) => meta.id));
      return ids.every((id) => listed.has(id));
    }, { timeout: 10_000 })
    .toBe(true);
}

async function openTeam(page: Page) {
  await page.goto(`/#/${encodeURIComponent('Team.base')}`);
  await expect(page.getByTestId('base-table').locator('.base-title-text')).toHaveText(['Avery', 'Blake']);
}

/** The element on top at the centre of `target` is `target` or inside it: nothing clips or covers it. */
async function onTop(page: Page, target: Locator): Promise<boolean> {
  const box = (await target.boundingBox())!;
  const handle = await target.elementHandle();
  return page.evaluate(
    ([x, y, element]) => {
      const hit = document.elementFromPoint(x as number, y as number);
      return Boolean(hit && (element as Element).contains(hit));
    },
    [box.x + box.width / 2, box.y + box.height / 2, handle] as const,
  );
}

test('a Select cell\'s picker can be seen and clicked, on the last row too (pass 8, 1)', async ({ page, request, vault }) => {
  void vault;
  await writeVault(request, TEAM);
  await openTeam(page);
  // Blake's stage (the last row): Enter opens the picker.
  await page.getByTestId('base-typing-input').click();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  const picker = page.getByTestId('base-select-picker');
  await expect(page.getByTestId('base-select-search')).toBeFocused();
  expect(await onTop(page, page.getByTestId('base-select-search')), 'the search field is not clipped or covered').toBe(true);
  const option = picker.getByTestId('base-select-option-Stage 5');
  expect(await onTop(page, option), 'an option in the list is not clipped or covered').toBe(true);
  // So a click picks it.
  await option.click({ timeout: 3_000 });
  await expect.poll(() => fs.readFile(path.join(E2E_VAULT, 'Team/Blake.md'), 'utf8')).toBe('---\nstage: Stage 5\n---\nBlake\n');
});

test('the paste preview is wide enough for its columns on a wide window (pass 8, 2)', async ({ page, request, vault }) => {
  void vault;
  await page.setViewportSize({ width: 1280, height: 800 });
  await writeVault(request, { 'Team.base': TEAM['Team.base'] });
  await fs.mkdir(path.join(E2E_VAULT, 'Team'), { recursive: true });
  await page.goto(`/#/${encodeURIComponent('Team.base')}`);
  await page.getByTestId('base-typing-input').click();
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData('text/plain', 'Name\tage\tcity\nIvy\t38\tOslo\nOtto\t42\tRiga\n');
    document.activeElement?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  const preview = page.getByTestId('base-paste-preview');
  await expect(preview).toBeVisible();
  expect((await preview.boundingBox())!.width, 'the preview uses its own width, not the small dialog width').toBeGreaterThan(600);
  // Every column's type is in sight without scrolling sideways.
  for (const col of [1, 2]) expect(await onTop(page, page.getByTestId(`base-paste-type-${col}`)), `column ${col}'s type`).toBe(true);
});

test('"Edit options…": the delete question comes into sight, with focus on its first choice (pass 8, 3)', async ({ page, request, vault }) => {
  void vault;
  await page.setViewportSize({ width: 1280, height: 800 });
  await writeVault(request, TEAM);
  await openTeam(page);
  await page.getByTestId('base-th-note.stage').click();
  await page.getByTestId('base-edit-options').click();
  await expect(page.getByTestId('base-options-editor')).toBeVisible();
  await page.getByTestId('base-option-delete-Stage 9').click();
  const clear = page.getByTestId('base-option-delete-clear');
  await expect(clear).toBeFocused();
  // Inside the popover's visible box, not below its scrolled fold.
  await expect.poll(() => onTop(page, clear), { timeout: 2_000 }).toBe(true);
  expect(await onTop(page, page.getByTestId('base-option-delete-keep'))).toBe(true);
});
