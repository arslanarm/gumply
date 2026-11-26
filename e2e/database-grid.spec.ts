import fs from 'node:fs/promises';
import path from 'node:path';
import type { APIRequestContext } from '@playwright/test';
import { api, expect, test } from './fixtures';
import { API_URL, E2E_VAULT } from './support/env';

/**
 * #7prbquxu phase 1, step 5 (spec/database-tables §4): a database that owns its rows is a grid. The keyboard
 * moves one active cell; typing into a text or number cell edits it in place and writes only that line; Tab
 * from the typing row makes the row and goes on into its next column; Delete clears; Escape leaves the grid.
 */

const read = (relative: string) => fs.readFile(path.join(E2E_VAULT, relative), 'utf8');

async function writeVault(request: APIRequestContext, files: Record<string, string>) {
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(E2E_VAULT, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, 'utf8');
  }
  const ids = Object.keys(files).filter((file) => file.endsWith('.md')).map((file) => file.replace(/\.md$/, ''));
  await expect
    .poll(async () => {
      const listed = new Set((await api.listPages(request)).map((meta) => meta.id));
      return ids.every((id) => listed.has(id));
    }, { timeout: 10_000 })
    .toBe(true);
}

/** An owned database as New database writes one, with two columns, and two invented rows. */
const PEOPLE = {
  'People.base':
    'gumply:\n  rows: People\nfilters:\n  and:\n    - file.folder == "People"\nviews:\n  - type: table\n    name: Table\n    order:\n      - file.name\n      - role\n      - age\n',
  'People/Ann.md': '---\nrole: Cook\nage: 30\n---\nAnn\n',
  'People/Bo.md': '---\nrole: Pilot\nage: 41\n---\nBo\n',
};

test('an owned database is a grid: arrows, typing in place, Tab from the typing row, Delete and Escape', async ({ page, request, vault }) => {
  void vault;
  await writeVault(request, PEOPLE);
  await page.goto('/');
  await page.getByTestId('page-item-People.base').click();
  await expect(page.getByTestId('base-table').locator('.base-title-text')).toHaveText(['Ann', 'Bo']);

  // From the typing row, ArrowUp: the last row's name cell is active and holds the focus.
  const typing = page.getByTestId('base-typing-input');
  await typing.click();
  await typing.press('ArrowUp');
  const cell = page.getByTestId('base-grid-cell');
  await expect(cell).toBeFocused();
  await expect(cell).toHaveAttribute('data-active', /^People\/Bo\|/);

  // Right to "role", type over it, Enter: only the role line changes.
  await page.keyboard.press('ArrowRight');
  await expect(cell).toHaveAttribute('data-active', /^People\/Bo\|.*role$/);
  await page.keyboard.type('Chef');
  await expect(cell).toHaveClass(/is-typing/);
  await page.keyboard.press('Enter');
  await expect.poll(() => read('People/Bo.md')).toBe('---\nrole: Chef\nage: 41\n---\nBo\n');

  // The typing row: a name and Tab make the row and go on into its "role" cell.
  await typing.click();
  await typing.fill('Cy');
  await typing.press('Tab');
  await expect(page.getByTestId('base-table').locator('.base-title-text')).toHaveText(['Ann', 'Bo', 'Cy']);
  await expect(cell).toHaveAttribute('data-active', /^People\/Cy\|.*role$/);
  await expect(cell).toBeFocused();
  await page.keyboard.type('Diver');
  await page.keyboard.press('Enter');
  await expect.poll(() => read('People/Cy.md')).toMatch(/^---\n[^]*\nrole: Diver\n---\n/);

  // Up to Ann's age, Delete: the value is gone, the rest of the file as it was.
  await typing.click();
  await typing.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(cell).toHaveAttribute('data-active', /^People\/Ann\|.*age$/);
  await page.keyboard.press('Delete');
  await expect.poll(() => read('People/Ann.md')).not.toContain('age: 30');
  expect(await read('People/Ann.md')).toContain('role: Cook\n');

  // Escape leaves the grid.
  await page.keyboard.press('Escape');
  await expect(cell).toHaveCount(0);
});

