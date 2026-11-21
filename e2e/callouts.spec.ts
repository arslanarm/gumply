import type { Page } from '@playwright/test';
import { api, expect, test } from './fixtures';

/**
 * #uigzc42i (D29): editable callouts and toggles, saved as Obsidian callouts.
 * A toggle is a foldable callout (`[!note]-` / `[!note]+`); opening or
 * closing it while reading never writes the file.
 */

async function waitSaved(page: Page) {
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', {
    timeout: 10_000,
  });
}

const fileOf = async (request: Parameters<typeof api.getPage>[0], id: string) =>
  (await api.getPage(request, id)).content;

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/** Every type, both fold markers, nesting, code inside, empty bodies, custom types. */
const ALL_CALLOUTS = [
  'Intro paragraph.',
  '',
  ...['note', 'tip', 'info', 'success', 'question', 'warning', 'danger', 'bug', 'example', 'quote'].flatMap(
    (type) => [`> [!${type}] A ${type}`, `> Body of the ${type}.`, ''],
  ),
  '> [!note]- Closed toggle',
  '> Hidden *until* opened.',
  '',
  '> [!tip]+ Open toggle',
  '> - one',
  '> - two',
  '',
  '> [!example] With code',
  '> ```js',
  '> const answer = 42;',
  '> ```',
  '',
  '> [!warning] Nested',
  '> Outer text',
  '>',
  '>> [!bug]- Inner',
  '>> Inner text',
  '',
  '> [!info] Only a title',
  '',
  '> [!INFO]',
  '> Untitled, upper-case type',
  '',
  '> [!my-custom] Custom type',
  '>   Odd   spacing   kept',
  '',
  '> [!faq]- Lazy continuation',
  'still in the callout',
  '',
  'Outro paragraph.',
].join('\n');

