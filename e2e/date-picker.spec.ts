import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { E2E_VAULT } from './support/env';
import { expectPageTitle } from './support/ui';

/**
 * #93wnicas: date and date-and-time property values show in the app's date
 * format and the interface language, and open the app's own picker. The file
 * gets exactly what the browser's native input used to write.
 */
const file = (name: string) => path.join(E2E_VAULT, `${name}.md`);
const read = (name: string) => readFileSync(file(name), 'utf8');
const ORIGINAL = '---\ntitle note: kept # by hand\ndue: 2026-11-21\nmeet: 2026-11-21T09:15\n---\n\nThe body.\n';

async function openTask(page: Page) {
  writeFileSync(file('Task'), ORIGINAL);
  await page.goto('/#/Task');
  await expectPageTitle(page, 'Task');
  await expect(page.getByTestId('property-row-due')).toBeVisible();
}

const value = (page: Page, key: string) => page.getByTestId(`property-value-${key}`).getByTestId('date-picker-value');

test.describe('date picker (#93wnicas)', () => {
  test('values read in the app format, in English and in Russian', async ({ page, vault }) => {
    await vault.seed([{ title: 'Anchor' }]);
    await openTask(page);
    await expect(value(page, 'due')).toHaveText('Nov 21, 2026');
    await expect(value(page, 'meet')).toHaveText(/^Nov 21, 2026, 9:15\sAM$/);
    await page.addInitScript(() => window.localStorage.setItem('gumply:language', 'ru'));
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
    await expect(value(page, 'due')).toHaveText('21 нояб. 2026 г.');
    await expect(value(page, 'meet')).toHaveText('21 нояб. 2026 г., 09:15');
    // The picker speaks Russian too, weeks start on Monday.
    await value(page, 'due').click();
    await expect(page.getByTestId('date-picker-month')).toHaveText('Ноябрь 2026 г.');
    await expect(page.locator('.date-picker-weekday').first()).toHaveText('Пн');
    await expect(page.getByTestId('date-picker-today')).toHaveText('Сегодня');
    expect(read('Task')).toBe(ORIGINAL);
  });

  test('a click picks a day: only that line changes, byte for byte', async ({ page, vault }) => {
    await vault.seed([{ title: 'Anchor' }]);
    await openTask(page);
    await value(page, 'due').click();
    const picker = page.getByTestId('date-picker');
    await expect(picker).toBeVisible();
    await expect(page.getByTestId('date-picker-month')).toHaveText('November 2026');
    await expect(page.locator('.date-picker-weekday').first()).toHaveText('Su');
    await expect(picker.getByTestId('date-picker-day-2026-11-21')).toHaveAttribute('aria-selected', 'true');
    await picker.getByTestId('date-picker-day-2026-11-05').click();
    await expect(picker).toHaveCount(0);
    await expect.poll(() => read('Task')).toBe(ORIGINAL.replace('due: 2026-11-21', 'due: 2026-11-05'));
    await expect(value(page, 'due')).toHaveText('Nov 5, 2026');
    await expect(value(page, 'due')).toBeFocused();
  });

  test('keyboard: Enter opens, arrows and PageDown move, Enter picks; Esc writes nothing', async ({ page, vault }) => {
    await vault.seed([{ title: 'Anchor' }]);
    await openTask(page);
    await value(page, 'due').focus();
    await page.keyboard.press('Enter');
    const picker = page.getByTestId('date-picker');
    await expect(picker.getByTestId('date-picker-day-2026-11-21')).toBeFocused();
    // Esc closes without writing and gives focus back.
    await page.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);
    await expect(value(page, 'due')).toBeFocused();
    expect(read('Task')).toBe(ORIGINAL);

    await page.keyboard.press(' ');
    await expect(picker.getByTestId('date-picker-day-2026-11-21')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    await expect(picker.getByTestId('date-picker-day-2026-11-29')).toBeFocused();
    await page.keyboard.press('PageDown');
    await expect(page.getByTestId('date-picker-month')).toHaveText('December 2026');
    await expect(picker.getByTestId('date-picker-day-2026-12-29')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect.poll(() => read('Task')).toBe(ORIGINAL.replace('due: 2026-11-21', 'due: 2026-12-29'));
  });

  test('date and time: a day keeps the time, a typed time is written', async ({ page, vault }) => {
    await vault.seed([{ title: 'Anchor' }]);
    await openTask(page);
    await value(page, 'meet').click();
    const picker = page.getByTestId('date-picker');
    await expect(picker.getByTestId('date-picker-time')).toHaveValue('09:15');
    await picker.getByTestId('date-picker-day-2026-11-05').click();
    await expect.poll(() => read('Task')).toBe(ORIGINAL.replace('meet: 2026-11-21T09:15', 'meet: 2026-11-05T09:15'));
    // It stays open for the time.
    const time = picker.getByTestId('date-picker-time');
    await time.fill('25:00');
    await time.press('Enter');
    await expect(time).toHaveAttribute('aria-invalid', 'true');
    await time.fill('14:30');
    await time.press('Enter');
    await expect.poll(() => read('Task')).toBe(ORIGINAL.replace('meet: 2026-11-21T09:15', 'meet: 2026-11-05T14:30'));
    await page.keyboard.press('Escape');
    await expect(value(page, 'meet')).toHaveText(/^Nov 5, 2026, 2:30\sPM$/);
  });

  test('Today picks today; Clear empties the value as the native field did', async ({ page, vault }) => {
    await vault.seed([{ title: 'Anchor' }]);
    await openTask(page);
    await value(page, 'due').click();
    await page.getByTestId('date-picker-today').click();
    const now = new Date();
    const iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    await expect.poll(() => read('Task')).toBe(ORIGINAL.replace('due: 2026-11-21', `due: ${iso}`));
    await value(page, 'due').click();
    await page.getByTestId('date-picker-clear').click();
    // The same save the native field made when emptied: an empty value, the line kept.
    await expect.poll(() => read('Task')).toBe(ORIGINAL.replace('due: 2026-11-21', 'due:'));
  });

  test('a click outside closes it without writing', async ({ page, vault }) => {
    await vault.seed([{ title: 'Anchor' }]);
    await openTask(page);
    await value(page, 'due').click();
    await expect(page.getByTestId('date-picker')).toBeVisible();
    await page.mouse.click(5, 400);
    await expect(page.getByTestId('date-picker')).toHaveCount(0);
    expect(read('Task')).toBe(ORIGINAL);
  });
});
