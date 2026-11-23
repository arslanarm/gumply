import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { API_URL } from './support/env';
import { expectPageTitle } from './support/ui';

/**
 * #vefk9dwg (a11y audit `ux/a11y-audit-v0-9` P2 1–3): every modal dialog
 * takes focus when it opens, keeps Tab and Shift+Tab inside while open, and
 * gives focus back to what opened it on Escape. One test per dialog family.
 */

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/** Tab `times` (forwards, then the same backwards): focus never leaves `dialog`. */
async function expectTabStaysIn(page: Page, dialog: Locator, times = 12) {
  await expect.poll(() => dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  for (const key of ['Tab', 'Shift+Tab']) {
    for (let i = 0; i < times; i++) {
      await page.keyboard.press(key);
      const inside = await dialog.evaluate((el) => el.contains(document.activeElement));
      expect(inside, `${key} #${i + 1} left the dialog`).toBe(true);
    }
  }
}

/** The element that has focus is `locator` (or inside it). */
async function expectFocusIn(locator: Locator) {
  await expect.poll(() => locator.evaluate((el) => el === document.activeElement || el.contains(document.activeElement))).toBe(true);
}

async function openNote(page: Page, vault: { seed: (pages: { title: string; content?: string }[]) => Promise<{ id: string }[]> }) {
  const [note] = await vault.seed([{ title: 'Note', content: 'Some text here.' }]);
  await page.goto(`/#/${encodeURIComponent(note!.id)}`);
  await expectPageTitle(page, 'Note');
  return note!;
}

/** Click into the editor, so that is where focus should come back to. */
async function focusEditor(page: Page) {
  await page.getByTestId('editor-content').getByText('Some text here.').click();
}

async function fromCmdK(page: Page, query: string, testId: string) {
  await page.keyboard.press(`${MOD}+k`);
  await page.keyboard.type(query);
  await page.getByTestId(testId).click();
}

test('Export HTML and PDF (Cmd+K): focus inside, Tab kept in, Esc back to the editor', async ({ page, vault }) => {
  await openNote(page, vault);
  for (const [query, row] of [['html', 'search-export-html'], ['pdf', 'search-export-pdf']] as const) {
    await focusEditor(page);
    await fromCmdK(page, query, row);
    const dialog = page.getByTestId('export-dialog');
    await expectTabStaysIn(page, dialog);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expectFocusIn(page.getByTestId('editor-content'));
  }
});

test('Notion import (Cmd+K): focus moves into the dialog on open', async ({ page, vault }) => {
  await openNote(page, vault);
  await focusEditor(page);
  await fromCmdK(page, 'import notion', 'search-import-notion');
  const dialog = page.getByTestId('notion-import');
  await expectTabStaysIn(page, dialog);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expectFocusIn(page.getByTestId('editor-content'));
});

test('History… from the page menu (keyboard only): Esc returns to the ⋯ button', async ({ page, vault, request }) => {
  const note = await openNote(page, vault);
  await request.put(`${API_URL}/api/pages/${encodeURIComponent(note.id)}`, { data: { content: 'Some text here, edited.' } });
  const menuButton = page.getByTestId(`page-menu-button-${note.id}`);
  await page.getByTestId(`page-item-${note.id}`).hover();
  await menuButton.focus();
  await page.keyboard.press('Enter');
  await page.getByTestId(`page-history-${note.id}`).focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByTestId('history-dialog');
  await expectTabStaysIn(page, dialog);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expectFocusIn(menuButton);
});

test('Settings popover, AI apps and Version history: Esc returns to the Settings button', async ({ page, vault }) => {
  await openNote(page, vault);
  const settings = page.getByTestId('settings-button');

  // The popover (not modal): focus moves in, Esc gives it back.
  await settings.focus();
  await page.keyboard.press('Enter');
  await expectFocusIn(page.getByTestId('settings-popover'));
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('settings-popover')).toHaveCount(0);
  await expectFocusIn(settings);

  for (const [item, testId] of [['settings-mcp', 'mcp-settings'], ['settings-history', 'history-settings']] as const) {
    await settings.focus();
    await page.keyboard.press('Enter');
    await page.getByTestId(item).focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByTestId(testId);
    await expectTabStaysIn(page, dialog);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expectFocusIn(settings);
  }
});

