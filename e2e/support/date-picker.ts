import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Picks `iso` (`YYYY-MM-DD`) in the app's date picker (#93wnicas): opens it
 * from `scope`'s value button when it isn't open yet, steps to the month,
 * clicks the day.
 */
export async function pickDate(page: Page, scope: Locator, iso: string): Promise<void> {
  const picker = page.getByTestId('date-picker');
  if (!(await picker.isVisible())) await scope.getByTestId('date-picker-value').click();
  await expect(picker).toBeVisible();
  const [year, month] = iso.split('-').map(Number) as [number, number];
  const first = await picker.locator('.date-picker-day:not(.is-outside)').first().getAttribute('data-testid');
  const [shownYear, shownMonth] = first!.replace('date-picker-day-', '').split('-').map(Number) as [number, number];
  const steps = (year - shownYear) * 12 + (month - shownMonth);
  const nav = picker.locator('.date-picker-nav').nth(steps < 0 ? 0 : 1);
  for (let i = 0; i < Math.abs(steps); i++) await nav.click();
  await picker.getByTestId(`date-picker-day-${iso}`).click();
}