test('"+" at the end of the header adds a property column; a key typed elsewhere keeps its type', async ({ page, request, vault }) => {
  void vault;
  await writeVault(request, { ...PEOPLE, 'Elsewhere.md': '---\nstarted: 2026-01-05\n---\nNot a row\n' });
  await page.goto('/');
  await page.getByTestId('page-item-People.base').click();
  await expect(page.getByTestId('base-table').locator('.base-title-text')).toHaveText(['Ann', 'Bo']);

  // A new key: name, type Number, Add. The view gains the column; the file gains one order line.
  await page.getByTestId('base-add-column-button').click();
  const name = page.getByTestId('base-add-column-name');
  await expect(name).toBeFocused();
  await name.fill('shoe size');
  await page.getByTestId('base-add-column-type-number').click();
  await page.getByTestId('base-add-column-submit').click();
  await expect(page.getByTestId('base-add-column')).toHaveCount(0);
  await expect.poll(() => read('People.base')).toBe(PEOPLE['People.base'] + '      - shoe size\n');
  await expect(page.getByTestId('base-th-note.shoe size')).toBeVisible();
  // No page has the key yet, so it's only in the types file (Obsidian's when the vault has one).
  const typeOf = async (key: string) => {
    for (const file of ['.obsidian/types.json', '.gumply/types.json']) {
      const text = await read(file).catch(() => null);
      if (text) return (JSON.parse(text) as { types?: Record<string, string> }).types?.[key];
    }
    return undefined;
  };
  await expect.poll(() => typeOf('shoe size')).toBe('number');

  // A key that's a date elsewhere: the panel says so, and the type list can't change it.
  await page.getByTestId('base-add-column-button').click();
  await name.fill('started');
  await expect(page.getByTestId('base-add-column-known')).toContainText('started');
  await expect(page.getByTestId('base-add-column-type-date')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('base-add-column-type-text')).toBeDisabled();
  await name.press('Enter');
  await expect.poll(() => read('People.base')).toContain('      - shoe size\n      - started\n');

  // A key typed only in the types file (no page uses it): "+" as Text leaves its stored type.
  await request.put(`${API_URL}/api/properties/budget`, { data: { type: 'number' } });
  await page.getByTestId('base-add-column-button').click();
  await name.fill('budget');
  await page.getByTestId('base-add-column-type-text').click();
  await page.getByTestId('base-add-column-submit').click();
  await expect.poll(() => read('People.base')).toContain('      - budget\n');
  expect(await storedType('budget')).toBe('number');

  // A column the view already shows can't be added twice.
  await page.getByTestId('base-add-column-button').click();
  await name.fill('role');
  await expect(page.getByTestId('base-add-column-error')).toContainText('role');
  await expect(page.getByTestId('base-add-column-submit')).toBeDisabled();
});

