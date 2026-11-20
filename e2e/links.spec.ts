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
    await expect(page.getByTestId('wiki-link-Missing Page')).toHaveAttribute(
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
    await expect(body.getByTestId('wiki-link-Brand New')).toHaveAttribute(
      'data-resolved',
      'true',
    );
  });

  test('typing a complete [[link]] converts it immediately and persists as Markdown', async ({
    page,
    vault,
    request,
  }) => {
    const [target] = await vault.seed([
      { title: 'Target', content: '## Section\n\nTarget body.' },
    ]);
    const [note] = await vault.seed([{ title: 'Note', content: '' }]);

    await page.goto('/');
    await expectPageTitle(page, 'Note');

    const body = page.getByTestId('editor-content');
    await body.click();

    // No reload: the rule converts `]]` in place and the suggestion closes.
    await page.keyboard.type('See [[Target]] here');
    await expect(page.getByTestId('link-menu')).toHaveCount(0);
    const links = body.getByTestId(`wiki-link-${target.id}`);
    await expect(links).toHaveCount(1);
    await expect(links).toHaveAttribute('data-resolved', 'true');
    await expect(body).toContainText('See Target here');

    // Alias and heading forms convert too (same target, different labels).
    await page.keyboard.press('End');
    await page.keyboard.type(' plus [[Target|home]]');
    await expect(links).toHaveCount(2);
    await expect(links.filter({ hasText: 'home' })).toHaveCount(1);

    await page.keyboard.type(' and [[Target#Section]]');
    await expect(links).toHaveCount(3);
    await expect(links.filter({ hasText: '#Section' })).toHaveCount(1);

    // An unresolved title still becomes a link node immediately.
    await page.keyboard.type(' and [[Missing Page]]');
    const missing = body.getByTestId('wiki-link-Missing Page');
    await expect(missing).toHaveAttribute('data-resolved', 'false');
    await expect(page.getByTestId('link-menu')).toHaveCount(0);

    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', {
      timeout: 10_000,
    });
    const saved = await (
      await request.get(`${API_URL}/api/pages/${encodeURIComponent(note.id)}`)
    ).json();
    expect(saved.content).toContain('[[Target]]');
    expect(saved.content).toContain('[[Target|home]]');
    expect(saved.content).toContain('[[Target#Section]]');
    expect(saved.content).toContain('[[Missing Page]]');

    // The nodes survive a reload (no suggestion text left behind).
    await page.reload();
    const reloaded = page.getByTestId('editor-content');
    await expect(reloaded.getByTestId(`wiki-link-${target.id}`)).toHaveCount(3);
    await expect(reloaded.getByTestId('wiki-link-Missing Page')).toHaveAttribute(
      'data-resolved',
      'false',
    );
  });

  test('typed [[links]] stay literal inside a code span and a code block', async ({
    page,
    vault,
  }) => {
    const [target] = await vault.seed([{ title: 'Target' }]);
    await vault.seed([{ title: 'Note', content: '' }]);

    await page.goto('/');
    await expectPageTitle(page, 'Note');

    const body = page.getByTestId('editor-content');
    await body.click();

    // A code span still being typed: unmatched backtick means this is code.
    await page.keyboard.type('`[[Target]]');
    await expect(body.getByTestId(`wiki-link-${target.id}`)).toHaveCount(0);
    await page.keyboard.type('`');
    await expect(body.getByTestId(`wiki-link-${target.id}`)).toHaveCount(0);
    await expect(body.locator('code')).toContainText('[[Target]]');

    // A fenced code block keeps the raw text too.
    await page.keyboard.press('Enter');
    await page.keyboard.type('```');
    await page.keyboard.type(' ');
    await page.keyboard.type('[[Target]] in code');
    const pre = body.locator('pre');
    await expect(pre).toContainText('[[Target]] in code');
    await expect(pre.locator('[data-testid^="wiki-link-"]')).toHaveCount(0);
  });
});
