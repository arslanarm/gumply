import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from './fixtures';
import { API_URL, E2E_VAULT } from './support/env';
import { contrastFailures } from './support/contrast';
import { expectPageTitle } from './support/ui';

/**
 * #jchhjepb: the P3 findings of the v0.9 accessibility audit
 * (wiki `ux/a11y-audit-v0-9`), one test each.
 */

test('label in name (2.5.3): the date property, Trash and "Add icon" are named by what they show', async ({ page, vault, request }) => {
  const [gone] = await vault.seed([{ title: 'Gone', content: 'Bye.' }]);
  await request.delete(`${API_URL}/api/pages/${encodeURIComponent(gone!.id)}`);
  writeFileSync(path.join(E2E_VAULT, 'Dated.md'), '---\ndue: 2026-12-01\n---\n\nBody.\n');
  await page.goto('/#/Dated');
  await expectPageTitle(page, 'Dated');

  const date = page.getByTestId('date-picker-value');
  const shown = (await date.innerText()).trim();
  expect(shown).toContain('2026');
  await expect(date).toHaveAccessibleName(`due: ${shown}`);

  const trash = page.getByTestId('sidebar-trash');
  await expect(trash).toHaveAccessibleName('Trash 1 item');

  const icon = page.getByTestId('page-icon-button');
  await expect(icon).toHaveAccessibleName((await icon.innerText()).trim());
});

test('roles (1.3.1): a base tablist holds only tabs, its table only rows of cells; an empty vault has no tree', async ({ page, vault, request }) => {
  void vault; // a fresh, empty vault
  await page.goto('/');
  await expect(page.getByTestId('sidebar-empty')).toBeVisible();
  await expect(page.getByTestId('page-tree')).not.toHaveAttribute('role', /./);

  writeFileSync(path.join(E2E_VAULT, 'One.md'), '---\nstatus: Active\n---\n\nOne.\n');
  writeFileSync(path.join(E2E_VAULT, 'Two.md'), '---\nstatus: Done\n---\n\nTwo.\n');
  writeFileSync(
    path.join(E2E_VAULT, 'All.base'),
    'views:\n  - type: table\n    name: Table\n    groupBy:\n      property: status\n    order:\n      - file.name\n      - status\n  - type: cards\n    name: Cards\n',
  );
  await expect
    .poll(async () => ((await (await request.get(`${API_URL}/api/pages`)).json()) as { id: string }[]).map((meta) => meta.id).sort().join(','), { timeout: 10_000 })
    .toContain('All.base');
  await page.goto(`/#/${encodeURIComponent('All.base')}`);
  await expect(page.getByTestId('base-table')).toBeVisible();
  await expect(page.getByTestId('base-group')).toHaveCount(2);
  await expect(page.getByTestId('page-tree')).toHaveAttribute('role', 'tree');

  const problems = await page.evaluate(() => {
    const out: string[] = [];
    const roleOf = (el: Element) => el.getAttribute('role');
    // Elements with a role directly under `root`, looking through role-less wrappers.
    const owned = (root: Element): Element[] =>
      [...root.children].flatMap((child) => (roleOf(child) ? [child] : owned(child)));
    for (const list of document.querySelectorAll('[role="tablist"]')) {
      for (const child of owned(list)) if (roleOf(child) !== 'tab') out.push(`tablist holds ${roleOf(child)}`);
      for (const button of list.querySelectorAll('button:not([role="tab"])')) out.push(`tablist holds a plain button: ${button.getAttribute('data-testid')}`);
    }
    for (const table of document.querySelectorAll('[role="table"]')) {
      for (const child of owned(table)) if (!['row', 'rowgroup'].includes(roleOf(child)!)) out.push(`table holds ${roleOf(child)}`);
      for (const button of table.querySelectorAll('button')) if (!button.closest('[role="row"]')) out.push(`table holds a loose button: ${button.getAttribute('data-testid')}`);
      for (const row of table.querySelectorAll('[role="row"]')) {
        for (const child of owned(row)) if (!['cell', 'columnheader', 'rowheader', 'gridcell'].includes(roleOf(child)!)) out.push(`row holds ${roleOf(child)}`);
      }
    }
    return out;
  });
  expect(problems).toEqual([]);
});