test('the column menu renames a property in the rows, changes its type, and deletes it from all rows', async ({ page, request, vault }) => {
  void vault;
  await writeVault(request, { ...PEOPLE, 'Elsewhere.md': '---\nrole: Not a row\n---\nOutside the database\n' });
  await page.goto('/');
  await page.getByTestId('page-item-People.base').click();
  await expect(page.getByTestId('base-table').locator('.base-title-text')).toHaveText(['Ann', 'Bo']);

  // Rename "role" to "job": this database's rows and its column follow; a page outside keeps "role".
  await page.getByTestId('base-th-note.role').click();
  await page.getByTestId('base-rename-column').click();
  const input = page.getByTestId('base-rename-column-input');
  await input.fill('job');
  await input.press('Enter');
  await expect.poll(() => read('People/Ann.md')).toBe('---\njob: Cook\nage: 30\n---\nAnn\n');
  await expect.poll(() => read('People/Bo.md')).toBe('---\njob: Pilot\nage: 41\n---\nBo\n');
  expect(await read('Elsewhere.md')).toBe('---\nrole: Not a row\n---\nOutside the database\n');
  await expect.poll(() => read('People.base')).toContain('      - job\n      - age\n');
  await expect(page.getByTestId('base-th-note.job')).toBeVisible();

  // Change "age" to Text: the type is set; the values stay as written.
  await page.getByTestId('base-th-note.age').click();
  await page.getByTestId('base-column-type-text').click();
  await expect
    .poll(async () => ((await (await request.get(`${API_URL}/api/properties`)).json()) as Array<{ key: string; type: string }>).find((info) => info.key === 'age')?.type)
    .toBe('text');
  expect(await read('People/Ann.md')).toContain('age: 30\n');

  // Delete "age" from all rows: asked first (Cancel changes nothing), then gone from rows and columns.
  await page.getByTestId('base-th-note.age').click();
  await page.getByTestId('base-delete-column').click();
  await expect(page.getByTestId('base-delete-column-dialog')).toBeVisible();
  await page.getByTestId('base-delete-column-dialog-cancel').click();
  expect(await read('People/Ann.md')).toContain('age: 30\n');
  await page.getByTestId('base-th-note.age').click();
  await page.getByTestId('base-delete-column').click();
  await page.getByTestId('base-delete-column-dialog-confirm').click();
  await expect.poll(() => read('People/Ann.md')).toBe('---\njob: Cook\n---\nAnn\n');
  await expect.poll(() => read('People/Bo.md')).toBe('---\njob: Pilot\n---\nBo\n');
  await expect.poll(() => read('People.base')).not.toContain('age');
  await expect(page.getByTestId('base-th-note.age')).toHaveCount(0);
});

test('an IME composition on an active cell starts the edit and keeps every character (ru)', async ({ page, context, request, vault }) => {
  test.skip(test.info().project.name !== 'chromium', 'CDP input methods are Chromium-only');
  void vault;
  await writeVault(request, PEOPLE);
  await page.goto('/');
  await page.getByTestId('page-item-People.base').click();
  await expect(page.getByTestId('base-table').locator('.base-title-text')).toHaveText(['Ann', 'Bo']);
  const typing = page.getByTestId('base-typing-input');
  await typing.click();
  await typing.press('ArrowUp');
  await page.keyboard.press('ArrowRight');
  const cell = page.getByTestId('base-grid-cell');
  await expect(cell).toHaveAttribute('data-active', /^People\/Bo\|.*role$/);

  // A composition on the active cell (no key typed first): the edit starts with it, nothing is lost.
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'п', selectionStart: 1, selectionEnd: 1 });
  await expect(cell).toHaveClass(/is-typing/);
  await cdp.send('Input.imeSetComposition', { text: 'пов', selectionStart: 3, selectionEnd: 3 });
  await cdp.send('Input.insertText', { text: 'повар' }); // commits the composition
  await expect(cell).toHaveValue('повар');
  await page.keyboard.press('Enter');
  await expect.poll(() => read('People/Bo.md')).toBe('---\nrole: повар\nage: 41\n---\nBo\n');
});

/** Open People.base and wait for the table. */
async function openPeople(page: import('@playwright/test').Page, titles: string[]) {
  await page.goto('/');
  await page.getByTestId('page-item-People.base').click();
  await expect(page.getByTestId('base-table').locator('.base-title-text')).toHaveText(titles);
}

async function renameColumn(page: import('@playwright/test').Page, from: string, to: string) {
  await page.getByTestId(`base-th-note.${from}`).click();
  await page.getByTestId('base-rename-column').click();
  const input = page.getByTestId('base-rename-column-input');
  await input.fill(to);
  await input.press('Enter');
}

