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
  // It changes "age" to Text: put the vault's types back however it ends, so later tests start as this one did.
  try {
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
  } finally {
    await request.put(`${API_URL}/api/properties/age`, { data: { type: 'number' } });
  }
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

test('an outside edit made before a column rename is kept, and the key follows it (@lead)', async ({ page, request, vault }) => {
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

/** A paste on the focused element, as a spreadsheet's copy puts it on the clipboard. */
async function paste(page: import('@playwright/test').Page, text: string, html = '') {
  await page.evaluate(
    ([plain, rich]) => {
      const data = new DataTransfer();
      data.setData('text/plain', plain);
      if (rich) data.setData('text/html', rich);
      document.activeElement?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    },
    [text, html] as const,
  );
}

test('a block pasted at the active cell overwrites down and right, and rows past the end become new rows (phase 2)', async ({ page, request, vault }) => {
  void vault;
  await writeVault(request, PEOPLE);
  // The vault's types file outlives a test (another case makes "age" Text): say what this one needs.
  await request.put(`${API_URL}/api/properties/age`, { data: { type: 'number' } });
  await openPeople(page, ['Ann', 'Bo']);
  const typing = page.getByTestId('base-typing-input');
  await typing.click();
  await typing.press('ArrowUp');
  await page.keyboard.press('ArrowRight');
  const cell = page.getByTestId('base-grid-cell');
  await expect(cell).toHaveAttribute('data-active', /^People\/Bo\|.*role$/);

  // From Bo's role: Bo gets role and age; the next line becomes a new row (no name pasted: Untitled).
  await paste(page, 'Chef\t50\r\nDiver\t7\r\n');
  await expect.poll(() => read('People/Bo.md')).toBe('---\nrole: Chef\nage: 50\n---\nBo\n');
  await expect(page.getByTestId('base-table').locator('.base-title-text')).toHaveText(['Ann', 'Bo', 'Untitled']);
  await expect.poll(() => read('People/Untitled.md')).toMatch(/role: Diver\n[^]*age: 7\n|age: 7\n[^]*role: Diver\n/);

  // A value that isn't a number is left out, and the note says so.
  await page.getByTestId('base-typing-input').click();
  await page.getByTestId('base-typing-input').press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowRight');
  await expect(cell).toHaveAttribute('data-active', /^People\/Bo\|.*role$/);
  await paste(page, 'Pilot\tlots');
  await expect.poll(() => read('People/Bo.md')).toBe('---\nrole: Pilot\nage: 50\n---\nBo\n');
  await expect(page.getByTestId('base-paste-note')).toContainText('1 pasted cell was left out');
});

test('one pasted value goes into the active cell as typing would, commas and all (phase 2)', async ({ page, request, vault }) => {
  void vault;
  await writeVault(request, PEOPLE);
  await openPeople(page, ['Ann', 'Bo']);
  const typing = page.getByTestId('base-typing-input');
  await typing.click();
  await typing.press('ArrowUp');
  await page.keyboard.press('ArrowRight');
  const cell = page.getByTestId('base-grid-cell');
  await paste(page, 'Cook, head');
  await expect(cell).toHaveClass(/is-typing/);
  await expect(cell).toHaveValue('Cook, head');
  await page.keyboard.press('Enter');
  await expect.poll(() => read('People/Bo.md')).toMatch(/^---\nrole: "?Cook, head"?\nage: 41\n---\nBo\n$/);
});

test('a block pasted on the typing row of an empty database opens the preview; Paste makes the rows and columns in one request (phase 2, step 3)', async ({ page, request, vault }) => {
  void vault;
  await writeVault(request, { 'People.base': PEOPLE['People.base'] });
  await fs.mkdir(path.join(E2E_VAULT, 'People'), { recursive: true });
  await page.goto('/');
  await page.getByTestId('page-item-People.base').click();
  const typing = page.getByTestId('base-typing-input');
  await typing.click();
  await paste(page, 'Name\tshoe size\trole\nIvy\t38\tCook\nOtto\t42\tPilot\n');

  const preview = page.getByTestId('base-paste-preview');
  await expect(preview).toContainText('Paste 2 rows into “People”');
  await expect(page.getByTestId('base-paste-headers')).toBeChecked();
  await expect(page.getByTestId('base-paste-name-1')).toHaveValue('shoe size');
  await expect(page.getByTestId('base-paste-type-1')).toHaveValue('number');
  // "role" is a column already: its type is kept.
  await expect(page.getByTestId('base-paste-type-2')).toBeDisabled();

  const writes: string[] = [];
  page.on('request', (r) => {
    if (r.method() !== 'GET' && /\/api\/(bases|pages)\b/.test(r.url())) writes.push(`${r.method()} ${new URL(r.url()).pathname}`);
  });
  await page.getByTestId('base-paste-confirm').click();
  await expect(page.getByTestId('base-table').locator('.base-title-text')).toHaveText(['Ivy', 'Otto']);
  await expect.poll(() => read('People/Ivy.md')).toMatch(/shoe size: 38\n/);
  await expect.poll(() => read('People/Otto.md')).toMatch(/role: Pilot\n/);
  await expect.poll(() => read('People.base')).toContain('      - age\n      - shoe size\n');
  expect(writes).toEqual([`POST /api/bases/${encodeURIComponent('People.base')}/rows-paste`]);
});

test('"Import CSV…" in the ⋯ panel reads a file with commas into the same preview (phase 2)', async ({ page, request, vault }) => {
  void vault;
  await writeVault(request, PEOPLE);
  await request.put(`${API_URL}/api/properties/age`, { data: { type: 'number' } });
  await openPeople(page, ['Ann', 'Bo']);
  await page.getByTestId('base-settings-button').click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('base-import-csv').click();
  await (await chooser).setFiles({
    name: 'people.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('﻿Name,role,age\r\n"Smith, Jo",Cook,52\r\nIvy,Pilot,31\r\n', 'utf8'),
  });
  const preview = page.getByTestId('base-paste-preview');
  await expect(preview).toContainText('Paste 2 rows into “People”');
  await page.getByTestId('base-paste-confirm').click();
  await expect(page.getByTestId('base-table').locator('.base-title-text')).toHaveText(['Ann', 'Bo', 'Ivy', 'Smith, Jo']);
  await expect.poll(() => read('People/Smith, Jo.md')).toMatch(/role: Cook\n[^]*age: 52\n|age: 52\n[^]*role: Cook\n/);
});

test('Shift+arrows select a block, and Copy gives it as TSV and an HTML table (phase 2)', async ({ page, request, vault }) => {
  void vault;
  await writeVault(request, { ...PEOPLE, 'People/Bo.md': '---\nrole: "Pilot\tand cook"\nage: 41\n---\nBo\n' });
  await openPeople(page, ['Ann', 'Bo']);
  const typing = page.getByTestId('base-typing-input');
  await typing.click();
  await typing.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(page.getByTestId('base-grid-cell')).toHaveAttribute('data-active', /^People\/Ann\|file\.name$/);
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowRight');
  await expect(page.getByTestId('base-grid-selection')).toHaveAttribute('data-range', '0:0-1:1');

  const copied = await page.evaluate(() => {
    const data = new DataTransfer();
    document.activeElement?.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
    return { text: data.getData('text/plain'), html: data.getData('text/html') };
  });
  expect(copied.text).toBe('Ann\tCook\nBo\t"Pilot\tand cook"');
  expect(copied.html).toBe('<table><tr><td>Ann</td><td>Cook</td></tr><tr><td>Bo</td><td>Pilot\tand cook</td></tr></table>');

  // A plain arrow drops the block.
  await page.keyboard.press('ArrowUp');
  await expect(page.getByTestId('base-grid-selection')).toHaveCount(0);
});

test('the column menu makes a column a Select: its options come from the rows, in this base only (phase 3)', async ({ page, request, vault }) => {
  void vault;
  await writeVault(request, PEOPLE);
  await openPeople(page, ['Ann', 'Bo']);
  await page.getByTestId('base-th-note.role').click();
  await page.getByTestId('base-column-type-select').click();
  await expect
    .poll(() => read('People.base'))
    .toContain('properties:\n  note.role:\n    gumplyType: select\n    gumplyOptions:\n      - value: Cook\n        color: brown\n      - value: Pilot\n        color: orange\n');
  // The rows are untouched: a Select is plain text in them.
  expect(await read('People/Ann.md')).toBe(PEOPLE['People/Ann.md']);
  // The cells show coloured chips.
  const chips = page.getByTestId('base-table').getByTestId('base-option-chip');
  await expect(chips).toHaveText(['Cook', 'Pilot']);
  await expect(chips.first()).toHaveAttribute('data-color', 'brown');
  // The menu now says Select; choosing Text drops the options again.
  await page.getByTestId('base-th-note.role').click();
  await expect(page.getByTestId('base-column-type-select')).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('base-column-type-text').click();
  await expect.poll(() => read('People.base')).not.toContain('gumplyType');
});

test('typing on a Select cell opens its picker: Enter picks the match, or adds a new option (phase 3)', async ({ page, request, vault }) => {
  void vault;
  await writeVault(request, PEOPLE);
  await openPeople(page, ['Ann', 'Bo']);
  await page.getByTestId('base-th-note.role').click();
  await page.getByTestId('base-column-type-select').click();
  await expect.poll(() => read('People.base')).toContain('gumplyType: select');

  // Bo's role: "C" opens the picker searching for it; Enter picks Cook.
  const typing = page.getByTestId('base-typing-input');
  await typing.click();
  await typing.press('ArrowUp');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('C');
  await expect(page.getByTestId('base-select-search')).toHaveValue('C');
  await expect(page.getByTestId('base-select-picker')).toContainText('Cook');
  await page.keyboard.press('Enter');
  await expect.poll(() => read('People/Bo.md')).toBe('---\nrole: Cook\nage: 41\n---\nBo\n');
  // A pick closes a Select's picker for good: the grid's request is used up, so it doesn't open again (@opus-hunter).
  await expect(page.getByTestId('base-select-picker')).toHaveCount(0);

  // A value that isn't an option yet: Enter adds it to the base's options and picks it.
  await page.getByTestId('base-typing-input').click();
  await page.getByTestId('base-typing-input').press('ArrowUp');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('D');
  await page.keyboard.type('iver');
  await page.keyboard.press('Enter');
  await expect.poll(() => read('People/Bo.md')).toBe('---\nrole: Diver\nage: 41\n---\nBo\n');
  await expect.poll(() => read('People.base')).toContain('      - value: Diver\n        color: yellow\n');
});

test('a new database in Russian names its first view «Таблица» (@polish-dev)', async ({ page, request, vault }) => {
  void vault;
  void request;
  await page.addInitScript(() => window.localStorage.setItem('gumply:language', 'ru'));
  await page.goto('/');
  await page.getByTestId('new-base-button').click();
  await expect(page.getByTestId('page-title-input')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('base-table')).toBeVisible();
  const file = (await fs.readdir(E2E_VAULT)).find((name) => name.endsWith('.base'))!;
  expect(await read(file)).toContain('    name: Таблица\n');
});

test('"Edit options…" renames an option in the rows, recolours and reorders it in the base, and deletes one with its values (phase 3)', async ({ page, request, vault }) => {
  void vault;
  await writeVault(request, PEOPLE);
  await openPeople(page, ['Ann', 'Bo']);
  await page.getByTestId('base-th-note.role').click();
  await page.getByTestId('base-column-type-select').click();
  await expect.poll(() => read('People.base')).toContain('gumplyType: select');

  const openEditor = async () => {
    await page.getByTestId('base-th-note.role').click();
    await page.getByTestId('base-edit-options').click();
    await expect(page.getByTestId('base-options-editor')).toBeVisible();
  };
  // Rename Cook → Chef: Ann's row follows, and so does the option.
  await openEditor();
  const name = page.getByTestId('base-option-name-Cook');
  await name.fill('Chef');
  await name.press('Enter');
  await expect.poll(() => read('People/Ann.md')).toBe('---\nrole: Chef\nage: 30\n---\nAnn\n');
  await expect.poll(() => read('People.base')).toContain('      - value: Chef\n        color: brown\n');

  // Recolour Pilot and move Chef below it: the base only.
  await page.getByTestId('base-option-color-Pilot-green').click();
  await expect.poll(() => read('People.base')).toContain('      - value: Pilot\n        color: green\n');
  await page.getByTestId('base-option-down-Chef').click();
  await expect.poll(() => read('People.base')).toMatch(/- value: Pilot\n {8}color: green\n {6}- value: Chef\n/);
  expect(await read('People/Bo.md')).toBe(PEOPLE['People/Bo.md']);

  // Delete Pilot and clear it from the rows: Bo loses the value.
  await page.getByTestId('base-option-delete-Pilot').click();
  await page.getByTestId('base-option-delete-clear').click();
  await expect.poll(() => read('People/Bo.md')).not.toContain('Pilot');
  await expect.poll(() => read('People.base')).not.toContain('value: Pilot');
});

test('Cmd/Ctrl+Z undoes table operations and Shift redoes them; an undo over a row changed since is refused, named (phase 4b)', async ({ page, request, vault }) => {
  void vault;
  await writeVault(request, PEOPLE);
  await openPeople(page, ['Ann', 'Bo']);
  const undo = (shift = false) => page.keyboard.press(`ControlOrMeta+${shift ? 'Shift+' : ''}KeyZ`);

  // A cell edit: undone, then redone.
  const typing = page.getByTestId('base-typing-input');
  await typing.click();
  await typing.press('ArrowUp');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.type('Chef');
  await page.keyboard.press('Enter');
  await expect.poll(() => read('People/Bo.md')).toBe('---\nrole: Chef\nage: 41\n---\nBo\n');
  await page.getByTestId('base-table').click({ position: { x: 5, y: 5 } });
  await undo();
  await expect.poll(() => read('People/Bo.md')).toBe(PEOPLE['People/Bo.md']);
  await undo(true);
  await expect.poll(() => read('People/Bo.md')).toBe('---\nrole: Chef\nage: 41\n---\nBo\n');

  // Delete a property from all rows, then undo: every row and the base come back byte for byte.
  const before = { ann: await read('People/Ann.md'), bo: await read('People/Bo.md'), base: await read('People.base') };
  await page.getByTestId('base-th-note.age').click();
  await page.getByTestId('base-delete-column').click();
  await page.getByTestId('base-delete-column-dialog-confirm').click();
  await expect.poll(() => read('People/Ann.md')).not.toContain('age');
  await undo();
  await expect.poll(() => read('People/Ann.md')).toBe(before.ann);
  expect(await read('People/Bo.md')).toBe(before.bo);
  await expect.poll(() => read('People.base')).toBe(before.base);

  // Redo, then another app edits Ann: the undo refuses as a whole and names her.
  await undo(true);
  await expect.poll(() => read('People/Ann.md')).not.toContain('age');
  const ann = path.join(E2E_VAULT, 'People/Ann.md');
  await fs.writeFile(`${ann}.tmp-outside`, (await read('People/Ann.md')) + 'Edited elsewhere.\n', 'utf8');
  await fs.rename(`${ann}.tmp-outside`, ann);
  await expect.poll(async () => (await api.getPage(request, 'People/Ann')).content, { timeout: 15_000 }).toContain('Edited elsewhere');
  await undo();
  await expect(page.getByRole('alert')).toContainText('Ann');
  expect(await read('People/Bo.md')).not.toContain('age');
});

test('the paste preview offers Select for a column of repeated values, and makes it one in the same request (pass 8 follow-up)', async ({ page, request, vault }) => {
  void vault;
  await writeVault(request, { 'People.base': PEOPLE['People.base'] });
  await fs.mkdir(path.join(E2E_VAULT, 'People'), { recursive: true });
  await page.goto('/');
  await page.getByTestId('page-item-People.base').click();
  const typing = page.getByTestId('base-typing-input');
  await typing.click();
  await paste(page, 'Name\tstage\nIvy\tTodo\nOtto\tDone\nAl\tTodo\n');
  // Every column is text, so the header row isn't guessed (spec §5): say so.
  await page.getByTestId('base-paste-headers').check();
  // Guessed as text, with the hint (never a Select by itself).
  await expect(page.getByTestId('base-paste-type-1')).toHaveValue('text');
  await expect(page.getByTestId('base-paste-select-hint-1')).toBeVisible();
  await page.getByTestId('base-paste-type-1').selectOption('select');
  await expect(page.getByTestId('base-paste-select-hint-1')).toHaveCount(0);
  const writes: string[] = [];
  page.on('request', (r) => {
    if (r.method() !== 'GET' && /\/api\/(bases|pages)\b/.test(r.url())) writes.push(`${r.method()} ${new URL(r.url()).pathname}`);
  });
  await page.getByTestId('base-paste-confirm').click();
  await expect(page.getByTestId('base-table').locator('.base-title-text')).toHaveText(['Al', 'Ivy', 'Otto']);
  await expect.poll(() => read('People.base')).toContain('  note.stage:\n    gumplyType: select\n    gumplyOptions:\n      - value: Todo\n        color: brown\n      - value: Done\n        color: orange\n');
  await expect.poll(() => read('People/Ivy.md')).toMatch(/stage: Todo\n/);
  expect(writes).toEqual([`POST /api/bases/${encodeURIComponent('People.base')}/rows-paste`]);
  await expect(page.getByTestId('base-table').getByTestId('base-option-chip').first()).toBeVisible();
});

test('a paste that takes a while says "Pasting N rows…" until it is done (@lead, before phases 2–4 ship)', async ({ page, request, vault }) => {
  void vault;
  await writeVault(request, { 'People.base': PEOPLE['People.base'] });
  await fs.mkdir(path.join(E2E_VAULT, 'People'), { recursive: true });
  await page.goto('/');
  await page.getByTestId('page-item-People.base').click();
  // The server's answer is held back, as a big paste holds it.
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/rows-paste', async (route) => {
    await held;
    await route.continue();
  });
  await expect(page.getByTestId('base-pasting')).toHaveText('');
  await page.getByTestId('base-typing-input').click();
  await paste(page, 'Name\tage\nIvy\t31\nOtto\t8\nAl\t52\n');
  await page.getByTestId('base-paste-confirm').click();
  // A live region that's there before the paste (screen readers announce changes inside one), empty until then.
  const status = page.getByTestId('base-pasting');
  await expect(status).toHaveAttribute('role', 'status');
  await expect(status).toHaveText(/Pasting 3 rows/);
  release();
  await expect(page.getByTestId('base-table').locator('.base-title-text')).toHaveText(['Al', 'Ivy', 'Otto']);
  await expect(status).toHaveText('');
});

