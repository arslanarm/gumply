import fs from 'node:fs/promises';
import path from 'node:path';
import { api, expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * #9bx3aznb: the Tags section in the sidebar (counts, nested tags, a click
 * lists the pages) and renaming a tag in every file, byte for byte elsewhere.
 */

const FILES: Record<string, string> = {
  'Plan.md': '---\ntags: [work]\nstatus: draft\n---\n\nThe plan. #work/ideas\n',
  'Notes.md': 'Notes about #work and `#work` in code, [a link](#work).\n\n```\n#work\n```\n',
  'Home.md': 'Chores #home\n',
};

async function seedVault(request: Parameters<typeof api.listPages>[0]) {
  for (const [file, text] of Object.entries(FILES)) await fs.writeFile(path.join(E2E_VAULT, file), text, 'utf8');
  await expect
    .poll(async () => (await api.listPages(request)).map((page) => page.id).sort(), { timeout: 10_000 })
    .toEqual(['Home', 'Notes', 'Plan']);
}

const read = (file: string) => fs.readFile(path.join(E2E_VAULT, file), 'utf8');

test.describe('tags pane (#9bx3aznb)', () => {
  test('lists tags with counts, nests #a/b, and a click lists the tagged pages', async ({ page, request, vault }) => {
    void vault;
    await seedVault(request);
    await page.goto('/#/Home');
    await expect(page.getByTestId('tags-list')).toHaveCount(0);
    await page.getByTestId('tags-pane-toggle').click();
    const list = page.getByTestId('tags-list');
    // Counted like Obsidian: occurrences, a parent including its children
    // (Plan's frontmatter work + #work/ideas, Notes' #work; never code), most used first.
    await expect(list.locator('.tag-label')).toHaveText(['work', 'home']);
    await expect(page.getByTestId('tag-count-work')).toHaveText('3');
    await expect(page.getByTestId('tag-count-home')).toHaveText('1');
    await page.getByTestId('tags-pane-sort').click();
    await expect(list.locator('.tag-label')).toHaveText(['home', 'work']);
    await page.getByTestId('tag-toggle-work').click();
    await expect(page.getByTestId('tag-count-work/ideas')).toHaveText('1');

    // A frontmatter-only tag counts as well: Cmd+K lists both pages.
    await page.getByTestId('tag-open-work').click();
    await expect(page.getByTestId('quick-switcher-input')).toHaveValue('#work');
    await expect(page.getByTestId('search-result-Plan')).toBeVisible();
    await expect(page.getByTestId('search-result-Notes')).toBeVisible();
    await expect(page.getByTestId('search-result-Home')).toHaveCount(0);
    await page.keyboard.press('Escape');

    // The open state and the sort are remembered.
    await page.reload();
    await expect(page.getByTestId('tags-list').locator('.tag-label')).toHaveText(['home', 'work']);
  });

  test('renaming a tag rewrites every file (frontmatter, inline, nested), never code or links', async ({ page, request, vault }) => {
    void vault;
    await seedVault(request);
    await page.goto('/#/Notes');
    await expect(page.getByTestId('editor-content')).toContainText('Notes about #work');
    await page.getByTestId('tags-pane-toggle').click();
    await page.getByTestId('tag-row-work').hover();
    await page.getByTestId('tag-rename-work').click();

    const dialog = page.getByTestId('tag-rename-dialog');
    await expect(dialog).toContainText('Used 3 times, nested tags included');
    const input = page.getByTestId('tag-rename-input');
    await expect(input).toBeFocused();
    await input.fill('two words');
    await expect(page.getByTestId('tag-rename-note')).toContainText('at least one character');
    await expect(page.getByTestId('tag-rename-confirm')).toBeDisabled();
    await input.fill('home');
    await expect(page.getByTestId('tag-rename-note')).toContainText('#home exists already');
    await input.fill('job');
    await expect(page.getByTestId('tag-rename-note')).toHaveText('Rename #work to #job in 2 pages?');
    await page.getByTestId('tag-rename-confirm').click();

    await expect(page.getByTestId('undo-toast')).toContainText('Renamed #work to #job in 2 pages');
    await expect(page.getByTestId('tag-count-job')).toHaveText('3');
    await expect(page.getByTestId('tag-row-work')).toHaveCount(0);
    // The open page shows the new tag (it was reloaded).
    await expect(page.getByTestId('editor-content')).toContainText('Notes about #job');

    // Only `tags` changes, plus the `updated` stamp every Gumply save writes.
    expect(await read('Plan.md')).toMatch(/^---\ntags: \[job\]\nstatus: draft\nupdated: [^\n]+\n---\n\nThe plan\. #job\/ideas\n$/);
    expect(await read('Notes.md')).toBe('Notes about #job and `#work` in code, [a link](#work).\n\n```\n#work\n```\n');
    expect(await read('Home.md')).toBe(FILES['Home.md']);
  });

  test('the open page with edits that cannot be saved is skipped and reported, never overwritten', async ({ page, request, vault }) => {
    void vault;
    await seedVault(request);
    await page.goto('/#/Notes');
    await expect(page.getByTestId('editor-content')).toContainText('Notes about #work');
    // Saves of the open page fail from now on (as in a conflict).
    await page.route('**/api/pages/Notes', (route) =>
      route.request().method() === 'PUT' ? route.fulfill({ status: 500, body: '{"error":"nope"}' }) : route.continue(),
    );
    await page.getByTestId('editor-content').getByText('Notes about').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' unsaved');
    await page.getByTestId('tags-pane-toggle').click();
    await page.getByTestId('tag-row-work').click({ button: 'right' });
    await page.getByTestId('tag-rename-input').fill('job');
    await page.getByTestId('tag-rename-confirm').click();

    await expect(page.getByTestId('undo-toast')).toContainText('Renamed #work to #job in 1 page');
    await expect(page.getByTestId('undo-toast')).toContainText('1 page was left alone');
    expect(await read('Notes.md')).toBe(FILES['Notes.md']);
    expect(await read('Plan.md')).toContain('#job/ideas');
    // The typing is still there.
    await expect(page.getByTestId('editor-content')).toContainText('unsaved');
  });

  test('right-click a tag to rename; Escape cancels and nothing changes', async ({ page, request, vault }) => {
    void vault;
    await seedVault(request);
    await page.goto('/#/Home');
    await page.getByTestId('tags-pane-toggle').click();
    await page.getByTestId('tag-row-home').click({ button: 'right' });
    await expect(page.getByTestId('tag-rename-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('tag-rename-dialog')).toHaveCount(0);
    expect(await read('Home.md')).toBe(FILES['Home.md']);
  });
});
