import fs from 'node:fs/promises';
import path from 'node:path';
import type { APIRequestContext, Page } from '@playwright/test';
import { api, expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';
import { expectPageTitle } from './support/ui';

/**
 * v0.7 B (#sg36ng2d, D34, spec/api-bases): database views are Obsidian Bases
 * `.base` files. The table runs on the server; every change writes Obsidian
 * syntax and only the lines it changed.
 */

const read = (relative: string) => fs.readFile(path.join(E2E_VAULT, relative), 'utf8');
const exists = (relative: string) =>
  fs.access(path.join(E2E_VAULT, relative)).then(
    () => true,
    () => false,
  );

async function writeVault(request: APIRequestContext, files: Record<string, string>) {
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(E2E_VAULT, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, 'utf8');
  }
  const ids = Object.keys(files).map((file) => file.replace(/\.md$/, ''));
  // The vault watcher picks the files up.
  await expect
    .poll(async () => {
      const listed = new Set((await api.listPages(request)).map((meta) => meta.id));
      return ids.every((id) => listed.has(id));
    }, { timeout: 10_000 })
    .toBe(true);
}

/** A base the way Obsidian writes one, with a comment and a view Gumply doesn't draw. */
const TASKS_BASE = `# Project tasks
filters:
  and:
    - file.inFolder("Projects")
views:
  - type: table
    name: All tasks
    order:
      - file.name
      - status
      - due
      - estimate
    sort:
      - property: due
        direction: ASC
  - type: map
    name: Places
    mapZoom: { level: 3 }
`;

const PROJECT_FILES = {
  'Projects/Alpha.md': '---\nstatus: Todo\ndue: 2026-12-01\nestimate: 3\n---\nAlpha\n',
  'Projects/Beta.md': '---\nstatus: Doing\ndue: 2026-11-25\nestimate: 5\n---\nBeta\n',
  'Projects/Gamma.md': '---\nstatus: Done\nestimate: 1\n---\nGamma\n',
  'Elsewhere.md': '---\nstatus: Todo\n---\nNot a project\n',
  'Projects/Tasks.base': TASKS_BASE,
};

const titles = (page: Page) => page.getByTestId('base-table').locator('.base-title-text');

