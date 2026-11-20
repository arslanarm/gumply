import type { Page } from '@playwright/test';
import { test, expect, type Vault } from './fixtures';
import { API_URL } from './support/env';
import { expectPageTitle } from './support/ui';

/** Cmd on macOS, Ctrl elsewhere — the app accepts both. */
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/** Seed one page and open it, returning the editor body locator. */
async function openPage(page: Page, vault: Vault, title: string, content = '') {
  const [seeded] = await vault.seed([{ title, content }]);
  await page.goto('/');
  await expectPageTitle(page, title);
  const body = page.getByTestId('editor-content');
  await body.click();
  return { seeded, body };
}

/**
 * Flow B (editor) — see wiki `spec/e2e-tests`.
 * Markdown shortcuts, the `/` menu, the empty-body placeholder and the
 * markdown round-trip to disk.
 */
test.describe('editor', () => {
  test('shows the exact empty-body placeholder and hides it on the first keystroke', async ({
    page,
    vault,
  }) => {
    const { body } = await openPage(page, vault, 'Placeholder page');

    const placeholder = body.locator('[data-placeholder]');
    await expect(placeholder).toHaveCount(1);
    await expect(placeholder).toHaveAttribute('data-placeholder', "Type '/' for commands…");
    // Body only, never in the title.
    await expect(page.getByTestId('page-title')).toHaveText('Placeholder page');

    await body.click();
    await page.keyboard.type('x');
    await expect(body.locator('[data-placeholder]')).toHaveCount(0);
  });

  test('empty headings show their level as the placeholder', async ({ page, vault }) => {
    const { body } = await openPage(page, vault, 'Heading placeholder');

    await page.keyboard.type('# ');
    const heading = body.locator('h1');
    await expect(heading).toHaveAttribute('data-placeholder', 'Heading 1');

    await page.keyboard.type('Title');
    await expect(heading).not.toHaveAttribute('data-placeholder', 'Heading 1');
  });

  test('# creates a heading', async ({ page, vault }) => {
    const { body } = await openPage(page, vault, 'Heading shortcut');

    await page.keyboard.type('# Big heading');
    await expect(body.locator('h1')).toHaveText('Big heading');
  });

  test('- creates a bullet list', async ({ page, vault }) => {
    const { body } = await openPage(page, vault, 'Bullet shortcut');

    await page.keyboard.type('- first item');
    await expect(body.locator('ul li')).toHaveText('first item');
  });

  test('1. creates an ordered list', async ({ page, vault }) => {
    const { body } = await openPage(page, vault, 'Ordered shortcut');

    await page.keyboard.type('1. first item');
    await expect(body.locator('ol li')).toHaveText('first item');
  });

  test('> creates a quote', async ({ page, vault }) => {
    const { body } = await openPage(page, vault, 'Quote shortcut');

    await page.keyboard.type('> quoted text');
    await expect(body.locator('blockquote')).toContainText('quoted text');
  });

  test('``` creates a code block', async ({ page, vault }) => {
    const { body } = await openPage(page, vault, 'Code shortcut');

    await page.keyboard.type('```');
    await page.keyboard.type(' ');
    await page.keyboard.type('const answer = 42;');
    await expect(body.locator('pre')).toContainText('const answer = 42;');
  });

  test('- [ ] creates a to-do (#rsyu8ixx)', async ({ page, vault }) => {
    const { body } = await openPage(page, vault, 'Todo shortcut');

    await page.keyboard.type('- [ ] task');
    await expect(body.getByRole('checkbox')).toBeVisible();
    await expect(body.locator('li')).toContainText('task');
  });

  test('slash menu filters by keyword, inserts with Enter and closes on Esc', async ({
    page,
    vault,
  }) => {
    const { body } = await openPage(page, vault, 'Slash menu');

    await page.keyboard.type('/');
    const menu = page.getByTestId('slash-menu');
    await expect(menu).toBeVisible();
    await expect(page.getByTestId('slash-menu-item-heading-1')).toBeVisible();

    await page.keyboard.type('quo');
    await expect(page.getByTestId('slash-menu-item-quote')).toBeVisible();
    await expect(page.getByTestId('slash-menu-item-heading-1')).toHaveCount(0);

    await page.keyboard.press('Enter');
    await expect(menu).toHaveCount(0);
    await expect(body.locator('blockquote')).toBeVisible();

    // Esc closes the menu without inserting anything.
    await page.keyboard.press('Enter');
    await page.keyboard.type('/');
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(body.locator('h1')).toHaveCount(0);
  });

  test('markdown from the API renders and edits round-trip to disk', async ({
    page,
    vault,
    request,
  }) => {
    const markdown = [
      '# Round trip',
      '',
      '- bullet one',
      '',
      '1. numbered one',
      '',
      '- [ ] task one',
      '',
      '> quoted',
      '',
      '```',
      'const x = 1;',
      '```',
      '',
      'Original paragraph.',
    ].join('\n');
    const { seeded, body } = await openPage(page, vault, 'Round trip', markdown);

    await expect(body.locator('h1')).toHaveText('Round trip');
    await expect(body.locator('ul li').first()).toContainText('bullet one');
    await expect(body.locator('ol li')).toContainText('numbered one');
    await expect(body.getByRole('checkbox')).toBeVisible();
    await expect(body.locator('blockquote')).toContainText('quoted');
    await expect(body.locator('pre')).toContainText('const x = 1;');

    await body.getByText('Original paragraph.').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Appended.');
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', {
      timeout: 10_000,
    });

    const saved = await (
      await request.get(`${API_URL}/api/pages/${encodeURIComponent(seeded.id)}`)
    ).json();
    expect(saved.content).toContain('# Round trip');
    expect(saved.content).toContain('bullet one');
    expect(saved.content).toContain('numbered one');
    expect(saved.content).toContain('task one');
    expect(saved.content).toContain('quoted');
    expect(saved.content).toContain('const x = 1;');
    expect(saved.content).toContain('Appended.');

    await page.reload();
    await expect(page.getByTestId('editor-content')).toContainText('Appended.');
  });

  test('undo after a # shortcut restores literal text and redo round-trips (#ihi666yy)', async ({
    page,
    vault,
    request,
  }) => {
    const { seeded, body } = await openPage(page, vault, 'Undo redo');

    await page.keyboard.type('# Heading');
    await expect(body.locator('h1')).toHaveText('Heading');

    // LIFO undo: the typed text is undone but the literal "#" marker remains,
    // instead of an empty block (or the whole heading being wiped).
    await page.keyboard.press(`${MOD}+z`);
    await expect(body.locator('h1')).toHaveCount(0);
    await expect(body).toHaveText('#');

    // Redo with Shift+Mod+z restores the heading.
    await page.keyboard.press(`Shift+${MOD}+z`);
    await expect(body.locator('h1')).toHaveText('Heading');
    await expect(body).not.toContainText('# Heading');

    // The same round-trip via Mod+y (Ctrl+Y on Linux/Windows).
    await page.keyboard.press(`${MOD}+z`);
    await expect(body.locator('h1')).toHaveCount(0);
    await expect(body).toHaveText('#');
    await page.keyboard.press(`${MOD}+y`);
    await expect(body.locator('h1')).toHaveText('Heading');
    await expect(body).toHaveText('Heading');

    // No ProseMirror/DOM desync: the saved Markdown and a reload agree.
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', {
      timeout: 10_000,
    });
    const saved = await (
      await request.get(`${API_URL}/api/pages/${encodeURIComponent(seeded.id)}`)
    ).json();
    expect(saved.content).toContain('# Heading');

    await page.reload();
    const reloaded = page.getByTestId('editor-content');
    await expect(reloaded.locator('h1')).toHaveText('Heading');
    await expect(reloaded).not.toContainText('# Heading');
  });
});
