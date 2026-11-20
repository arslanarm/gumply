import { test, expect } from './fixtures';

/**
 * Flow F (polish) — theme, see wiki `spec/e2e-tests`.
 * The toggle cycles System → Light → Dark and persists in localStorage; System
 * mode follows the OS preference.
 */
test.describe('theme (system preference light)', () => {
  test.use({ colorScheme: 'light' });

  test('toggles System → Light → Dark, persists across reload and returns to System', async ({
    page,
  }) => {
    await page.goto('/');
    const root = page.locator('html');
    const toggle = page.getByTestId('theme-toggle');

    await expect(toggle).toHaveAttribute('aria-label', 'Theme: System');
    await expect(root).toHaveAttribute('data-theme', 'light');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-label', 'Theme: Light');
    await expect(root).toHaveAttribute('data-theme', 'light');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-label', 'Theme: Dark');
    await expect(root).toHaveAttribute('data-theme', 'dark');

    // The forced theme survives a reload (persisted preference).
    await page.reload();
    await expect(toggle).toHaveAttribute('aria-label', 'Theme: Dark');
    await expect(root).toHaveAttribute('data-theme', 'dark');

    // Dark → System drops back to the OS preference and clears the override.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-label', 'Theme: System');
    await expect(root).toHaveAttribute('data-theme', 'light');
  });
});

test.describe('theme (system preference dark)', () => {
  test.use({ colorScheme: 'dark' });

  test('System resolves to dark and a forced Light survives reload', async ({ page }) => {
    await page.goto('/');
    const root = page.locator('html');
    const toggle = page.getByTestId('theme-toggle');

    await expect(toggle).toHaveAttribute('aria-label', 'Theme: System');
    await expect(root).toHaveAttribute('data-theme', 'dark');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-label', 'Theme: Light');
    await expect(root).toHaveAttribute('data-theme', 'light');

    await page.reload();
    await expect(toggle).toHaveAttribute('aria-label', 'Theme: Light');
    await expect(root).toHaveAttribute('data-theme', 'light');
  });
});