test('a column rename reaches every row of the database, also rows the view hides and rows with an empty value (@opus-hunter)', async ({ page, request, vault }) => {
  void vault;
  await writeVault(request, {
    // The view shows one row (limit: 1); Cy has the key with no value.
    'People.base': PEOPLE['People.base'] + '    limit: 1\n',
    'People/Ann.md': PEOPLE['People/Ann.md'],
    'People/Bo.md': PEOPLE['People/Bo.md'],
    'People/Cy.md': '---\nrole:\nage: 7\n---\nCy\n',
  });
  await openPeople(page, ['Ann']);
  // One request changes the rows and the base together (@lead): no separate base save follows it.
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET' && /\/api\/(bases|pages)\//.test(request.url())) writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  await renameColumn(page, 'role', 'job');
  await expect.poll(() => read('People/Bo.md')).toBe('---\njob: Pilot\nage: 41\n---\nBo\n');
  await expect.poll(() => read('People/Cy.md')).toBe('---\njob:\nage: 7\n---\nCy\n');
  await expect.poll(() => read('People/Ann.md')).toBe('---\njob: Cook\nage: 30\n---\nAnn\n');
  await expect.poll(() => read('People.base')).toContain('      - job\n');
  expect(writes.filter((write) => !write.includes('/api/properties/'))).toEqual([`POST /api/bases/${encodeURIComponent('People.base')}/rows-property`]);
});

/** A key's type as stored (the types file Gumply uses: Obsidian's when the vault has one). */
async function storedType(key: string) {
  for (const file of ['.obsidian/types.json', '.gumply/types.json']) {
    const text = await read(file).catch(() => null);
    if (text) return (JSON.parse(text) as { types?: Record<string, string> }).types?.[key];
  }
  return undefined;
}

test('a column rename keeps a type the new name already has, even one no page uses yet (@opus-hunter)', async ({ page, request, vault }) => {
  void vault;
  await writeVault(request, PEOPLE);
  // Typed in the types file only (Obsidian keeps entries after a key's last use).
  await request.put(`${API_URL}/api/properties/priority`, { data: { type: 'number' } });
  await expect.poll(() => storedType('priority')).toBe('number');
  await openPeople(page, ['Ann', 'Bo']);
  await renameColumn(page, 'role', 'priority');
  await expect.poll(() => read('People/Ann.md')).toContain('priority: Cook\n');
  await expect.poll(() => read('People.base')).toContain('      - priority\n');
  expect(await storedType('priority')).toBe('number');
});

test('a column rename to a name some row already has changes nothing and names the row (@lead, @opus-hunter)', async ({ page, request, vault }) => {
  void vault;
  // Bo already has "job" (the view doesn't show it). Refusing rows mid-rename are the server test's (bases.test.ts).
  await writeVault(request, { ...PEOPLE, 'People/Bo.md': '---\nrole: Pilot\nage: 41\njob: Pilot\n---\nBo\n' });
  await openPeople(page, ['Ann', 'Bo']);
  await renameColumn(page, 'role', 'job');
  await expect(page.getByRole('alert')).toContainText('Bo');
  await expect(page.getByRole('alert')).toContainText('Nothing was renamed');
  expect(await read('People/Ann.md')).toBe(PEOPLE['People/Ann.md']);
  expect(await read('People.base')).toBe(PEOPLE['People.base']);
});

// #zh87z4pf: fails in file order because an earlier test's reset re-creates People/, which is then never watched
// again (directory watchers keyed by path). Re-enable with that fix.
test.fixme('an outside edit made before a column rename is kept, and the key follows it (@lead)', async ({ page, request, vault }) => {
  void vault;
  await writeVault(request, PEOPLE);
  await openPeople(page, ['Ann', 'Bo']);
  const ann = path.join(E2E_VAULT, 'People/Ann.md');
  // An ordinary save by another app (a temp file renamed over the page). A same-size, same-mtime write is
  // the server test's (bases.test.ts); seeing one through the page API is #dqdwz9qw's.
  await fs.writeFile(`${ann}.tmp-outside`, '---\nrole: Chef\nage: 30\n---\nAnn\n', 'utf8');
  await fs.rename(`${ann}.tmp-outside`, ann);
  await expect
    .poll(async () => ((await api.getPage(request, 'People/Ann')) as { properties?: Array<{ key: string; value: unknown }> }).properties?.find((p) => p.key === 'role')?.value, { timeout: 15_000 })
    .toBe('Chef');
  await renameColumn(page, 'role', 'job');
  await expect.poll(() => read('People/Ann.md')).toBe('---\njob: Chef\nage: 30\n---\nAnn\n');
  await expect.poll(() => read('People/Bo.md')).toBe('---\njob: Pilot\nage: 41\n---\nBo\n');
});
