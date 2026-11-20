import { test, expect } from './fixtures';
import { API_URL } from './support/env';
import { expectPageTitle } from './support/ui';

/**
 * Flow A (pages / sidebar) — see wiki `spec/e2e-tests`.
 * A4 (delete/undo) waits for the D11 server work (trash + restore);
 * A3 (rename link rewrite) waits for D12.
 */
test.describe('pages and sidebar', () => {
  test('auto-opens the first root page and opens a nested page from the tree', async ({
    page,
    vault,
  }) => {
    const [projects] = await vault.seed([{ title: 'Projects' }]);
    const [roadmap] = await vault.seed([{ title: 'Roadmap', parentId: projects.id }]);

    await page.goto('/');

    // P0 A1: a root page opens without a click.
    await expectPageTitle(page, 'Projects');
    await expect(page.getByTestId('page-item-' + roadmap.id)).toBeVisible();

    await page.getByTestId(`page-item-${roadmap.id}`).click();
    await expectPageTitle(page, 'Roadmap');
    // Hash routing keeps deep links readable: #/projects/roadmap
    expect(decodeURIComponent(page.url())).toContain(`#/${roadmap.id}`);
  });

  test('opens Welcome on a cold start even when the one-shot signal was missed', async ({
    page,
    vault,
  }) => {
    // Alphabetically "Gumply demo" sorts before "Welcome"; the old fallback
    // opened it when the new-vault header had already been consumed.
    await vault.seed([{ title: 'Gumply demo' }, { title: 'Welcome' }]);

    await page.goto('/');
    await expectPageTitle(page, 'Welcome');
  });

  test('creates a page from the sidebar and opens it', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('empty-state')).toBeVisible();

    await page.getByTestId('new-page-button').click();

    await expectPageTitle(page, 'Untitled');
    await expect(page.getByTestId('page-tree').getByText('Untitled')).toBeVisible();
    await expect(page.getByTestId('editor')).toBeVisible();
  });

  test('autosaves typed content and keeps it after reload', async ({ page, vault, request }) => {
    const [page1] = await vault.seed([{ title: 'Autosave target' }]);

    await page.goto('/');
    await expectPageTitle(page, 'Autosave target');

    const body = page.getByTestId('editor-content');
    await body.click();
    await page.keyboard.type('Hello autosave');

    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', {
      timeout: 10_000,
    });

    // Server has it too, not just the editor buffer.
    const saved = await (
      await request.get(`${API_URL}/api/pages/${encodeURIComponent(page1.id)}`)
    ).json();
    expect(saved.content).toContain('Hello autosave');

    await page.reload();
    await expect(page.getByTestId('editor-content')).toContainText('Hello autosave');
  });

  test('renaming a page rewrites links to it in other pages (D12)', async ({
    page,
    vault,
    request,
  }) => {
    const [source] = await vault.seed([
      { title: 'Source', content: 'See [[Target]] and [[Target|an alias]].' },
    ]);
    const [target] = await vault.seed([{ title: 'Target' }]);

    await page.goto('/');

    // Inline rename from the tree: double-click the row, edit, Enter.
    await page.getByTestId(`page-item-${target.id}`).dblclick();
    const input = page.getByTestId(`page-rename-input-${target.id}`);
    await input.fill('Target Renamed');
    // Keyboard press, not input.press(): Enter commits the rename and detaches
    // the input, and an element-bound press would retry against a dead locator.
    await page.keyboard.press('Enter');

    // D20: the file name and id follow the title; the old id redirects.
    await expect(page.getByTestId('page-item-Target Renamed')).toContainText('Target Renamed');

    const saved = await (
      await request.get(`${API_URL}/api/pages/${encodeURIComponent(source.id)}`)
    ).json();
    expect(saved.content).toContain('[[Target Renamed]]');
    expect(saved.content).toContain('[[Target Renamed|an alias]]');

    // Source was auto-opened on load, and an already-open page does not refetch
    // after a rename elsewhere (tracked separately), so reload before asserting
    // what the rewritten markdown renders as.
    await page.getByTestId(`page-item-${source.id}`).click();
    await page.reload();
    await expect(page.getByTestId('editor-content')).toContainText('Target Renamed');
  });

  test('renaming a page renames its file and the client follows the new id (D20)', async ({
    page,
    vault,
    request,
  }) => {
    const [page1] = await vault.seed([{ title: 'Plan', content: 'body' }]);

    await page.goto('/');
    await expectPageTitle(page, 'Plan');

    await page.getByTestId(`page-item-${page1.id}`).dblclick();
    await page.getByTestId(`page-rename-input-${page1.id}`).fill('Q1 plan');
    await page.keyboard.press('Enter');

    await expectPageTitle(page, 'Q1 plan');
    await expect(page.getByTestId('page-item-Q1 plan')).toBeVisible();
    await expect
      .poll(() => decodeURIComponent(new URL(page.url()).hash))
      .toBe('#/Q1 plan');

    const renamed = (await (
      await request.get(`${API_URL}/api/pages/${encodeURIComponent('Q1 plan')}`)
    ).json()) as { id: string; title: string };
    expect(renamed).toMatchObject({ id: 'Q1 plan', title: 'Q1 plan' });

    // The file name follows the title (spaces and case kept).
    expect((await request.get(`${API_URL}/api/files/${encodeURIComponent('Q1 plan.md')}`)).status()).toBe(200);
    expect((await request.get(`${API_URL}/api/files/plan.md`)).status()).toBe(404);

    // Old ids keep working for this server session.
    const viaOld = await request.get(`${API_URL}/api/pages/${encodeURIComponent(page1.id)}`);
    expect(viaOld.status()).toBe(200);
    expect(((await viaOld.json()) as { id: string }).id).toBe('Q1 plan');
  });

  test('renaming a page issues exactly one write and keeps the rewrite (D12 invariant)', async ({
    page,
    vault,
    request,
  }) => {
    // Invariant behind #n8kk26sc: one rename must produce one PUT, and nothing
    // may write the old title afterwards. (The original bug needed full-suite
    // timing, so this is a guard, not a deterministic reproduction.)
    const [target] = await vault.seed([{ title: 'Empty Target' }]);
    const [source] = await vault.seed([
      { title: 'Source', content: 'See [[Empty Target]].' },
    ]);

    const puts: string[] = [];
    page.on('request', (req) => {
      if (req.method() === 'PUT' && req.url().includes('/api/pages/')) {
        const body = req.postData() ? (JSON.parse(req.postData() ?? '{}') as { title?: string }) : {};
        if (body.title) puts.push(body.title);
      }
    });

    await page.goto('/');
    // Open the empty page: on an empty page the header puts its title into edit
    // mode, which is the state that made the stale blur commit possible.
    await page.getByTestId(`page-item-${target.id}`).click();
    await expect(page.getByTestId('page-title')).toBeVisible();

    await page.getByTestId(`page-item-${target.id}`).dblclick();
    const input = page.getByTestId(`page-rename-input-${target.id}`);
    await input.fill('Renamed Target');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('page-item-Renamed Target')).toContainText('Renamed Target');

    // Give a stray duplicate commit time to land, then assert exactly one write.
    await page.waitForTimeout(750);
    expect(puts).toEqual(['Renamed Target']);

    const renamed = await (
      await request.get(`${API_URL}/api/pages/${encodeURIComponent(target.id)}`)
    ).json();
    expect(renamed.title).toBe('Renamed Target');

    // The rewrite into Source must survive.
    const saved = await (
      await request.get(`${API_URL}/api/pages/${encodeURIComponent(source.id)}`)
    ).json();
    expect(saved.content).toContain('[[Renamed Target]]');
  });

  test('deletes a leaf page immediately, focuses the next sibling and Undo restores it', async ({
    page,
    vault,
    request,
  }) => {
    const [, beta, gamma] = await vault.seed([
      { title: 'Alpha' },
      { title: 'Beta', content: 'Beta body' },
      { title: 'Gamma' },
    ]);

    await page.goto('/');
    await expectPageTitle(page, 'Alpha');

    await page.getByTestId(`page-menu-button-${beta.id}`).click();
    await page.getByTestId(`delete-page-${beta.id}`).click();

    // D11: leaf pages delete with no confirmation.
    await expect(page.getByTestId(`page-item-${beta.id}`)).toHaveCount(0);
    const toast = page.getByTestId('undo-toast');
    await expect(toast).toBeVisible();
    await expect(toast).toContainText('Page deleted');
    await expect(page.getByTestId('undo-delete')).toBeVisible();

    // Focus lands on the next sibling (tree order is alphabetical).
    await expect(page.getByTestId(`page-item-${gamma.id}`)).toBeFocused();

    // Server side: the page is gone from the list and 404s by id.
    expect((await request.get(`${API_URL}/api/pages/${encodeURIComponent(beta.id)}`)).status()).toBe(
      404,
    );

    await page.getByTestId('undo-delete').click();
    await expect(page.getByTestId(`page-item-${beta.id}`)).toBeVisible();
    await expect(toast).toHaveCount(0);

    const restored = await (
      await request.get(`${API_URL}/api/pages/${encodeURIComponent(beta.id)}`)
    ).json();
    expect(restored.content).toContain('Beta body');
  });

  test('deleting the last sibling focuses the previous one', async ({ page, vault }) => {
    const [alpha, beta] = await vault.seed([{ title: 'Alpha' }, { title: 'Beta' }]);

    await page.goto('/');
    await expectPageTitle(page, 'Alpha');

    await page.getByTestId(`page-menu-button-${beta.id}`).click();
    await page.getByTestId(`delete-page-${beta.id}`).click();

    await expect(page.getByTestId(`page-item-${beta.id}`)).toHaveCount(0);
    await expect(page.getByTestId(`page-item-${alpha.id}`)).toBeFocused();
  });

  test('deleting the only page focuses New page and the toast expires while hovered (paused)', async ({
    page,
    vault,
  }) => {
    test.setTimeout(45_000);
    const [only] = await vault.seed([{ title: 'Only page' }]);

    await page.goto('/');
    await expectPageTitle(page, 'Only page');

    await page.getByTestId('delete-page-button-page').click();

    // Nothing else to focus: the New page button (never <body>).
    await expect(page.getByTestId('new-page-button')).toBeFocused();
    const toast = page.getByTestId('undo-toast');
    await expect(toast).toBeVisible();

    // D11: the 8s window pauses while the toast is hovered.
    await toast.hover();
    await page.waitForTimeout(8_500);
    await expect(toast).toBeVisible();

    // Leaving the toast starts the remaining time again; it is not reset.
    await page.mouse.move(0, 0);
    await expect(toast).toHaveCount(0, { timeout: 12_000 });

    // Expiry is final: the page stays deleted after a reload.
    await page.reload();
    await expect(page.getByTestId(`page-item-${only.id}`)).toHaveCount(0);
    await expect(page.getByTestId('empty-state')).toBeVisible();
  });

  test('deleting a page with one sub-page asks first with singular D15 copy and Cancel focused', async ({
    page,
    vault,
    request,
  }) => {
    const [parent] = await vault.seed([{ title: 'Parent' }]);
    const [child] = await vault.seed([{ title: 'Child', parentId: parent.id }]);

    await page.goto('/');
    await expectPageTitle(page, 'Parent');

    await page.getByTestId('delete-page-button-page').click();
    const dialog = page.getByRole('dialog', { name: 'Delete “Parent”?' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Its 1 sub-page will be deleted too.');
    await expect(page.getByTestId('delete-cancel')).toBeFocused();

    // Cancel is a no-op; Esc too.
    await page.getByTestId('delete-cancel').click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId(`page-item-${parent.id}`)).toBeVisible();
    await expect(page.getByTestId(`page-item-${child.id}`)).toBeVisible();

    await page.getByTestId('delete-page-button-page').click();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId(`page-item-${parent.id}`)).toBeVisible();

    // Delete removes the whole subtree; Undo restores it.
    await page.getByTestId('delete-page-button-page').click();
    await page.getByTestId('delete-confirm').click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId(`page-item-${parent.id}`)).toHaveCount(0);
    await expect(page.getByTestId(`page-item-${child.id}`)).toHaveCount(0);
    await expect(page.getByTestId('undo-toast')).toContainText('Page deleted');

    await page.getByTestId('undo-delete').click();
    await expect(page.getByTestId(`page-item-${parent.id}`)).toBeVisible();
    await expect(page.getByTestId(`page-item-${child.id}`)).toBeVisible();
    expect(
      (await request.get(`${API_URL}/api/pages/${encodeURIComponent(child.id)}`)).status(),
    ).toBe(200);
  });

  test('the delete confirm uses plural D15 copy for several sub-pages', async ({ page, vault }) => {
    const [parent] = await vault.seed([{ title: 'Parent' }]);
    await vault.seed([
      { title: 'One', parentId: parent.id },
      { title: 'Two', parentId: parent.id },
    ]);

    await page.goto('/');
    await expectPageTitle(page, 'Parent');
    await page.getByTestId('delete-page-button-page').click();

    const dialog = page.getByRole('dialog', { name: 'Delete “Parent”?' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Its 2 sub-pages will be deleted too.');
    await expect(page.getByTestId('delete-cancel')).toBeFocused();
    await page.getByTestId('delete-cancel').click();
    await expect(page.getByTestId(`page-item-${parent.id}`)).toBeVisible();
  });

  test('DELETE trashes the subtree, hides .trash from the list and 409s restore on a taken path', async ({
    vault,
    request,
  }) => {
    const [parent] = await vault.seed([{ title: 'Folder' }]);
    const [a] = await vault.seed([{ title: 'A', parentId: parent.id }]);
    const [b] = await vault.seed([{ title: 'B', parentId: parent.id }]);

    const res = await request.delete(
      `${API_URL}/api/pages/${encodeURIComponent(parent.id)}`,
    );
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { trashId: string; deleted: string[] };
    expect(body.trashId.length).toBeGreaterThan(0);
    expect([...body.deleted].sort()).toEqual([parent.id, a.id, b.id].sort());

    const listed = (await (await request.get(`${API_URL}/api/pages`)).json()) as unknown[];
    expect(listed).toHaveLength(0);

    // Re-create the original path, then restoring the trash must conflict.
    const recreated = await request.post(`${API_URL}/api/pages`, { data: { title: 'Folder' } });
    expect(recreated.status()).toBe(201);
    const restore = await request.post(
      `${API_URL}/api/trash/${encodeURIComponent(body.trashId)}/restore`,
    );
    expect(restore.status()).toBe(409);
  });

  test('opening a non-existent id shows the not-found state, not a blank screen', async ({
    page,
    vault,
  }) => {
    await vault.seed([{ title: 'Existing' }]);

    await page.goto('/#/never-existed');
    const notFound = page.getByTestId('page-not-found');
    await expect(notFound).toBeVisible();
    await expect(notFound).toContainText("This page doesn't exist.");
    await expect(page.getByRole('button', { name: 'Create page' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Go to Welcome' })).toBeVisible();

    await page.getByRole('button', { name: 'Create page' }).click();
    await expectPageTitle(page, 'Untitled');
    await expect(page.getByTestId('editor')).toBeVisible();
  });

  test('Move to… puts a page under another one and Undo puts it back', async ({
    page,
    vault,
    request,
  }) => {
    const [destination] = await vault.seed([{ title: 'Destination' }]);
    const [source] = await vault.seed([{ title: 'Source' }]);

    await page.goto('/');
    await expectPageTitle(page, 'Destination');

    await page.getByTestId(`page-menu-button-${source.id}`).click();
    await page.getByTestId(`move-page-${source.id}`).click();

    const dialog = page.getByRole('dialog', { name: 'Move “Source”' });
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('move-input')).toBeFocused();

    await page.getByTestId('move-input').fill('Dest');
    await expect(page.getByTestId(`move-target-${destination.id}`)).toBeVisible();
    await page.keyboard.press('Enter');

    await expect(dialog).toHaveCount(0);
    const toast = page.getByTestId('undo-toast');
    await expect(toast).toContainText('Moved to “Destination”');

    // Path-based id changes with the move; the row stays in the tree.
    const movedId = `${destination.id}/${source.id}`;
    await expect(page.getByTestId(`page-item-${movedId}`)).toBeVisible();
    const moved = await (
      await request.get(`${API_URL}/api/pages/${encodeURIComponent(movedId)}`)
    ).json();
    expect(moved.parentId).toBe(destination.id);

    await page.getByTestId('undo-delete').click();
    await expect(page.getByTestId(`page-item-${source.id}`)).toBeVisible();
    const restored = await (
      await request.get(`${API_URL}/api/pages/${encodeURIComponent(source.id)}`)
    ).json();
    expect(restored.parentId).toBeNull();
  });

  test('Move to… offers Top level for a nested page and moves it back', async ({
    page,
    vault,
    request,
  }) => {
    const [parent] = await vault.seed([{ title: 'Parent' }]);
    const [child] = await vault.seed([{ title: 'Child', parentId: parent.id }]);

    await page.goto('/');
    await expectPageTitle(page, 'Parent');

    await page.getByTestId(`page-menu-button-${child.id}`).click();
    await page.getByTestId(`move-page-${child.id}`).click();

    const dialog = page.getByRole('dialog', { name: 'Move “Child”' });
    await expect(dialog).toBeVisible();
    await page.getByTestId('move-target-top-level').click();

    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('undo-toast')).toContainText('Moved to top level');
    await expect(page.getByTestId('page-item-Child')).toBeVisible();

    const moved = await (
      await request.get(`${API_URL}/api/pages/Child`)
    ).json();
    expect(moved.parentId).toBeNull();
  });

  test('Move to… excludes itself and its descendants, and shows a filter empty state', async ({
    page,
    vault,
    request,
  }) => {
    const [parent] = await vault.seed([{ title: 'Parent' }]);
    const [child] = await vault.seed([{ title: 'Child', parentId: parent.id }]);

    await page.goto('/');
    await expectPageTitle(page, 'Parent');

    await page.getByTestId(`page-menu-button-${parent.id}`).click();
    await page.getByTestId(`move-page-${parent.id}`).click();

    const dialog = page.getByRole('dialog', { name: 'Move “Parent”' });
    await expect(dialog).toBeVisible();
    // A root page has no Top level row, and it can never move into itself or a child.
    await expect(page.getByTestId('move-target-top-level')).toHaveCount(0);
    await expect(page.getByTestId(`move-target-${parent.id}`)).toHaveCount(0);
    await expect(page.getByTestId(`move-target-${child.id}`)).toHaveCount(0);

    await page.getByTestId('move-input').fill('zzz');
    await expect(page.getByTestId('move-empty')).toHaveText('No pages match “zzz”');

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    const unchanged = await (
      await request.get(`${API_URL}/api/pages/${encodeURIComponent(parent.id)}`)
    ).json();
    expect(unchanged.parentId).toBeNull();
    expect(
      (await request.get(`${API_URL}/api/pages/${encodeURIComponent(child.id)}`)).status(),
    ).toBe(200);
  });
});