test('target size (2.5.8): every Export radio row is a ≥ 24 px target, radios ≥ 24 px apart', async ({ page, vault }) => {
  const [note] = await vault.seed([{ title: 'Note', content: 'Text.' }]);
  await page.goto(`/#/${encodeURIComponent(note!.id)}`);
  await expectPageTitle(page, 'Note');
  for (const [query, row] of [['html', 'search-export-html'], ['pdf', 'search-export-pdf']] as const) {
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
    await page.keyboard.type(query);
    await page.getByTestId(row).click();
    const dialog = page.getByTestId('export-dialog');
    await expect(dialog).toBeVisible();
    const sizes = await dialog.evaluate((el) =>
      [...el.querySelectorAll<HTMLInputElement>('input[type="radio"]')].map((radio) => {
        const label = radio.closest('label')!.getBoundingClientRect();
        const box = radio.getBoundingClientRect();
        return { name: radio.dataset.testid, rowHeight: label.height, centre: box.top + box.height / 2, group: radio.name };
      }),
    );
    expect(sizes.length).toBeGreaterThan(1);
    for (const size of sizes) expect(size.rowHeight, `${size.name} row`).toBeGreaterThanOrEqual(24);
    for (let i = 1; i < sizes.length; i++) {
      if (sizes[i]!.group !== sizes[i - 1]!.group) continue;
      expect(sizes[i]!.centre - sizes[i - 1]!.centre, `${sizes[i]!.name} spacing`).toBeGreaterThanOrEqual(24);
    }
    // Clicking the label text (not the radio) picks it.
    const last = sizes[sizes.length - 1]!.name!;
    await dialog.getByTestId(last).locator('xpath=..').locator('span').click();
    await expect(dialog.getByTestId(last)).toBeChecked();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  }
});

test('status messages (4.1.3): "Can\'t reach Gumply\'s local server" is announced', async ({ page }) => {
  // Boot normally (the fixture's goto waits for the page tree), then lose the server.
  await page.goto('/');
  await page.route((url) => url.pathname.startsWith('/api/'), (route) => route.abort());
  await page.evaluate(() => window.location.reload());
  const alert = page.getByRole('alert').filter({ hasText: "Can't reach Gumply's local server." });
  await expect(alert).toHaveCount(1);
  await expect(page.getByTestId('server-error').getByRole('button', { name: 'Retry' })).toBeVisible();
});

test('contrast (1.4.3): board text in the six preset colours reads ≥ 4.5:1, light and dark', async ({ page, request }) => {
  // Plain text cards and frame labels in colours "1"–"6" (a Gumply board: the Text tool's nodes).
  const nodes = [1, 2, 3, 4, 5, 6].flatMap((i) => [
    { id: `t${i}`, type: 'text', text: `Colour ${i} text`, gumply: { kind: 'text' }, x: (i - 1) * 220, y: 0, width: 200, height: 40, color: String(i) },
    { id: `f${i}`, type: 'group', label: `Frame ${i}`, x: (i - 1) * 220, y: 120, width: 200, height: 80, color: String(i) },
  ]);
  writeFileSync(path.join(E2E_VAULT, 'Colours.canvas'), JSON.stringify({ nodes, edges: [] }));
  await expect
    .poll(async () => ((await (await request.get(`${API_URL}/api/pages`)).json()) as { id: string }[]).some((meta) => meta.id === 'Colours.canvas'), { timeout: 10_000 })
    .toBe(true);
  for (const theme of ['light', 'dark']) {
    await page.addInitScript((value) => window.localStorage.setItem('gumply:theme', value), theme);
    await page.goto(`/#/${encodeURIComponent('Colours.canvas')}`);
    await expect(page.getByTestId('board-text')).toHaveCount(6);
    await expect(page.getByTestId('board-frame')).toHaveCount(6);
    const failures = await contrastFailures(page.locator('.react-flow__nodes'));
    expect(failures, theme).toEqual([]);
  }
});
