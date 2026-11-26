import fs from 'node:fs/promises';
import path from 'node:path';
import type { APIRequestContext, Page } from '@playwright/test';
import { api, expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * #nr3rkgj2 (#faqr8pj9's findings 3 and 5): Cmd/Ctrl+Z right after a paste undoes it (the keyboard is back on the
 * typing row's empty field, which has nothing of its own to undo), and a column's menu works from the keyboard:
 * Enter opens it on its first item, the arrows, Home and End move, Enter runs an item, Escape and Tab close it,
 * and the keyboard is back on the column's header. Synthetic vault.
 */

const read = (relative: string) => fs.readFile(path.join(E2E_VAULT, relative), 'utf8');
const exists = (relative: string) => fs.access(path.join(E2E_VAULT, relative)).then(() => true, () => false);

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

async function paste(page: Page, text: string) {
  await page.evaluate((plain) => {
    const data = new DataTransfer();
    data.setData('text/plain', plain);
    document.activeElement?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
}

test('#nr3rkgj2 (3): Cmd/Ctrl+Z right after a paste undoes it; with text typed in the typing row, the field keeps its own undo', async ({ page, request, vault }) => {
  void vault;
  await writeVault(request, PEOPLE);
  await openPeople(page);
  const typing = page.getByTestId('base-typing-input');
  const titles = page.getByTestId('base-table').locator('.base-title-text');

  await typing.click();
  // A header row (age is a number column): the preview takes it as headers.
  await paste(page, 'Name\tage\nCy\t25\nDee\t33\n');
  await page.getByTestId('base-paste-confirm').click();
  await expect(titles).toHaveText(['Ann', 'Bo', 'Cy', 'Dee']);
  await expect.poll(() => exists('People/Dee.md')).toBe(true);
  // The keyboard is back on the typing row, empty.
  await expect(typing).toBeFocused();
  await expect(typing).toHaveValue('');

  // Text typed there first: Cmd/Ctrl+Z is the field's, the paste stays.
  await page.keyboard.type('Ed');
  await page.keyboard.press('ControlOrMeta+z');
  await page.waitForTimeout(500);
  await expect(titles).toHaveText(['Ann', 'Bo', 'Cy', 'Dee']);
  await typing.fill('');
  await expect(typing).toBeFocused();

  // The field empty: Cmd/Ctrl+Z undoes the paste, at once (no ArrowUp first).
  await page.keyboard.press('ControlOrMeta+z');
  await expect(titles).toHaveText(['Ann', 'Bo']);
  await expect.poll(() => exists('People/Cy.md')).toBe(false);
  await expect.poll(() => exists('People/Dee.md')).toBe(false);
});

test('#nr3rkgj2 (5): a column\'s menu from the keyboard: Enter opens it on its first item, arrows, Home and End move, Enter runs one, Escape and Tab close it back to the header', async ({ page, request, vault }) => {
  void vault;
  await writeVault(request, PEOPLE);
  await openPeople(page);
  const header = page.getByTestId('base-th-note.role');
  const menu = page.getByTestId('base-column-menu');
  const items = menu.locator('[role="menuitem"], [role="menuitemradio"]');

  await header.focus();
  await page.keyboard.press('Enter');
  await expect(menu).toBeVisible();
  await expect(menu).toHaveAttribute('role', 'menu');
  await expect(items.first()).toBeFocused();

  await page.keyboard.press('ArrowDown');
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  // Wraps from the first item to the last: "Delete from all rows", reachable without a mouse.
  await expect(items.last()).toBeFocused();
  await expect(items.last()).toHaveAttribute('data-testid', 'base-delete-column');
  await page.keyboard.press('Home');
  await expect(items.first()).toBeFocused();
  await page.keyboard.press('End');
  await expect(items.last()).toBeFocused();

  // Escape closes it, back on the header.
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(header).toBeFocused();

  // Tab closes it too, back on the header.
  await page.keyboard.press('Enter');
  await expect(items.first()).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(menu).toHaveCount(0);
  await expect(header).toBeFocused();

  // Enter runs an item (the second: sort Z→A) and the keyboard is back on the header.
  await page.keyboard.press('Enter');
  await expect(items.first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(menu).toHaveCount(0);
  await expect(titles(page)).toHaveText(['Bo', 'Ann']);
  await expect.poll(() => read('People.base')).toMatch(/sort:\n\s+- property: (note\.)?role\n\s+direction: DESC/);
  await expect(header).toBeFocused();
});

const titles = (page: Page) => page.getByTestId('base-table').locator('.base-title-text');
