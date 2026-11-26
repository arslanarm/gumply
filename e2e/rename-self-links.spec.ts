import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures';
import { E2E_VAULT } from './support/env';
import { expectPageTitle } from './support/ui';

/**
 * #h7j39kka: renaming a page from its title rewrites its own self-links too (`[[Old]]`,
 * `[[Old#H|x]]`), as Obsidian does, and typing straight after the rename keeps both: the new links
 * and the typed text, with no "changed on disk" (the rename's own rewrite merges, N10).
 */
const body = (raw: string) => (raw.startsWith('---\n') ? raw.slice(raw.indexOf('\n---\n', 4) + 5) : raw);

test('renaming from the title rewrites the page\'s self-links, and typing right after keeps both', async ({ page, vault }) => {
  await vault.seed([{ title: 'Parent', content: 'Me: [[Parent]] and [[Parent#Part|part]].\n\n## Part\n\nText.\n' }]);
  await page.goto('/#/Parent');
  await expectPageTitle(page, 'Parent');
  const states: string[] = [];
  await page.exposeFunction('__selfLinkSaveState', (state: string) => states.push(state));
  await page.evaluate(() => {
    new MutationObserver(() => {
      const state = document.querySelector('[data-testid="save-status"]')?.getAttribute('data-state');
      if (state) (window as unknown as { __selfLinkSaveState: (s: string) => void }).__selfLinkSaveState(state);
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ['data-state'] });
  });

  await page.getByTestId('page-title').click();
  const title = page.getByTestId('page-title-input');
  await expect(title).toBeFocused();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Moved');
  await page.keyboard.press('Enter');
  await expectPageTitle(page, 'Moved');
  // After the rename's answer and the editor's reload of the rewritten self-links, never in the reload's own
  // instant (keys typed then may not reach any editor: #ekp8ns58's known limit). On the last line, not the links'.
  await expect(page.getByTestId('editor-content')).not.toContainText('Parent', { timeout: 10_000 });
  await page.getByTestId('editor-content').getByText('Text.').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(' Typed.');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 });

  const file = path.join(E2E_VAULT, 'Moved.md');
  await expect
    .poll(() => body(readFileSync(file, 'utf8')).replace(/^\n/, ''), { timeout: 10_000 })
    .toBe('Me: [[Moved]] and [[Moved#Part|part]].\n\n## Part\n\nText. Typed.\n');
  expect(states).not.toContain('conflict');
  // The editor shows the new self-link, not the old one.
  await expect(page.getByTestId('editor-content')).not.toContainText('Parent');
});

test('typing during the rename of a page with only self-links is taken in place (#h7j39kka, #z9hufufn): the typed text and [[Moved]] in the file, no remount, no notice', async ({ page, vault }) => {
  // No Parent/ folder: only the self-link makes the rename rewrite the page's own text.
  await vault.seed([{ title: 'Parent', content: 'Me: [[Parent]] here.\n' }]);
  // The title PUT is held for 2 s, so there is time to type while it runs.
  await page.route(
    (url) => url.pathname === '/api/pages/Parent',
    async (route) => {
      const sent = route.request();
      if (sent.method() === 'PUT' && (sent.postDataJSON() as { title?: string } | null)?.title !== undefined) await new Promise((resolve) => setTimeout(resolve, 2_000));
      await route.continue();
    },
  );
  await page.goto('/#/Parent');
  await expectPageTitle(page, 'Parent');
  // Counts editor mounts from now on: the in-place apply never remounts.
  await page.evaluate(() => {
    const w = window as unknown as { __mounts: number };
    w.__mounts = 0;
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          if (node instanceof Element && (node.matches('[data-testid="editor-content"]') || node.querySelector('[data-testid="editor-content"]'))) w.__mounts += 1;
    }).observe(document.body, { childList: true, subtree: true });
  });
  await page.getByTestId('page-title').click();
  const input = page.getByTestId('page-title-input');
  await input.fill('Moved');
  await input.press('Enter');
  await page.getByTestId('editor-content').getByText('here.').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Typed during.');
  await expect(page).toHaveURL(/#\/Moved$/, { timeout: 15_000 });
  await page.keyboard.type(' Just after.');
  const file = path.join(E2E_VAULT, 'Moved.md');
  await expect.poll(() => { try { return readFileSync(file, 'utf8'); } catch { return ''; } }, { timeout: 15_000 }).toContain('Just after.');
  const text = readFileSync(file, 'utf8');
  expect(text).toContain('Me: [[Moved]] here. Typed during. Just after.');
  expect(text).not.toContain('[[Parent]]');
  expect(existsSync(path.join(E2E_VAULT, 'Parent.md')), 'no old file left').toBe(false);
  expect(await page.evaluate(() => (window as unknown as { __mounts: number }).__mounts), 'never remounted').toBe(0);
  await expect(page.getByTestId('undo-toast').filter({ hasText: 'Your typing during the rename' })).toHaveCount(0);
  // Undo the typing: the rename's change was kept out of the undo history.
  for (let i = 0; i < 6; i++) await page.keyboard.press('ControlOrMeta+z');
  await page.waitForTimeout(2_000);
  expect(readFileSync(file, 'utf8')).toContain('[[Moved]]');
  expect(readFileSync(file, 'utf8')).not.toContain('[[Parent]]');
});
