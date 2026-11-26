import fs from 'node:fs/promises';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { api, expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * #bg7c9bzk (#faqr8pj9's #19, and @graph-dev's shots of the paste dialog): a disabled main button must read as
 * disabled. It drops the accent fill an enabled one has, isn't faded, and its text stays AA (4.5:1) on its own fill.
 * The rule is app-wide (@lead): checked on the paste dialog's Paste (a duplicate column name), the add-column
 * popover's Add (no name yet) and Trash's "Empty Trash" (nothing in Trash, a secondary button), light and dark.
 */

const BASE =
  'gumply:\n  rows: People\nfilters:\n  and:\n    - file.folder == "People"\nviews:\n  - type: table\n    name: Table\n    order:\n      - file.name\n      - role\n';

async function open(page: Page, request: import('@playwright/test').APIRequestContext, theme: 'light' | 'dark') {
  await fs.mkdir(path.join(E2E_VAULT, 'People'), { recursive: true });
  await fs.writeFile(path.join(E2E_VAULT, 'People.base'), BASE, 'utf8');
  await fs.writeFile(path.join(E2E_VAULT, 'People', 'Ann.md'), '---\nrole: Cook\n---\nAnn\n', 'utf8');
  await expect.poll(async () => (await api.listPages(request)).some((meta) => meta.id === 'People/Ann'), { timeout: 10_000 }).toBe(true);
  await page.addInitScript((value) => window.localStorage.setItem('gumply:theme', value), theme);
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await page.getByTestId('page-item-People.base').click();
  await expect(page.getByTestId('base-table').locator('.base-title-text')).toHaveText(['Ann']);
}

/** The button's text and fill, as sRGB, with the WCAG contrast of one on the other. */
async function look(button: Locator) {
  return button.evaluate((element) => {
    const rgb = (value: string) => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const luminance = ([r, g, b]: number[]) => {
      const lin = (c: number) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
      return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    };
    const style = getComputedStyle(element);
    const text = rgb(style.color);
    const fill = rgb(style.backgroundColor);
    const [a, b] = [luminance(text), luminance(fill)].sort((x, y) => y - x);
    const accent = rgb(getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().replace(/^#(..)(..)(..)$/, (_, r, g, bl) => `${parseInt(r, 16)},${parseInt(g, 16)},${parseInt(bl, 16)}`));
    return { fill: fill.join(','), accent: accent.join(','), opacity: Number(style.opacity), contrast: (a + 0.05) / (b + 0.05) };
  });
}

function expectReadsDisabled(seen: Awaited<ReturnType<typeof look>>) {
  // Not the accent an enabled button has, not faded, and its text readable.
  expect(seen.fill).not.toBe(seen.accent);
  expect(seen.opacity).toBe(1);
  expect(seen.contrast).toBeGreaterThanOrEqual(4.5);
}

for (const theme of ['light', 'dark'] as const) {
  test(`a disabled Paste in the paste dialog reads as disabled, with AA text (${theme})`, async ({ page, request, vault }) => {
    void vault;
    await open(page, request, theme);
    await page.getByTestId('base-typing-input').click();
    await page.evaluate((text) => {
      const data = new DataTransfer();
      data.setData('text/plain', text);
      document.activeElement?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, 'Name\tnote\tnote\nIvy\ta\tb\nOtto\tc\td\n');
    await page.getByTestId('base-paste-headers').check();
    await expect(page.getByTestId('base-paste-problem')).toBeVisible();
    const confirm = page.getByTestId('base-paste-confirm');
    await expect(confirm).toBeDisabled();
    expectReadsDisabled(await look(confirm));
  });

  test(`a disabled Add in the add-column popover reads as disabled, with AA text (${theme})`, async ({ page, request, vault }) => {
    void vault;
    await open(page, request, theme);
    await page.getByTestId('base-add-column-button').click();
    const submit = page.getByTestId('base-add-column-submit');
    await expect(submit).toBeDisabled();
    expectReadsDisabled(await look(submit));
  });

  test(`a disabled "Empty Trash" reads as disabled, with AA text (${theme})`, async ({ page, vault }) => {
    void vault;
    await page.addInitScript((value) => window.localStorage.setItem('gumply:theme', value), theme);
    await page.goto('/');
    await page.getByTestId('sidebar-trash').click();
    const empty = page.getByTestId('trash-empty');
    await expect(empty).toBeDisabled();
    expectReadsDisabled(await look(empty));
  });
}
