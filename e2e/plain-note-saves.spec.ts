import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures';
import { E2E_VAULT } from './support/env';
import { expectPageTitle } from './support/ui';

/**
 * #d5e4mawv: a plain note (no frontmatter, as Obsidian writes it) takes two
 * edits in a row without a false "changed on disk", every time.
 * #m6ppcam2: a slow page-list poll racing our save never remounts the editor.
 */
test.describe('our own saves are never "changed on disk"', () => {
  test('a plain note: edit, saved, edit again → both saved, never a conflict (x8)', async ({ page, vault }) => {
    test.setTimeout(120_000);
    const states: string[] = [];
    await page.exposeFunction('__saveState', (state: string) => states.push(state));
    await page.addInitScript(() => {
      new MutationObserver(() => {
        const state = document.querySelector('[data-testid="save-status"]')?.getAttribute('data-state');
        if (state) (window as unknown as { __saveState: (s: string) => void }).__saveState(state);
      }).observe(document, { subtree: true, attributes: true, attributeFilter: ['data-state'] });
    });
    await vault.seed([{ title: 'Anchor' }]);

    for (let round = 0; round < 8; round += 1) {
      const name = `Plain ${round}`;
      const file = path.join(E2E_VAULT, `${name}.md`);
      writeFileSync(file, 'Line one.\n\nLine two.\n');
      // The watcher and the 2 s poll pick it up.
      await expect(page.getByTestId(`page-item-${name}`)).toBeVisible({ timeout: 6_000 }).catch(async () => {
        await page.goto('/');
        await expect(page.getByTestId(`page-item-${name}`)).toBeVisible();
      });
      await page.getByTestId(`page-item-${name}`).click();
      await expectPageTitle(page, name);
      const body = page.getByTestId('editor-content');

      await body.getByText('Line one.', { exact: true }).click();
      await page.keyboard.press('End');
      await page.keyboard.type(' A');
      await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
      await page.waitForTimeout(1_000 + (round % 4) * 300);
      await body.getByText('Line two.', { exact: true }).click();
      await page.keyboard.press('End');
      await page.keyboard.type(' B');
      await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', /saved|conflict/);
      expect(states, `round ${round}`).not.toContain('conflict');
      expect(readFileSync(file, 'utf8'), `round ${round}`).toBe('Line one. A\n\nLine two. B\n');
    }
  });

  test('a slow page-list poll that started before our save never reloads the editor', async ({ page, vault }) => {
    const [seeded] = await vault.seed([{ title: 'Steady', content: 'Hello' }]);
    // Hold every page-list response for 1.5 s (a busy machine).
    await page.route('**/api/pages', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const response = await route.fetch();
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      // #mxtuk2z7: a poll still held when the test ends outlives its page (the context closes
      // and disposes the fetched response); there's nothing left to answer.
      if (page.isClosed()) return;
      await route.fulfill({ response });
    });
    await page.goto(`/#/${seeded.id}`);
    await expectPageTitle(page, 'Steady');
    const body = page.getByTestId('editor-content');
    await body.getByText('Hello', { exact: true }).click();
    await page.keyboard.press('End');
    await page.evaluate(() => {
      (window as unknown as { __editorNode?: Element | null }).__editorNode = document.querySelector('.ProseMirror');
    });

    for (const word of [' one', ' two', ' three']) {
      await page.keyboard.type(word);
      await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
      // Long enough for several delayed polls to land after the save.
      await page.waitForTimeout(2_500);
    }
    const same = await page.evaluate(
      () => (window as unknown as { __editorNode?: Element | null }).__editorNode === document.querySelector('.ProseMirror'),
    );
    expect(same).toBe(true);
    // The caret stayed at the end and undo still has the typing.
    await page.keyboard.type('!');
    await expect(body).toContainText('Hello one two three!');
    await page.keyboard.press('Control+z');
    await expect(body).not.toContainText('three!');
    // #mxtuk2z7: drop the held polls before teardown, so none answers after the context closes.
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });
});