test('AI apps → raising access asks to confirm: the confirmation keeps Tab, Esc returns into AI apps', async ({ page, vault }) => {
  await openNote(page, vault);
  await page.getByTestId('settings-button').click();
  await page.getByTestId('settings-mcp').click();
  const settings = page.getByTestId('mcp-settings');
  await expect(page.getByTestId('mcp-access-read')).toBeChecked();
  await page.getByTestId('mcp-access-edit').click();
  const confirm = page.getByTestId('mcp-raise');
  await expect(confirm).toBeVisible();
  await expectTabStaysIn(page, confirm, 4);
  // Escape is the confirmation's Cancel; AI apps stays open, and focus is back in it.
  await page.keyboard.press('Escape');
  await expect(confirm).toHaveCount(0);
  await expect(settings).toBeVisible();
  await expectFocusIn(settings);
  await expectTabStaysIn(page, settings, 6);
});

test('Delete forever (Trash): the confirmation keeps Tab, Esc returns to its button', async ({ page, vault, request }) => {
  const [gone] = await vault.seed([{ title: 'Gone', content: 'Bye.' }]);
  await request.delete(`${API_URL}/api/pages/${encodeURIComponent(gone!.id)}`);
  await page.goto('/#trash');
  const row = page.getByTestId('trash-item-Gone');
  await row.hover();
  const button = row.getByTestId('trash-delete-forever');
  await button.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByTestId('trash-confirm-dialog');
  await expectTabStaysIn(page, dialog, 4);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expectFocusIn(button);
});

test('Keyboard shortcuts (?): Tab kept in, Esc returns to the shortcuts button', async ({ page, vault }) => {
  await openNote(page, vault);
  const button = page.getByTestId('shortcuts-button');
  await button.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByTestId('shortcuts-dialog');
  await expectTabStaysIn(page, dialog, 4);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expectFocusIn(button);
});

test('Palettes (Cmd+K, Move to…): Tab stays on the input, Esc gives focus back', async ({ page, vault }) => {
  const note = await openNote(page, vault);
  await focusEditor(page);
  await page.keyboard.press(`${MOD}+k`);
  const input = page.getByTestId('quick-switcher-input');
  await expectFocusIn(input);
  await page.keyboard.press('Tab');
  await expectFocusIn(input);
  await page.keyboard.press('Escape');
  await expect(input).toHaveCount(0);
  await expectFocusIn(page.getByTestId('editor-content'));

  const menuButton = page.getByTestId(`page-menu-button-${note.id}`);
  await page.getByTestId(`page-item-${note.id}`).hover();
  await menuButton.focus();
  await page.keyboard.press('Enter');
  await page.getByTestId(`move-page-${note.id}`).focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByTestId('move-dialog');
  await expect(dialog).toBeVisible();
  await expectTabStaysIn(page, dialog, 3);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  // The ⋯ menu hands focus to its page's row when an item is picked; focus is back on that row.
  await expectFocusIn(page.getByRole('treeitem').filter({ has: page.getByTestId(`page-item-${note.id}`) }).or(page.getByTestId(`page-item-${note.id}`)).first());
});

/**
 * `inert` hides content from assistive tech too: live regions (toasts, the
 * save status) must stay in the accessibility tree while a modal is open,
 * and the rest of the page must not. Read from Chrome's accessibility tree.
 */
async function exposedTexts(page: Page): Promise<string> {
  const cdp = await page.context().newCDPSession(page);
  const { nodes } = (await cdp.send('Accessibility.getFullAXTree')) as { nodes: { ignored?: boolean; name?: { value?: string } }[] };
  await cdp.detach();
  return nodes.filter((node) => !node.ignored).map((node) => node.name?.value ?? '').join('\n');
}

