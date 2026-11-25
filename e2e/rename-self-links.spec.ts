import { readFileSync } from 'node:fs';
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
  // Straight into the body, before the rename's answer has come back: on the last line (not the links' line).
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(' Typed.');
  await expectPageTitle(page, 'Moved');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 });

  const file = path.join(E2E_VAULT, 'Moved.md');
  await expect
    .poll(() => body(readFileSync(file, 'utf8')).replace(/^\n/, ''), { timeout: 10_000 })
    .toBe('Me: [[Moved]] and [[Moved#Part|part]].\n\n## Part\n\nText. Typed.\n');
  expect(states).not.toContain('conflict');
  // The editor shows the new self-link, not the old one.
  await expect(page.getByTestId('editor-content')).not.toContainText('Parent');
});
