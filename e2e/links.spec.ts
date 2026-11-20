import { test, expect } from './fixtures';
import { API_URL } from './support/env';
import { expectPageTitle } from './support/ui';

/**
 * Flow C (wikilinks + backlinks) — see wiki `spec/e2e-tests`.
 * M2 merged: `[[` autocomplete, clickable/resolved links, create-on-click,
 * alias/heading forms, code exclusion and the “Linked from” panel.
 */
test.describe('wikilinks and backlinks', () => {
  test('renders resolved, alias, heading and unresolved links, but not inside code', async ({
    page,
    vault,
    request,
  }) => {
    const [target] = await vault.seed([
      { title: 'Target', content: '## Section\n\nTarget body.' },
    ]);
    const [source] = await vault.seed([
      {
        title: 'Source',
        content: [
          'See [[Target]], [[Missing Page]], [[Target|an alias]] and [[Target#Section]].',
          '',
          '```',
          '[[Target]] inside code',
          '```',
        ].join('\n'),
      },
    ]);

    await page.goto('/');
    await expectPageTitle(page, 'Source');

    const body = page.getByTestId('editor-content');
    const resolved = body.getByTestId(`wiki-link-${target.id}`);
    // Plain link + alias + heading form.
    await expect(resolved).toHaveCount(3);
    await expect(resolved.first()).toHaveAttribute('data-resolved', 'true');
    await expect(resolved.filter({ hasText: 'an alias' })).toHaveCount(1);
    await expect(resolved.filter({ hasText: '#Section' })).toHaveCount(1);

    const missing = body.getByTestId('wiki-link-Missing Page');
    await expect(missing).toHaveCount(1);
    await expect(missing).toHaveAttribute('data-resolved', 'false');
    await expect(missing).toHaveClass(/is-unresolved/);

    // A wikilink inside a code block stays plain text, not a link node.
    const code = body.locator('pre');
    await expect(code).toContainText('[[Target]] inside code');
    await expect(code.locator('[data-testid^="wiki-link-"]')).toHaveCount(0);

    // Backlinks count resolved links only, one entry per source page.
    const backlinks = await (
      await request.get(`${API_URL}/api/pages/${encodeURIComponent(target.id)}/backlinks`)
    ).json();
    expect(backlinks).toHaveLength(1);
    expect(backlinks[0].page.id).toBe(source.id);

    // Click the link -> target opens; its “Linked from” panel shows the source.
    await resolved.first().getByRole('link').click();
    await expectPageTitle(page, 'Target');
    const panel = page.getByTestId('backlinks-panel');
    await expect(panel).toContainText('Linked from');
    await expect(page.getByTestId(`backlink-${source.id}`)).toContainText('Source');

    // Clicking the backlink opens the source page again.
    await page.getByTestId(`backlink-${source.id}`).click();
    await expectPageTitle(page, 'Source');
  });

  test('clicking an unresolved link creates that page, opens it and focuses the body', async ({
    page,
    vault,
    request,
  }) => {
    const [source] = await vault.seed([
      { title: 'Source', content: 'Go to [[Missing Page]] now.' },
    ]);

    await page.goto('/');
    await expectPageTitle(page, 'Source');

    const missing = page.getByTestId('editor-content').getByTestId('wiki-link-Missing Page');
    await expect(missing).toHaveAttribute('data-resolved', 'false');
    await missing.getByRole('link').click();

    await expectPageTitle(page, 'Missing Page');
    await expect(page.getByTestId('editor-content')).toBeFocused();

    const listed = (await (await request.get(`${API_URL}/api/pages`)).json()) as { title: string }[];
    expect(listed.map((item) => item.title)).toContain('Missing Page');

    // Back on the source the link is resolved — no broken state left behind.
    await page.getByTestId(`page-item-${source.id}`).click();
    await expectPageTitle(page, 'Source');
    await expect(page.getByTestId('wiki-link-missing-page')).toHaveAttribute(
      'data-resolved',
      'true',
    );
  });

  test('[[ autocomplete inserts a link to an existing page', async ({ page, vault, request }) => {
    const [target] = await vault.seed([{ title: 'Target', content: 'Target body.' }]);
    const [note] = await vault.seed([{ title: 'Note', content: '' }]);

    await page.goto('/');
    await expectPageTitle(page, 'Note');

    const body = page.getByTestId('editor-content');
    await body.click();
    await page.keyboard.type('[[Tar');

    const menu = page.getByTestId('link-menu');
    await expect(menu).toBeVisible();
    await expect(page.getByTestId(`link-suggestion-${target.id}`)).toBeVisible();
    await page.keyboard.press('Enter');

    await expect(menu).toHaveCount(0);
    await expect(body.getByTestId(`wiki-link-${target.id}`)).toHaveCount(1);

    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', {
      timeout: 10_000,
    });
    const saved = await (
      await request.get(`${API_URL}/api/pages/${encodeURIComponent(note.id)}`)
    ).json();
    expect(saved.content).toContain('[[Target]]');
  });

  test('the [[ create row makes the page without leaving the current one', async ({
    page,
    vault,
  }) => {
    const [note] = await vault.seed([{ title: 'Note', content: '' }]);

    await page.goto('/');
    await expectPageTitle(page, 'Note');

    const body = page.getByTestId('editor-content');
    await body.click();
    await page.keyboard.type('[[Brand New');

    const create = page.getByTestId('link-suggestion-create');
    await expect(create).toBeVisible();
    await expect(create).toContainText('Create “Brand New”');
    await page.keyboard.press('Enter');

    // Stays on Note, but the new page exists and the node resolves.
    await expect(page.getByTestId('link-menu')).toHaveCount(0);
    await expectPageTitle(page, 'Note');
    await expect(page.getByTestId(`page-item-${note.id}`)).toBeVisible();
    await expect(body.getByTestId('wiki-link-brand-new')).toHaveAttribute(
      'data-resolved',
      'true',
    );
  });
});