test('a toast showing when a modal opens, and a status raised while it is open, stay announced', async ({ page, vault }) => {
  const [, other] = await vault.seed([{ title: 'Note', content: 'Some text here.' }, { title: 'Old draft', content: 'Draft text.' }]);
  await page.goto(`/#/${encodeURIComponent(other!.id)}`);
  await expectPageTitle(page, 'Old draft');
  await page.getByTestId('delete-page-button-page').click();
  if (await page.getByTestId('delete-confirm').isVisible().catch(() => false)) await page.getByTestId('delete-confirm').click();
  await expect(page.getByTestId('undo-toast')).toContainText('Page deleted');

  await page.keyboard.press(`${MOD}+k`);
  await page.keyboard.type('html');
  await page.getByTestId('search-export-html').click();
  await expect(page.getByTestId('export-dialog')).toBeVisible();
  await expect(page.getByTestId('undo-toast')).toBeVisible();

  // The dialog and the toast are exposed; the sidebar behind the dialog isn't.
  await expect.poll(() => exposedTexts(page)).toContain('Export as HTML');
  const exposed = await exposedTexts(page);
  expect(exposed).toContain('Page deleted');
  expect(exposed).not.toContain('New whiteboard');

  // A status that appears inside the inert page while the dialog is open is exposed too.
  await page.evaluate(() => {
    const status = document.createElement('div');
    status.setAttribute('role', 'status');
    status.textContent = 'Raised while the dialog is open';
    document.querySelector('.topbar')!.appendChild(status);
  });
  await expect.poll(() => exposedTexts(page)).toContain('Raised while the dialog is open');
  expect(await exposedTexts(page)).not.toContain('New whiteboard');

  // Closing the dialog gives the whole page back.
  await page.keyboard.press('Escape');
  await expect.poll(() => exposedTexts(page)).toContain('New whiteboard');
});

test('Conflict Compare (from the banner): Tab kept in, Esc returns to Compare', async ({ page, vault, request }) => {
  const { writeFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const { E2E_VAULT } = await import('./support/env');
  const [note] = await vault.seed([{ title: 'Note', content: 'Mine.' }]);
  const copy = 'Note.sync-conflict-20261122-143005-ABCDEFG';
  await writeFile(path.join(E2E_VAULT, `${copy}.md`), 'Theirs.\n', 'utf8');
  await expect
    .poll(async () => ((await (await request.get(`${API_URL}/api/pages`)).json()) as { id: string }[]).some((meta) => meta.id === copy), { timeout: 10_000 })
    .toBe(true);
  await page.goto(`/#/${encodeURIComponent(note!.id)}`);
  const compare = page.getByTestId('conflict-banner').getByTestId('conflict-banner-compare');
  await compare.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByTestId('conflict-compare');
  await expectTabStaysIn(page, dialog);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expectFocusIn(compare);
});

test('Settings → Updates (desktop): Tab kept in, Esc returns to the Settings button', async ({ page, vault }) => {
  await page.route('**/api/health', async (route) => {
    try {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...(await response.json()), desktop: true } });
    } catch {
      // The page closed while the request was in flight.
    }
  });
  await page.route('**/api/desktop/updates**', (route) =>
    route.fulfill({ json: { kind: 'nsis', mode: 'auto', modes: ['auto', 'notify', 'off'], status: 'idle', currentVersion: '0.9.0', version: null, releaseUrl: null, lastChecked: null, error: null } }),
  );
  await openNote(page, vault);
  const settings = page.getByTestId('settings-button');
  await settings.focus();
  await page.keyboard.press('Enter');
  await page.getByTestId('settings-updates').focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByTestId('updates-settings');
  await expectTabStaysIn(page, dialog);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expectFocusIn(settings);
});

test('Settings → startup page picker (#if236h9k): Tab stays on the input, Esc gives focus back to Settings', async ({ page, vault }) => {
  await openNote(page, vault);
  const settings = page.getByTestId('settings-button');
  await settings.focus();
  await page.keyboard.press('Enter');
  // Choosing "A page I choose" with no page chosen yet opens the picker.
  await page.getByTestId('settings-startup').selectOption('page');
  const picker = page.getByTestId('page-picker');
  await expect(picker).toBeVisible();
  const input = page.getByTestId('page-picker-input');
  await expectFocusIn(input);
  await page.keyboard.press('Tab');
  await expectFocusIn(input);
  await page.keyboard.press('Shift+Tab');
  await expectFocusIn(input);
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
  // The popover closed when the picker opened, so focus goes back to the Settings button (as for AI apps).
  await expectFocusIn(settings);

  // The same from the "Choose…" button.
  await page.keyboard.press('Enter');
  await page.getByTestId('settings-startup-choose').focus();
  await page.keyboard.press('Enter');
  await expectFocusIn(input);
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
  await expectFocusIn(settings);
});
