import { test, expect } from './fixtures';
import { API_URL } from './support/env';
import { expectPageTitle } from './support/ui';

const MOD_LABEL = process.platform === 'darwin' ? '⌘K' : 'CtrlK';

/**
 * Shortcuts overlay (`?`) and F2 rename — the `#qdxxmxyv` / `#jk9wn6ks` surface.
 * Copy comes from `lib/shortcuts.ts` (spec/ux §9); only working shortcuts are
 * listed there.
 */
test.describe('keyboard shortcuts', () => {
  test('? opens the help overlay, lists the groups, and Esc closes it with focus restored', async ({
    page,
    vault,
  }) => {
    const [alpha] = await vault.seed([{ title: 'Alpha' }]);

    await page.goto('/');
    const row = page.getByTestId(`page-item-${alpha.id}`);
    await row.click();
    await expect(row).toBeFocused();

    await page.keyboard.press('Shift+Slash');
    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('shortcuts-close')).toBeFocused();

    await expect(dialog).toContainText('Navigate');
    await expect(dialog).toContainText(MOD_LABEL);
    await expect(dialog).toContainText('Search pages');
    await expect(dialog).toContainText('Editor');
    await expect(dialog).toContainText('Insert a block');
    await expect(dialog).toContainText('Link a page');
    await expect(dialog).toContainText('Pages');
    await expect(dialog).toContainText('F2 / double-click');
    await expect(dialog).toContainText('Rename page');

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    // Focus returns to whatever opened it (the sidebar row here).
    await expect(row).toBeFocused();
  });

  test('the ? button opens it, and typing ? in the editor does not', async ({ page, vault }) => {
    await vault.seed([{ title: 'Notes' }]);

    await page.goto('/');
    await page.getByTestId('shortcuts-button').click();
    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(dialog).toBeVisible();
    await page.getByTestId('shortcuts-close').click();
    await expect(dialog).toHaveCount(0);

    // `?` while typing is literal text, not the overlay shortcut.
    const editor = page.getByTestId('editor-content');
    await expect(editor).toBeVisible();
    await editor.click();
    await page.keyboard.type('?');
    await expect(dialog).toHaveCount(0);
    await expect(editor).toContainText('?');
  });

  test('F2 renames the focused sidebar row; Esc cancels', async ({ page, vault, request }) => {
    const [, beta] = await vault.seed([{ title: 'Alpha' }, { title: 'Beta' }]);

    await page.goto('/');
    await expectPageTitle(page, 'Alpha');

    const row = page.getByTestId(`page-item-${beta.id}`);
    await row.click();
    await expect(row).toBeFocused();

    await page.keyboard.press('F2');
    const input = page.getByTestId(`page-rename-input-${beta.id}`);
    await expect(input).toBeVisible();
    await expect(input).toHaveValue('Beta');

    // Esc leaves the title untouched.
    await input.fill('Nope');
    await page.keyboard.press('Escape');
    await expect(row).toContainText('Beta');

    // Cancelling unmounts the input; focus the row again before F2.
    await row.click();
    await expect(row).toBeFocused();
    await page.keyboard.press('F2');
    await input.fill('Beta renamed');
    await page.keyboard.press('Enter');
    await expect(row).toContainText('Beta renamed');

    const saved = await (
      await request.get(`${API_URL}/api/pages/${encodeURIComponent(beta.id)}`)
    ).json();
    expect(saved.title).toBe('Beta renamed');
  });
});