test.describe('database views (.base, D34)', () => {
  test('a .base file is a tree item that opens as a table of its folder, and opening it writes nothing', async ({ page, request, vault }) => {
    void vault;
    await writeVault(request, PROJECT_FILES);
    await page.goto('/#/Projects/Tasks.base');
    await expectPageTitle(page, 'Tasks');
    await expect(page.getByTestId('base-icon-Projects/Tasks.base')).toBeVisible();

    // The folder's pages, sorted by due date (no date last); Elsewhere is filtered out.
    await expect(titles(page)).toHaveText(['Beta', 'Alpha', 'Gamma']);
    await expect(page.getByTestId('base-table').locator('.base-th-label')).toHaveText(['Name', 'status', 'due', 'estimate']);
    await expect(page.getByTestId('base-cell-Projects/Beta-note.status')).toHaveText('Doing');
    await expect(page.getByTestId('base-count')).toHaveText('3 pages');
    await expect(page.getByTestId('base-source-button')).toContainText('In Projects');

    // A view Gumply doesn't draw is listed and kept.
    await page.getByTestId('base-tab-Places').click();
    await expect(page.getByTestId('base-unsupported')).toContainText('“map” views');

    // Clicking a title opens the page.
    await page.getByTestId('base-tab-All tasks').click();
    await page.getByTestId('base-open-Projects/Alpha').click();
    await expectPageTitle(page, 'Alpha');

    expect(await read('Projects/Tasks.base')).toBe(TASKS_BASE);
  });

  test('filter, sort and properties write Obsidian expressions and only the lines they change', async ({ page, request, vault }) => {
    void vault;
    await writeVault(request, PROJECT_FILES);
    await page.goto('/#/Projects/Tasks.base');
    await expect(titles(page)).toHaveText(['Beta', 'Alpha', 'Gamma']);

    // Filter: status is Doing.
    await page.getByTestId('base-filter-button').click();
    await page.getByTestId('base-add-rule').click();
    const rule = page.getByTestId('base-rule');
    await rule.getByTestId('base-rule-property').selectOption('note.status');
    await rule.getByTestId('base-rule-op').selectOption('is');
    await rule.getByTestId('base-rule-value').fill('Doing');
    await rule.getByTestId('base-rule-value').press('Enter');
    await expect(titles(page)).toHaveText(['Beta']);
    await expect
      .poll(() => read('Projects/Tasks.base'))
      .toBe(TASKS_BASE.replace('        direction: ASC\n', '        direction: ASC\n    filters:\n      and:\n        - status == "Doing"\n'));

    // Removing it puts the file back byte for byte.
    await rule.getByRole('button', { name: 'Remove filter' }).click();
    await expect(titles(page)).toHaveText(['Beta', 'Alpha', 'Gamma']);
    await expect.poll(() => read('Projects/Tasks.base')).toBe(TASKS_BASE);
    await page.keyboard.press('Escape');

    // Sort from a column header.
    await page.getByTestId('base-th-note.estimate').click();
    await page.getByTestId('base-column-menu').getByRole('menuitem', { name: 'Sort descending' }).click();
    await expect(titles(page)).toHaveText(['Beta', 'Alpha', 'Gamma']);
    await expect
      .poll(() => read('Projects/Tasks.base'))
      .toBe(
        TASKS_BASE.replace(
          '    sort:\n      - property: due\n        direction: ASC\n',
          '    sort:\n      - property: estimate\n        direction: DESC\n      - property: due\n        direction: ASC\n',
        ),
      );

    // Hide a column from the Properties panel.
    await page.getByTestId('base-properties-button').click();
    await page.getByTestId('base-property-note.due').uncheck();
    await expect(page.getByTestId('base-table').locator('.base-th-label')).toHaveText(['Name', 'status', 'estimate']);
    await expect.poll(() => read('Projects/Tasks.base')).toContain('      - status\n      - estimate\n');
    // The view Gumply doesn't draw is untouched.
    expect(await read('Projects/Tasks.base')).toContain('  - type: map\n    name: Places\n    mapZoom: { level: 3 }\n');
  });

  test('the source picks a folder or a tag', async ({ page, request, vault }) => {
    void vault;
    await writeVault(request, {
      ...PROJECT_FILES,
      'Elsewhere.md': '---\nstatus: Todo\ntags: [work]\n---\nTagged\n',
    });
    await page.goto('/#/Projects/Tasks.base');
    await expect(titles(page)).toHaveText(['Beta', 'Alpha', 'Gamma']);
    await page.getByTestId('base-source-button').click();
    await page.getByTestId('base-source-tag').fill('work');
    await page.getByTestId('base-source-tag').press('Enter');
    await expect(titles(page)).toHaveText(['Elsewhere']);
    await expect.poll(() => read('Projects/Tasks.base')).toContain('    - file.hasTag("work")\n');
    await expect(page.getByTestId('base-source-button')).toContainText('Tagged #work');
  });

  test('views: add, rename, duplicate and delete tabs', async ({ page, request, vault }) => {
    void vault;
    await writeVault(request, PROJECT_FILES);
    await page.goto('/#/Projects/Tasks.base');
    await expect(titles(page)).toHaveCount(3);

    await page.getByTestId('base-add-view').click();
    await page.getByTestId('base-add-view-table').click();
    await expect(page.getByTestId('base-tab-Table')).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => read('Projects/Tasks.base')).toContain('  - type: table\n    name: Table\n    order:\n      - file.name\n');

    await page.getByTestId('base-tab-Table').dblclick();
    await page.getByTestId('base-tab-rename').fill('Quick look');
    await page.getByTestId('base-tab-rename').press('Enter');
    await expect(page.getByTestId('base-tab-Quick look')).toBeVisible();
    await expect.poll(() => read('Projects/Tasks.base')).toContain('    name: Quick look\n');

    await page.getByTestId('base-tab-Quick look').click();
    await page.getByTestId('base-duplicate-view').click();
    await expect(page.getByTestId('base-tab-Quick look copy')).toHaveAttribute('aria-selected', 'true');

    await page.getByTestId('base-tab-Quick look copy').click();
    await page.getByTestId('base-delete-view').click();
    // A click selects a tab; a click on the selected tab opens its menu.
    await page.getByTestId('base-tab-Quick look').click();
    await expect(page.getByTestId('base-tab-Quick look')).toHaveAttribute('aria-selected', 'true');
    await page.getByTestId('base-tab-Quick look').click();
    await page.getByTestId('base-delete-view').click();
    await expect(page.getByTestId('base-tab-Quick look')).toHaveCount(0);
    await expect.poll(() => read('Projects/Tasks.base')).toBe(TASKS_BASE);
  });

  test('New database view in the sidebar and inside a folder; + New adds a page to the source folder', async ({ page, request, vault }) => {
    void vault;
    await writeVault(request, PROJECT_FILES);
    await page.goto('/#/Projects/Alpha');
    await expectPageTitle(page, 'Alpha');

    // ⋯ on the folder → Add database view inside: a table of that folder.
    await page.getByTestId('page-item-Projects').hover();
    await page.getByTestId('page-menu-button-Projects').click();
    await page.getByTestId('add-base-Projects').click();
    await expect(page.getByTestId('base-page')).toBeVisible();
    const input = page.getByTestId('page-title-input');
    await expect(input).toBeFocused();
    await input.fill('Sprint');
    await input.press('Enter');
    await expect(page.getByTestId('page-item-Projects/Sprint.base')).toBeVisible();
    await expect.poll(() => read('Projects/Sprint.base')).toBe(
      'filters:\n  and:\n    - file.inFolder("Projects")\nviews:\n  - type: table\n    name: Table\n    order:\n      - file.name\n',
    );
    await expect(titles(page)).toHaveText(['Alpha', 'Beta', 'Gamma']);

    // + New: a page in Projects, its title open for typing.
    await page.getByTestId('base-new-row').click();
    const title = page.locator('[data-testid^="base-title-input-"]');
    await expect(title).toBeFocused();
    await title.fill('Delta');
    await title.press('Enter');
    await expect(titles(page)).toHaveText(['Alpha', 'Beta', 'Delta', 'Gamma']);
    await expect.poll(() => exists('Projects/Delta.md')).toBe(true);

    // The sidebar's New database view: at the top level, all pages.
    await page.getByTestId('new-base-button').click();
    await expect(page.getByTestId('page-title-input')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('page-item-Untitled database.base')).toBeVisible();
    expect(await read('Untitled database.base')).toBe('views:\n  - type: table\n    name: Table\n    order:\n      - file.name\n');
  });

  test('a filter Gumply cannot evaluate is skipped and named; a broken file is shown, never written', async ({ page, request, vault }) => {
    void vault;
    const odd = 'filters:\n  and:\n    - file.backlinks.length > 1\nviews:\n  - type: table\n    name: T\n';
    await writeVault(request, { ...PROJECT_FILES, 'Odd.base': odd, 'Broken.base': 'views: [\n' });
    await page.goto('/#/Odd.base');
    await expect(page.getByTestId('base-warning')).toContainText('file.backlinks.length > 1');
    await expect(titles(page)).toHaveCount(4);

    await page.goto('/#/Broken.base');
    await expect(page.getByTestId('base-broken')).toBeVisible();
    expect(await read('Broken.base')).toBe('views: [\n');
    expect(await read('Odd.base')).toBe(odd);
  });

  test('![[X.base#View]] in a page shows that view live; the line stays byte-exact; Open opens the base', async ({ page, request, vault }) => {
    void vault;
    const home = 'Intro\n\n![[Tasks.base#All tasks]]\n\nAfter\n';
    await writeVault(request, { ...PROJECT_FILES, 'Home.md': home });
    await page.goto('/#/Home');
    const embed = page.getByTestId('base-embed');
    await expect(embed.getByTestId('base-embed-title')).toContainText('Tasks');
    await expect(embed.getByTestId('base-embed-title')).toContainText('All tasks');
    await expect(embed.locator('.base-title-text')).toHaveText(['Beta', 'Alpha', 'Gamma']);

    // An edit elsewhere in the page keeps the embed line as written.
    await page.getByTestId('editor-content').getByText('After').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' words');
    await expect.poll(() => read('Home.md'), { timeout: 8_000 }).toBe('Intro\n\n![[Tasks.base#All tasks]]\n\nAfter words\n');

    await embed.getByTestId('base-embed-open').click();
    await expectPageTitle(page, 'Tasks');
    await expect(page.getByTestId('base-page')).toBeVisible();
  });

  test('an embedded base knows this: the page it sits in', async ({ page, request, vault }) => {
    void vault;
    await writeVault(request, {
      'Hub.md': 'Hub\n\n![[Linked.base]]\n',
      'Linked.base': "filters: 'file.hasLink(this.file)'\nviews:\n  - type: table\n    name: Linking here\n",
      'Notes/One.md': 'See [[Hub]]\n',
      'Notes/Two.md': 'Not linked\n',
      'Notes/Three.md': 'Also [[Hub|the hub]]\n',
    });
    await page.goto('/#/Hub');
    await expect(page.getByTestId('base-embed').locator('.base-title-text')).toHaveText(['One', 'Three']);
  });

  test('/database makes a database view of the page\'s sub-pages and embeds it', async ({ page, request, vault }) => {
    void vault;
    await vault.seed([{ title: 'Planning', content: 'Plans' }]);
    await page.goto('/#/Planning');
    await page.getByTestId('editor-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('/database');
    await expect(page.getByTestId('slash-menu-item-database')).toContainText('Database view');
    await page.keyboard.press('Enter');
    const embed = page.getByTestId('base-embed');
    await expect(embed.getByTestId('base-embed-title')).toContainText('Untitled database');
    await expect.poll(() => exists('Planning/Untitled database.base')).toBe(true);
    expect(await read('Planning/Untitled database.base')).toContain('file.inFolder("Planning")');
    await expect.poll(async () => (await api.getPage(request, 'Planning')).content, { timeout: 8_000 }).toBe(
      'Plans\n\n![[Untitled database.base]]',
    );
  });

  test('Cmd+K offers Create database view “X”', async ({ page, request, vault }) => {
    void vault;
    await writeVault(request, PROJECT_FILES);
    await page.goto('/#/Projects/Alpha');
    await expectPageTitle(page, 'Alpha');
    await page.keyboard.press('ControlOrMeta+k');
    await page.keyboard.type('Reading list');
    const row = page.getByTestId('search-create-base');
    await expect(row).toHaveText('Create database view “Reading list”');
    await row.click();
    await expect(page.getByTestId('base-page')).toBeVisible();
    await expectPageTitle(page, 'Reading list');
    await expect.poll(() => exists('Reading list.base')).toBe(true);
  });
});
