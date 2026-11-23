import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { expectPageTitle } from './support/ui';

/**
 * #5nykir64 (a11y): while the slash, `[[` and `:` emoji menus are open, the
 * editor is a WAI-ARIA combobox: `aria-expanded`, `aria-controls` naming the
 * listbox, and `aria-activedescendant` following the keyboard's option. On
 * Esc or close every combobox attribute is gone again.
 */

const COMBOBOX_ATTRIBUTES = ['role', 'aria-expanded', 'aria-controls', 'aria-activedescendant', 'aria-autocomplete', 'aria-haspopup'];

async function expectCombobox(editor: Locator, menu: Locator): Promise<void> {
  await expect(menu).toBeVisible();
  const listboxId = await menu.getAttribute('id');
  expect(listboxId).toBeTruthy();
  await expect(editor).toHaveAttribute('role', 'combobox');
  await expect(editor).toHaveAttribute('aria-expanded', 'true');
  await expect(editor).toHaveAttribute('aria-controls', listboxId!);
  await expect(editor).toHaveAttribute('aria-autocomplete', 'list');
}

/** The editor's active descendant is the selected option, and it moves with ArrowDown. */
async function expectActiveFollowsKeyboard(page: Page, editor: Locator, menu: Locator): Promise<void> {
  const selected = menu.locator('[role="option"][aria-selected="true"]');
  const first = await selected.getAttribute('id');
  expect(first).toBeTruthy();
  await expect(editor).toHaveAttribute('aria-activedescendant', first!);
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => selected.getAttribute('id')).not.toBe(first);
  const second = await selected.getAttribute('id');
  await expect(editor).toHaveAttribute('aria-activedescendant', second!);
  // The id points at an option inside the listbox the editor controls.
  await expect(menu.locator(`[id="${second}"][role="option"]`)).toHaveCount(1);
}

async function expectCleared(editor: Locator): Promise<void> {
  for (const name of COMBOBOX_ATTRIBUTES) await expect(editor).not.toHaveAttribute(name, /.*/);
  // The editor's own label stays.
  await expect(editor).toHaveAttribute('aria-label', /.+/);
}

async function openNote(page: Page, vault: { seed: (pages: Array<{ title: string; content: string }>) => Promise<Array<{ id: string }>> }) {
  const [note] = await vault.seed([{ title: 'Note', content: '' }, { title: 'Alpha', content: 'a' }, { title: 'Beta', content: 'b' }]);
  await page.goto(`/#/${encodeURIComponent(note!.id)}`);
  await expectPageTitle(page, 'Note');
  const editor = page.getByTestId('editor').getByTestId('editor-content');
  await editor.click();
  return editor;
}

test('the slash menu: combobox while open, active option follows the keyboard, cleared on Esc', async ({ page, vault }) => {
  const editor = await openNote(page, vault);
  await expectCleared(editor);
  await page.keyboard.type('/');
  const menu = page.getByTestId('slash-menu');
  await expectCombobox(editor, menu);
  await expectActiveFollowsKeyboard(page, editor, menu);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expectCleared(editor);
});

test('the [[ menu: combobox while open, active option follows the keyboard, cleared when a link is picked', async ({ page, vault }) => {
  const editor = await openNote(page, vault);
  await page.keyboard.type('[[');
  const menu = page.getByTestId('link-menu');
  await expectCombobox(editor, menu);
  await expectActiveFollowsKeyboard(page, editor, menu);
  await page.keyboard.press('Enter');
  await expect(menu).toHaveCount(0);
  await expectCleared(editor);
});

test('the : emoji menu: combobox while open, active option follows the keyboard, cleared on Esc', async ({ page, vault }) => {
  const editor = await openNote(page, vault);
  await page.keyboard.type('Launch :smi');
  const menu = page.getByTestId('emoji-menu');
  await expectCombobox(editor, menu);
  await expectActiveFollowsKeyboard(page, editor, menu);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expectCleared(editor);
});
