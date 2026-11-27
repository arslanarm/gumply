import fs from 'node:fs/promises';
import path from 'node:path';
import type { APIRequestContext, Page } from '@playwright/test';
import { api, expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * #cmun2mix (found in #nr3rkgj2): a database's popovers (Filter, Sort, Properties, "+", a view's menus) opened from
 * the keyboard take the keyboard: the first control inside has the focus, and Escape gives it back to the button that
 * opened it. Before, the focus ran while the panel was still hidden (before it's placed) and stayed on the button.
 * A view's menus are menus (their items are menu items): the arrows move through them. Synthetic vault.
 */

async function writeVault(request: APIRequestContext, files: Record<string, string>) {
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(E2E_VAULT, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, 'utf8');
  }
  const ids = Object.keys(files).filter((file) => file.endsWith('.md')).map((file) => file.replace(/\.md$/, ''));
  await expect
    .poll(async () => {
      const listed = new Set((await api.listPages(request)).map((meta) => meta.id));
      return ids.every((id) => listed.has(id));
    }, { timeout: 10_000 })
    .toBe(true);
}

const PEOPLE = {
  'People.base':
    'gumply:\n  rows: People\nfilters:\n  and:\n    - file.folder == "People"\nviews:\n  - type: table\n    name: Table\n    order:\n      - file.name\n      - role\n      - age\n',
  'People/Ann.md': '---\nrole: Cook\nage: 30\n---\nAnn\n',
  'People/Bo.md': '---\nrole: Pilot\nage: 41\n---\nBo\n',
};

async function openPeople(page: Page) {
  await page.goto('/');
  await page.getByTestId('page-item-People.base').click();
  await expect(page.getByTestId('base-table').locator('.base-title-text')).toHaveText(['Ann', 'Bo']);
}

/** Opens a popover from the keyboard: the focus is inside it, and Escape gives it back to the button. */
async function opensWithFocusInside(page: Page, trigger: string, panel: string) {
  const button = page.getByTestId(trigger);
  await button.focus();
  await page.keyboard.press('Enter');
  const popover = page.getByTestId(panel);
  await expect(popover).toBeVisible();
  await expect
    .poll(() => popover.evaluate((element) => element.contains(document.activeElement) && document.activeElement !== element), { message: `${panel}: the focus is inside` })
    .toBe(true);
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);
  await expect(button).toBeFocused();
}

test('#cmun2mix: Filter, Sort, Properties and "+" opened from the keyboard take the focus; Escape gives it back', async ({ page, request, vault }) => {
  void vault;
  await writeVault(request, PEOPLE);
  await openPeople(page);
  await opensWithFocusInside(page, 'base-filter-button', 'base-filter-panel');
  await opensWithFocusInside(page, 'base-sort-button', 'base-sort-panel');
  await opensWithFocusInside(page, 'base-properties-button', 'base-properties-panel');
  await opensWithFocusInside(page, 'base-add-column-button', 'base-add-column');
  // "+" starts on its name field, ready for typing.
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('base-add-column-name')).toBeFocused();
  await page.keyboard.press('Escape');

  // The Rows panel has no control: it takes the focus itself, so it's announced (@opus-editor); Escape gives it back.
  const rows = page.getByTestId('base-source-button');
  await rows.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('base-rows-panel')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(rows).toBeFocused();
});

test('#cmun2mix: Filter with a rule starts on a field, never on the rule\'s remove button: Enter right after opening keeps the rule (@opus-editor)', async ({ page, request, vault }) => {
  void vault;
  await writeVault(request, {
    ...PEOPLE,
    'People.base': PEOPLE['People.base'].replace('    name: Table\n', '    name: Table\n    filters:\n      and:\n        - role == "Cook"\n'),
  });
  await page.goto('/');
  await page.getByTestId('page-item-People.base').click();
  await expect(page.getByTestId('base-table').locator('.base-title-text')).toHaveText(['Ann']);
  await page.getByTestId('base-filter-button').focus();
  await page.keyboard.press('Enter');
  const panel = page.getByTestId('base-filter-panel');
  await expect(panel.getByTestId('base-rule')).toHaveCount(1);
  await expect.poll(() => panel.evaluate((element) => element.contains(document.activeElement) && document.activeElement !== element)).toBe(true);
  expect(await page.evaluate(() => document.activeElement?.classList.contains('base-rule-remove'))).toBe(false);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('base-table').locator('.base-title-text')).toHaveText(['Ann']);
  await expect.poll(() => fs.readFile(path.join(E2E_VAULT, 'People.base'), 'utf8')).toContain('role == "Cook"');
});

test('#cmun2mix: a view\'s menu is a menu: Enter on the active tab opens it on its first item, the arrows move, Escape gives the tab back', async ({ page, request, vault }) => {
  void vault;
  await writeVault(request, PEOPLE);
  await openPeople(page);
  const tab = page.getByTestId('base-tab-Table');
  await tab.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByTestId('base-view-menu');
  await expect(menu).toHaveAttribute('role', 'menu');
  const items = menu.locator('[role="menuitem"]');
  await expect(items.first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(tab).toBeFocused();
});
