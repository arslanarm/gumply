import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures';
import { API_URL, E2E_VAULT } from './support/env';
import { expectPageTitle } from './support/ui';
import { pickDate } from './support/date-picker';

/**
 * v0.7 A (#qw4pcm2h, D34): page properties are frontmatter, typed like
 * Obsidian. Every edit writes only its own line; the rest of the file stays.
 */
const file = (name: string) => path.join(E2E_VAULT, `${name}.md`);
const read = (name: string) => readFileSync(file(name), 'utf8');

async function waitForFile(name: string, check: (text: string) => boolean) {
  // "ok" once it holds; otherwise the file text, so a failure shows what's on disk.
  await expect.poll(() => (check(read(name)) ? 'ok' : read(name)), { timeout: 5_000 }).toBe('ok');
}

test.describe('properties', () => {
  test('add, edit each type, rename, change type and remove, writing only those lines', async ({ page, vault }) => {
    await vault.seed([{ title: 'Anchor' }]);
    const original = '---\nstatus: todo # by hand\nnested:\n  a: 1\n---\n\nThe body.\n';
    writeFileSync(file('Task'), original);
    await page.goto('/#/Task');
    await expectPageTitle(page, 'Task');
    const block = page.getByTestId('properties-block');
    await expect(page.getByTestId('property-row-status')).toBeVisible();
    // Nested YAML is shown, read-only.
    await expect(page.getByTestId('property-value-nested').getByTestId('property-readonly')).toContainText('a: 1');

    // Text: edit in place.
    const status = page.getByTestId('property-value-status').locator('input');
    await status.fill('doing');
    await status.press('Enter');
    await waitForFile('Task', (text) => text.includes('status: doing # by hand'));

    // Add a number from scratch, then type a value.
    await block.getByTestId('property-add').click();
    await page.getByTestId('property-add-input').fill('rank');
    await page.getByTestId('property-create').click();
    const rank = page.getByTestId('property-value-rank').locator('input');
    await expect(rank).toBeFocused();
    await rank.fill('3');
    await rank.press('Enter');
    await waitForFile('Task', (text) => text.includes('rank: "3"') || text.includes('rank: 3'));
    // It started as text; make it a number: the type is stored vault-wide.
    await page.getByTestId('property-key-rank').click();
    await page.getByTestId('property-type-number').click();
    await expect(page.getByTestId('property-key-rank').locator('svg')).toBeVisible();
    await rank.fill('5');
    await rank.press('Enter');
    await waitForFile('Task', (text) => /\nrank: 5\n/.test(text));

    // Checkbox.
    await block.getByTestId('property-add').click();
    await page.getByTestId('property-add-input').fill('done');
    await page.getByTestId('property-create').click();
    await page.getByTestId('property-key-done').click();
    await page.getByTestId('property-type-checkbox').click();
    await page.getByTestId('property-value-done').locator('input[type="checkbox"]').check();
    await waitForFile('Task', (text) => /\ndone: true\n/.test(text));

    // Date.
    await block.getByTestId('property-add').click();
    await page.getByTestId('property-add-input').fill('due');
    await page.getByTestId('property-create').click();
    await page.getByTestId('property-key-due').click();
    await page.getByTestId('property-type-date').click();
    await pickDate(page, page.getByTestId('property-value-due'), '2026-12-24');
    await waitForFile('Task', (text) => /\ndue: 2026-12-24\n/.test(text));

    // List chips: add two, remove one.
    await block.getByTestId('property-add').click();
    await page.getByTestId('property-add-input').fill('people');
    await page.getByTestId('property-create').click();
    await page.getByTestId('property-key-people').click();
    await page.getByTestId('property-type-multitext').click();
    const chips = page.getByTestId('property-value-people').locator('.property-chip-input');
    await chips.fill('Ann');
    await chips.press('Enter');
    await chips.fill('Bo');
    await chips.press('Enter');
    await waitForFile('Task', (text) => text.includes('people:\n  - Ann\n  - Bo\n'));
    await page.getByTestId('property-chip-Ann').getByRole('button').click();
    await waitForFile('Task', (text) => text.includes('people:\n  - Bo\n'));

    // Tags feed the tag index (the header's tag list).
    await block.getByTestId('property-add').click();
    // Gumply's own pages already use `tags`, so it is offered as a suggestion; Enter takes it.
    await page.getByTestId('property-add-input').fill('tags');
    await page.getByTestId('property-add-input').press('Enter');
    const tags = page.getByTestId('property-value-tags').locator('input');
    await tags.fill('#launch');
    await tags.press('Enter');
    await waitForFile('Task', (text) => text.includes('tags:\n  - launch\n'));
    // The tag index has it (search, graph and the tags pane read it).
    const listed = (await (await page.request.get(`${API_URL}/api/pages`)).json()) as Array<{ id: string; tags: string[] }>;
    expect(listed.find((item) => item.id === 'Task')?.tags).toContain('launch');

    // Rename a key: same value, same place.
    await page.getByTestId('property-key-status').click();
    await page.getByTestId('property-menu-rename').click();
    await page.getByTestId('property-rename-input').fill('state');
    await page.getByTestId('property-rename-input').press('Enter');
    await waitForFile('Task', (text) => text.includes('state: doing # by hand') && !text.includes('status:'));

    // Remove.
    await page.getByTestId('property-key-due').click();
    await page.getByTestId('property-menu-remove').click();
    await waitForFile('Task', (text) => !text.includes('due:'));

    // The untouched parts are byte-for-byte: the nested map, the comment, the body.
    const final = read('Task');
    expect(final).toContain('nested:\n  a: 1\n');
    expect(final.endsWith('---\n\nThe body.\n')).toBe(true);
    expect(final).not.toMatch(/^(title|created|updated):/m);

    // After a reload, everything is still there with its type.
    await page.reload();
    await expect(page.getByTestId('property-value-rank').locator('input')).toHaveValue('5');
    await expect(page.getByTestId('property-value-done').locator('input[type="checkbox"]')).toBeChecked();
    await expect(page.getByTestId('property-chip-Bo')).toBeVisible();
  });

  test('"Add property" suggests keys used elsewhere; a plain note stays plain after its only property goes', async ({
    page,
    vault,
  }) => {
    await vault.seed([{ title: 'Anchor' }]);
    writeFileSync(file('Other'), '---\npriority: high\n---\nx\n');
    writeFileSync(file('Plain'), 'Just text.\n');
    await page.goto('/#/Plain');
    await expectPageTitle(page, 'Plain');
    await page.getByTestId('property-add').click();
    await page.getByTestId('property-add-input').fill('pri');
    await page.getByTestId('property-suggestion-priority').click();
    await expect(page.getByTestId('property-row-priority')).toBeVisible();
    await waitForFile('Plain', (text) => text === '---\npriority:\n---\n\nJust text.\n');

    await page.getByTestId('property-key-priority').click();
    await page.getByTestId('property-menu-remove').click();
    await waitForFile('Plain', (text) => text === 'Just text.\n');
  });

  test('a bad value or name is refused with a message and nothing is written', async ({ page, vault }) => {
    await vault.seed([{ title: 'Anchor' }]);
    writeFileSync(file('Nums'), '---\ncount: 1\n---\nx\n');
    await page.goto('/#/Nums');
    await expectPageTitle(page, 'Nums');
    const count = page.getByTestId('property-value-count').locator('input');
    await count.fill('lots');
    await count.press('Enter');
    await expect(page.getByTestId('property-error')).toBeVisible();
    await expect(count).toHaveValue('1');
    await page.getByTestId('property-add').click();
    await page.getByTestId('property-add-input').fill('a:b');
    await page.getByTestId('property-create').click();
    await expect(page.getByTestId('property-error')).toBeVisible();
    expect(read('Nums')).toBe('---\ncount: 1\n---\nx\n');
  });

  test("changing a type converts this page's value when it can, and only this page's (#qw4pcm2h review)", async ({ page, vault }) => {
    await vault.seed([{ title: 'Anchor' }]);
    writeFileSync(file('Scores'), '---\nrank: "2"\npeople: Ann\nnote: x\n---\nBody\n');
    writeFileSync(file('Other'), '---\nrank: "7"\n---\nx\n');
    writeFileSync(file('Odd'), '---\nrank: lots\n---\nx\n');
    await page.goto('/#/Scores');
    await expectPageTitle(page, 'Scores');

    // Text → Number: "2" becomes 2 on this page, written as one line.
    await page.getByTestId('property-key-rank').click();
    await page.getByTestId('property-type-number').click();
    await waitForFile('Scores', (text) => text === '---\nrank: 2\npeople: Ann\nnote: x\n---\nBody\n');
    await expect(page.getByTestId('property-row-rank').getByTestId('property-mismatch')).toHaveCount(0);
    // Other pages keep their values (as in Obsidian).
    expect(read('Other')).toBe('---\nrank: "7"\n---\nx\n');

    // A single value → List: a one-item list.
    await page.getByTestId('property-key-people').click();
    await page.getByTestId('property-type-multitext').click();
    await waitForFile('Scores', (text) => text.includes('people:\n  - Ann\n'));
    await expect(page.getByTestId('property-chip-Ann')).toBeVisible();

    // A value that doesn't convert stays as it is, with a hint.
    await page.goto('/#/Odd');
    await expectPageTitle(page, 'Odd');
    await expect(page.getByTestId('property-row-rank').getByTestId('property-mismatch')).toBeVisible();
    expect(read('Odd')).toBe('---\nrank: lots\n---\nx\n');
  });
});
