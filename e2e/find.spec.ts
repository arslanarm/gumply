import { test, expect } from './fixtures';
import { API_URL } from './support/env';
import { expectPageTitle } from './support/ui';

/** Cmd on macOS, Ctrl elsewhere — the app accepts both. */
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

async function openSwitcher(page: import('@playwright/test').Page) {
  // Wait for the app shell: the Cmd/Ctrl+K listener is registered on mount.
  await expect(page.getByTestId('sidebar')).toBeVisible();
  await page.keyboard.press(`${MOD}+k`);
  const switcher = page.getByTestId('quick-switcher');
  await expect(switcher).toBeVisible();
  await expect(page.getByTestId('quick-switcher-input')).toBeFocused();
  return switcher;
}

/**
 * Flow E (find) — see wiki `spec/e2e-tests`.
 * Cmd/Ctrl+K quick switcher (D13): title-first search, body snippets, create
 * and the empty/no-match states.
 */
test.describe('search and quick switcher', () => {
  test('Cmd/Ctrl+K opens, finds a page by title, Enter opens it and Esc closes', async ({
    page,
    vault,
  }) => {
    const [alpha, beta] = await vault.seed([
      { title: 'Alpha Project', content: 'Project notes.' },
      { title: 'Beta Notes', content: 'Other notes.' },
    ]);

    await page.goto('/');
    const switcher = await openSwitcher(page);

    await page.keyboard.type('alp');
    const result = page.getByTestId(`search-result-${alpha.id}`);
    await expect(result).toBeVisible();
    await expect(result).toContainText('Alpha Project');

    await page.keyboard.press('Enter');
    await expect(switcher).toHaveCount(0);
    await expectPageTitle(page, 'Alpha Project');

    // Reopen and close with Escape without navigating.
    const reopened = await openSwitcher(page);
    await page.keyboard.type('bet');
    await expect(page.getByTestId(`search-result-${beta.id}`)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(reopened).toHaveCount(0);
    await expectPageTitle(page, 'Alpha Project');
  });

  test('the sidebar Search row opens the same switcher with recent pages', async ({
    page,
    vault,
  }) => {
    await vault.seed([{ title: 'Recent page' }, { title: 'Another page' }]);

    await page.goto('/');
    await page.getByTestId('sidebar-search').click();

    await expect(page.getByTestId('quick-switcher')).toBeVisible();
    await expect(page.getByTestId('quick-switcher-input')).toBeFocused();
    await expect(page.getByTestId('quick-switcher')).toContainText('Recent');
    await expect(page.getByTestId('search-result-Recent page')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('quick-switcher')).toHaveCount(0);
  });

  test('title matches rank before body matches, snippets highlight, and keyboard opens a text hit', async ({
    page,
    vault,
  }) => {
    const [titleHit] = await vault.seed([
      { title: 'Alpha handbook', content: 'No body match here.' },
    ]);
    const [textHit] = await vault.seed([
      { title: 'Team notes', content: 'This paragraph mentions alpha halfway through it.' },
    ]);

    await page.goto('/');
    await openSwitcher(page);
    await page.keyboard.type('alpha');

    const pagesHeading = page.getByText('Pages', { exact: true });
    const textHeading = page.getByText('Text', { exact: true });
    await expect(pagesHeading).toBeVisible();
    await expect(textHeading).toBeVisible();

    const titleRow = page.getByTestId(`search-result-${titleHit.id}`);
    const textRow = page.getByTestId(`search-result-${textHit.id}`);
    await expect(titleRow).toBeVisible();
    await expect(textRow).toBeVisible();

    // Title results come first in the listbox (D13/spec).
    const order = await page
      .getByRole('option')
      .evaluateAll((options) => options.map((option) => option.getAttribute('data-testid')));
    expect(order.indexOf(`search-result-${titleHit.id}`)).toBeLessThan(
      order.indexOf(`search-result-${textHit.id}`),
    );

    // Body-only hits show a snippet with the query highlighted.
    await expect(textRow).toContainText('mentions');
    await expect(textRow.locator('mark')).toHaveText('alpha');

    // ArrowDown selects the text hit; Enter opens it.
    await page.keyboard.press('ArrowDown');
    await expect(textRow).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('quick-switcher')).toHaveCount(0);
    await expectPageTitle(page, 'Team notes');
    await expect(page.getByTestId('editor-content')).toContainText('mentions alpha');
  });

  test('no match shows the empty state and Create makes the page', async ({
    page,
    vault,
    request,
  }) => {
    await vault.seed([{ title: 'Existing page' }]);

    await page.goto('/');
    await openSwitcher(page);
    await page.keyboard.type('zzz brand new');

    const empty = page.getByTestId('search-empty');
    await expect(empty).toBeVisible();
    await expect(empty).toContainText('No pages match “zzz brand new”');

    const create = page.getByTestId('search-create');
    await expect(create).toBeVisible();
    await expect(create).toContainText('Create “zzz brand new”');

    await page.keyboard.press('Enter');
    await expect(page.getByTestId('quick-switcher')).toHaveCount(0);
    await expectPageTitle(page, 'zzz brand new');
    await expect(page.getByTestId('page-item-zzz brand new')).toBeVisible();

    const listed = (await (await request.get(`${API_URL}/api/pages`)).json()) as {
      title: string;
    }[];
    expect(listed.map((item) => item.title)).toContain('zzz brand new');
  });

  test('empty vault shows “No pages yet.” instead of a blank palette', async ({
    page,
    vault,
  }) => {
    // The fixture resets the shared vault, so this test starts empty.
    await page.goto('/');
    await openSwitcher(page);

    const empty = page.getByTestId('search-empty');
    await expect(empty).toBeVisible();
    await expect(empty).toHaveText('No pages yet.');
  });
});
