import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * v0.7 C (#5hrsrqsj): Ctrl/Cmd+Shift+D opens today's note. Browsers use the
 * same keys for "bookmark all tabs", so this runs in Chromium **and** Firefox
 * (see the firefox project in playwright.config.ts) and checks the app's
 * handler wins: the event is cancelled and today's note opens.
 */

const pad = (value: number) => String(value).padStart(2, '0');

test('Ctrl/Cmd+Shift+D opens today\'s note, also while typing, and the browser default is prevented', async ({ page, vault }) => {
  await vault.seed([{ title: 'Inbox', content: 'Start' }]);
  await page.goto('/#/Inbox');
  const body = page.getByTestId('editor-content');
  await body.getByText('Start', { exact: true }).click();
  await page.evaluate(() => {
    (window as unknown as { __shortcut: boolean | null }).__shortcut = null;
    window.addEventListener('keydown', (event) => {
      if (event.shiftKey && event.key.toLowerCase() === 'd') {
        // Read after the app's handler ran (this listener was added later).
        (window as unknown as { __shortcut: boolean }).__shortcut = event.defaultPrevented;
      }
    });
  });
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.press(`${modifier}+Shift+D`);
  const today = new Date();
  const day = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  await expect(page).toHaveURL(new RegExp(`#/Daily/${day}$`));
  expect(await page.evaluate(() => (window as unknown as { __shortcut: boolean | null }).__shortcut)).toBe(true);
  await expect(fs.access(path.join(E2E_VAULT, 'Daily', `${day}.md`))).resolves.toBeUndefined();
});
