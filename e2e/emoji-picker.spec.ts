import { test, expect, api } from './fixtures';
import { expectPageTitle } from './support/ui';

/**
 * Page-icon emoji picker (#dsc8skxj): the full emoji set with search,
 * categories, Recent, Random/Remove and paste-any-emoji.
 */
test.describe('page icon emoji picker', () => {
  test('searches by name and sets the icon on disk', async ({ page, vault, request }) => {
    const [doc] = await vault.seed([{ title: 'Launch plan', content: 'Body' }]);
    await page.goto(`/#/${doc!.id}`);
    await expectPageTitle(page, 'Launch plan');

    await page.getByTestId('page-title').hover();
    await page.getByTestId('page-icon-button').click();
    const picker = page.getByTestId('page-icon-picker');
    await expect(picker).toBeVisible();
    // Opens with focus in the search box and the full set by category.
    await expect(page.getByTestId('emoji-search')).toBeFocused();
    await expect(picker.locator('.emoji-picker-cell').first()).toBeVisible();
    expect(await picker.locator('.emoji-picker-cell').count()).toBeGreaterThan(1500);
    await expect(picker.getByRole('heading', { name: 'Animals & nature' })).toBeAttached();

    await page.keyboard.type('rocket');
    await expect(picker.locator('.emoji-picker-cell').first()).toHaveAttribute('data-emoji', '🚀');
    await expect(picker.locator('.emoji-picker-preview-name')).toHaveText('rocket');
    await page.keyboard.press('Enter');

    await expect(picker).toBeHidden();
    await expect(page.locator('.page-icon-large')).toHaveText('🚀');
    await expect.poll(async () => (await api.getPage(request, doc!.id)).icon).toBe('🚀');
  });

  test('shows Recent, navigates with arrows, and removes the icon', async ({ page, vault, request }) => {
    const [doc] = await vault.seed([{ title: 'Ideas', content: 'Body', icon: '💡' }]);
    await page.goto(`/#/${doc!.id}`);
    await expectPageTitle(page, 'Ideas');

    // Pick 🎉 via search so it lands in Recent.
    await page.getByTestId('page-icon-button').click();
    await page.keyboard.type('tada');
    await expect(page.locator('.emoji-picker-cell.is-active')).toHaveAttribute('data-emoji', '🎉');
    await page.keyboard.press('Enter');
    await expect(page.locator('.page-icon-large')).toHaveText('🎉');

    await page.getByTestId('page-icon-button').click();
    const picker = page.getByTestId('page-icon-picker');
    await expect(picker.getByRole('heading', { name: 'Recent' })).toBeVisible();
    const recentFirst = picker.locator('[data-section="recent"] .emoji-picker-cell').first();
    await expect(recentFirst).toHaveAttribute('data-emoji', '🎉');

    // Arrow keys move a visible highlight; Enter picks it.
    await page.keyboard.press('ArrowDown');
    await expect(recentFirst).toHaveClass(/is-active/);
    await page.keyboard.press('ArrowDown');
    const active = picker.locator('.emoji-picker-cell.is-active');
    const chosen = await active.getAttribute('data-emoji');
    expect(chosen).toBeTruthy();
    expect(chosen).not.toBe('🎉');
    await page.keyboard.press('Enter');
    await expect(page.locator('.page-icon-large')).toHaveText(chosen!);

    // Remove clears the icon on disk.
    await page.getByTestId('page-icon-button').click();
    await picker.getByTestId('emoji-remove').click();
    await expect(page.locator('.page-icon-large')).toHaveCount(0);
    await expect.poll(async () => (await api.getPage(request, doc!.id)).icon ?? null).toBeNull();
  });

  test('category bar jumps, Escape clears then closes, paste sets any emoji', async ({
    page,
    vault,
    request,
  }) => {
    const [doc] = await vault.seed([{ title: 'Trip', content: 'Body' }]);
    await page.goto(`/#/${doc!.id}`);
    await expectPageTitle(page, 'Trip');

    await page.getByTestId('page-title').hover();
    await page.getByTestId('page-icon-button').click();
    const picker = page.getByTestId('page-icon-picker');

    // Wait until the list (and the enabled category bar) is in, so the click
    // doesn't race the lazy data load.
    await expect(picker.locator('[data-section="smileys"] .emoji-picker-cell').first()).toBeVisible();
    await expect(picker.getByRole('button', { name: 'Flags' })).toBeEnabled();
    await picker.getByRole('button', { name: 'Flags' }).click();
    await expect(picker.getByRole('heading', { name: 'Flags' })).toBeInViewport();
    await expect(picker.getByRole('button', { name: 'Flags' })).toHaveClass(/is-active/);

    await page.keyboard.type('zzqqxx');
    await expect(picker.getByTestId('emoji-empty')).toHaveText('No emoji match “zzqqxx”.');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('emoji-search')).toHaveValue('');
    await expect(picker).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(picker).toBeHidden();
    await expect(page.getByTestId('page-icon-button')).toBeFocused();

    // Paste an emoji with a skin tone (not in the grid) straight into search.
    await page.getByTestId('page-icon-button').click();
    await page.getByTestId('emoji-search').evaluate((input) => {
      const data = new DataTransfer();
      data.setData('text/plain', '👩🏽‍🚀');
      input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await expect(page.locator('.page-icon-large')).toHaveText('👩🏽‍🚀');
    await expect.poll(async () => (await api.getPage(request, doc!.id)).icon).toBe('👩🏽‍🚀');
  });

  test('Random picks some emoji', async ({ page, vault, request }) => {
    const [doc] = await vault.seed([{ title: 'Lucky', content: 'Body' }]);
    await page.goto(`/#/${doc!.id}`);
    await expectPageTitle(page, 'Lucky');
    await page.getByTestId('page-title').hover();
    await page.getByTestId('page-icon-button').click();
    await page.getByTestId('emoji-random').click();
    await expect(page.locator('.page-icon-large')).toHaveCount(1);
    await expect.poll(async () => (await api.getPage(request, doc!.id)).icon ?? '').not.toBe('');
  });
});
