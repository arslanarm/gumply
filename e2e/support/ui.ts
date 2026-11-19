import { expect, type Page } from '@playwright/test';

/**
 * The page title is rendered either as a read-only heading (`page-title`) or as
 * an always-editable input (`page-title-input`) depending on the milestone/UX
 * state. Tests shouldn't care which, so assert on whichever is in the DOM.
 */
export async function expectPageTitle(page: Page, title: string): Promise<void> {
  const heading = page.getByTestId('page-title');
  const input = page.getByTestId('page-title-input');

  await expect(heading.or(input).first()).toBeVisible();
  if ((await input.count()) > 0) {
    await expect(input).toHaveValue(title);
  } else {
    await expect(heading).toHaveText(title);
  }
}
