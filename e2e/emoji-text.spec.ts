import type { Page } from '@playwright/test';
import { api, expect, test } from './fixtures';

/** #6v8tyxfd: emoji in text — `:roc…` suggestions and `/emoji` picker. */

async function openAtEnd(page: Page, text: string) {
  const body = page.getByTestId('editor-content');
  await body.getByText(text, { exact: true }).click();
  await page.keyboard.press('End');
  return body;
}

async function waitSaved(page: Page) {
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', {
    timeout: 10_000,
  });
}

test(':rocket + Enter inserts 🚀 as plain Unicode; 12:30 stays text', async ({
  page,
  vault,
  request,
}) => {
  const [created] = await vault.seed([{ title: 'Launch', content: 'Intro' }]);
  await page.goto('/');
  const body = await openAtEnd(page, 'Intro');

  await page.keyboard.press('Enter');
  await page.keyboard.type('Meet at 12:30 then launch :rocket');
  const menu = page.getByTestId('emoji-menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('option').first()).toContainText('🚀');
  await page.keyboard.press('Enter');
  await expect(menu).toHaveCount(0);
  await expect(body).toContainText('Meet at 12:30 then launch 🚀');

  await waitSaved(page);
  expect((await api.getPage(request, created!.id)).content).toBe(
    'Intro\n\nMeet at 12:30 then launch 🚀',
  );
  await page.reload();
  await expect(page.getByTestId('editor-content')).toContainText('Meet at 12:30 then launch 🚀');
});

test('no suggestions after digits/letters or in code; Esc keeps the typed text', async ({
  page,
  vault,
}) => {
  await vault.seed([{ title: 'Rules', content: 'Intro' }]);
  await page.goto('/');
  const body = await openAtEnd(page, 'Intro');
  const menu = page.getByTestId('emoji-menu');

  await page.keyboard.type(' 10:30 http://example.com key:value');
  await expect(menu).toHaveCount(0);

  await page.keyboard.type(' `x :smile');
  await expect(menu).toHaveCount(0);
  await page.keyboard.type('`');

  await page.keyboard.type(' :smile');
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await page.keyboard.type('y');
  await expect(menu).toHaveCount(0);
  await expect(body).toContainText(':smiley');
});

test('/emoji opens the full picker and inserts at the caret', async ({ page, vault, request }) => {
  const [created] = await vault.seed([{ title: 'Picker', content: 'Party' }]);
  await page.goto('/');
  const body = await openAtEnd(page, 'Party');

  await page.keyboard.type(' /emoji');
  await expect(page.getByTestId('slash-menu-item-emoji')).toBeVisible();
  await page.keyboard.press('Enter');
  const picker = page.getByTestId('editor-emoji-picker');
  await expect(picker).toBeVisible();
  await page.keyboard.type('tada');
  await expect(picker.getByRole('option', { name: 'party popper' })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(picker).toHaveCount(0);
  await expect(body).toContainText('Party 🎉');

  await waitSaved(page);
  expect((await api.getPage(request, created!.id)).content).toBe('Party 🎉');
});