async function newLine(page: Page) {
  await page.goto('/');
  const body = page.getByTestId('editor-content');
  await body.getByText('Intro', { exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  return body;
}

test.describe('callouts and toggles (D29)', () => {
  test('every callout form renders and survives an unrelated edit byte-for-byte', async ({
    page,
    vault,
    request,
  }) => {
    const [created] = await vault.seed([{ title: 'All callouts', content: ALL_CALLOUTS }]);
    await page.goto('/');
    const body = page.getByTestId('editor-content');
    const callouts = body.getByTestId('callout');
    await expect(callouts).toHaveCount(19);
    await expect(callouts.first()).toHaveAttribute('data-callout-style', 'note');
    await expect(body.locator('[data-callout="my-custom"]')).toHaveAttribute('data-callout-style', 'note');
    // Closed by default: the body is hidden; open by default: shown.
    const closed = body.locator('[data-fold="-"]').first();
    await expect(closed).toHaveClass(/is-closed/);
    await expect(closed.getByText('Hidden')).toBeHidden();
    await expect(body.locator('[data-fold="+"]').getByText('one')).toBeVisible();
    await expect(body.locator('[data-callout="example"] code').first()).toContainText('const answer = 42;');

    await body.getByText('Intro paragraph.', { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Edited.');
    await waitSaved(page);
    expect(await fileOf(request, created!.id)).toBe(ALL_CALLOUTS.replace('Intro paragraph.', 'Intro paragraph. Edited.'));
  });

  test('after leaving the page and coming back, untouched callouts stay byte-for-byte', async ({
    page,
    vault,
    request,
  }) => {
    // A remounted editor has a new schema; the kept-source check must not
    // compare against nodes parsed for the old one (hand-check of 8e36844).
    // Tables and fences have their own kept sources: check them on the same path.
    const content = `${ALL_CALLOUTS}\n\n| Left | Right |\n|:-----|------:|\n|  a   |   1   |\n\n~~~python\nprint("x")\n~~~`;
    const [created, other] = await vault.seed([
      { title: 'Two edits', content },
      { title: 'Elsewhere', content: 'Other page' },
    ]);
    await page.goto('/');
    const body = page.getByTestId('editor-content');
    await page.getByTestId(`page-item-${created!.id}`).click();
    await body.getByText('Intro paragraph.', { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Edited.');
    await waitSaved(page);
    await page.getByTestId(`page-item-${other!.id}`).click();
    await expect(body.getByText('Other page')).toBeVisible();
    await page.getByTestId(`page-item-${created!.id}`).click();
    await body.getByText('Outro paragraph.', { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Y');
    await waitSaved(page);
    expect(await fileOf(request, created!.id)).toBe(
      content.replace('Intro paragraph.', 'Intro paragraph. Edited.').replace('Outro paragraph.', 'Outro paragraph. Y'),
    );
  });

  test('editing inside one callout rewrites only that callout', async ({ page, vault, request }) => {
    const content = 'Intro\n\n> [!tip]   Spaced   title\n> body\n\n> [!note]-  Keep\n>  me   as is';
    const [created] = await vault.seed([{ title: 'One callout', content }]);
    await page.goto('/');
    const body = page.getByTestId('editor-content');
    await body.getByText('body', { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' more');
    await waitSaved(page);
    expect(await fileOf(request, created!.id)).toBe(
      // The edited callout is written fresh (runs of spaces collapse, as in any paragraph).
      'Intro\n\n> [!tip] Spaced title\n> body more\n\n> [!note]-  Keep\n>  me   as is',
    );
  });

  test('/callout: type in the body; the title shows the type name until you type one', async ({
    page,
    vault,
    request,
  }) => {
    const [created] = await vault.seed([{ title: 'Slash callout', content: 'Intro' }]);
    await newLine(page);
    await page.keyboard.type('/callout');
    await expect(page.getByTestId('slash-menu-item-callout')).toBeVisible();
    await page.keyboard.press('Enter');
    const callout = page.getByTestId('callout');
    await expect(callout).toHaveClass(/is-title-empty/);
    await page.keyboard.type('Remember the milk');
    await waitSaved(page);
    expect(await fileOf(request, created!.id)).toBe('Intro\n\n> [!note]\n> Remember the milk');

    // Click into the title and give it one.
    await callout.locator('.callout-title').click();
    await page.keyboard.type('Shopping');
    await waitSaved(page);
    expect(await fileOf(request, created!.id)).toBe('Intro\n\n> [!note] Shopping\n> Remember the milk');
  });

  for (const type of ['note', 'tip', 'warning'] as const) {
    test(`/${type} inserts a ${type} callout`, async ({ page, vault, request }) => {
      const [created] = await vault.seed([{ title: `Slash ${type}`, content: 'Intro' }]);
      await newLine(page);
      await page.keyboard.type(`/${type}`);
      await expect(page.getByTestId(`slash-menu-item-${type}`)).toBeVisible();
      await page.keyboard.press('Enter');
      await page.keyboard.type('Text');
      await waitSaved(page);
      expect(await fileOf(request, created!.id)).toBe(`Intro\n\n> [!${type}]\n> Text`);
    });
  }

  test('/toggle: title, Enter into the body, chevron and Ctrl/Cmd+Enter fold without saving', async ({
    page,
    vault,
    request,
  }) => {
    const [created] = await vault.seed([{ title: 'Slash toggle', content: 'Intro' }]);
    await newLine(page);
    await page.keyboard.type('/toggle');
    await page.keyboard.press('Enter');
    const toggle = page.getByTestId('callout');
    await expect(toggle).toHaveAttribute('data-fold', '-');
    // New toggles start open while you fill them in.
    await expect(toggle).not.toHaveClass(/is-closed/);
    await page.keyboard.type('Details');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Hidden line');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Second line');
    await waitSaved(page);
    const saved = 'Intro\n\n> [!note]- Details\n> Hidden line\n>\n> Second line';
    expect(await fileOf(request, created!.id)).toBe(saved);

    await toggle.getByTestId('callout-fold').click();
    await expect(toggle).toHaveClass(/is-closed/);
    await expect(toggle.getByText('Hidden line')).toBeHidden();
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
    await toggle.locator('.callout-title').click();
    await page.keyboard.press(`${MOD}+Enter`);
    await expect(toggle).not.toHaveClass(/is-closed/);
    await page.keyboard.press(`${MOD}+Enter`);
    await expect(toggle).toHaveClass(/is-closed/);
    // Enter at the end of a closed toggle's title continues below it.
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('After');
    await waitSaved(page);
    expect(await fileOf(request, created!.id)).toBe(`${saved}\n\nAfter`);

    // After a reload it starts closed, as the file says.
    await page.reload();
    await expect(page.getByTestId('callout')).toHaveClass(/is-closed/);
  });

  test('`>` + space makes a toggle; Enter on an empty last line leaves it', async ({ page, vault, request }) => {
    const [created] = await vault.seed([{ title: 'Shortcut toggle', content: 'Intro' }]);
    await newLine(page);
    await page.keyboard.type('> Summary');
    const toggle = page.getByTestId('callout');
    await expect(toggle).toHaveAttribute('data-fold', '-');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Inside');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Outside');
    await waitSaved(page);
    expect(await fileOf(request, created!.id)).toBe('Intro\n\n> [!note]- Summary\n> Inside\n\nOutside');
  });

  test('`"` + space still makes a quote', async ({ page, vault, request }) => {
    const [created] = await vault.seed([{ title: 'Quote shortcut', content: 'Intro' }]);
    await newLine(page);
    await page.keyboard.type('" Quoted');
    await waitSaved(page);
    expect(await fileOf(request, created!.id)).toBe('Intro\n\n> Quoted');
  });

  test('Backspace at the start of an empty callout turns it back into a paragraph', async ({
    page,
    vault,
    request,
  }) => {
    const [created] = await vault.seed([{ title: 'Backspace out', content: 'Intro' }]);
    const body = await newLine(page);
    await page.keyboard.type('/callout');
    await page.keyboard.press('Enter');
    await expect(body.getByTestId('callout')).toHaveCount(1);
    // Empty body → back to the title; empty title → a plain paragraph.
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await expect(body.getByTestId('callout')).toHaveCount(0);
    await page.keyboard.type('Plain again');
    await waitSaved(page);
    expect(await fileOf(request, created!.id)).toBe('Intro\n\nPlain again');
  });

  test('the icon picks a type; only the head changes on disk', async ({ page, vault, request }) => {
    const content = 'Intro\n\n> [!note]  Title\n>   body   kept\n> - [ ] task';
    const [created] = await vault.seed([{ title: 'Type picker', content }]);
    await page.goto('/');
    const callout = page.getByTestId('callout');
    await callout.getByTestId('callout-icon').click();
    const picker = page.getByTestId('callout-picker');
    await expect(picker.getByRole('option')).toHaveCount(10);
    await expect(picker.getByTestId('callout-type-note')).toHaveAttribute('aria-selected', 'true');
    await picker.getByTestId('callout-type-warning').click();
    await expect(picker).toHaveCount(0);
    await expect(callout).toHaveAttribute('data-callout-style', 'warning');
    await waitSaved(page);
    expect(await fileOf(request, created!.id)).toBe(content.replace('[!note]', '[!warning]'));
  });

  test('block menu: "Start closed" / "Start open" changes the fold marker', async ({ page, vault, request }) => {
    const content = 'Intro\n\n> [!tip]+ Toggle\n> body';
    const [created] = await vault.seed([{ title: 'Fold default', content }]);
    await page.goto('/');
    const callout = page.getByTestId('callout');
    await callout.locator('.callout-title').hover();
    await page.getByTestId('block-handle').click();
    await page.getByTestId('block-menu-item-start-closed').click();
    await expect(callout).toHaveAttribute('data-fold', '-');
    await expect(callout).toHaveClass(/is-closed/);
    await waitSaved(page);
    expect(await fileOf(request, created!.id)).toBe('Intro\n\n> [!tip]- Toggle\n> body');

    await callout.locator('.callout-title').hover();
    await page.getByTestId('block-handle').click();
    await expect(page.getByTestId('block-menu-item-start-closed')).toHaveText('Start open');
    await page.getByTestId('block-menu-item-start-closed').click();
    await waitSaved(page);
    expect(await fileOf(request, created!.id)).toBe(content);
  });
});