test('"+" offers Select and Multi-select: the new column is a Select with no options yet, in one base write, and its cells open the picker (@lead)', async ({ page, request, vault }) => {
  void vault;
  await writeVault(request, PEOPLE);
  await page.goto('/');
  await page.getByTestId('page-item-People.base').click();
  await expect(page.getByTestId('base-table').locator('.base-title-text')).toHaveText(['Ann', 'Bo']);
  await page.getByTestId('base-add-column-button').click();
  await page.getByTestId('base-add-column-name').fill('stage');
  await page.getByTestId('base-add-column-type-select').click();
  await page.getByTestId('base-add-column-submit').click();
  await expect(page.getByTestId('base-add-column')).toHaveCount(0);
  // The view shows it, and the base holds it as a Select (no options until a value is added).
  await expect.poll(() => read('People.base')).toContain('      - stage\n');
  await expect.poll(() => read('People.base')).toMatch(/note\.stage:\n\s+gumplyType: select\n/);
  // A cell opens the Select picker; a typed value becomes the first option.
  // The columns are Name, role, age, then stage (grid column 3).
  await page.locator('[data-row-id="People/Ann"] [data-grid-col="3"]').click();
  const picker = page.getByTestId('base-select-picker');
  await expect(picker).toBeVisible();
  await page.keyboard.type('Todo');
  await page.keyboard.press('Enter');
  await expect.poll(() => read('People/Ann.md')).toMatch(/stage: Todo\n/);
  await expect.poll(() => read('People.base')).toMatch(/- value: Todo\n/);
});
