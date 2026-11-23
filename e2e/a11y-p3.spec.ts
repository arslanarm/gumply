import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from './fixtures';
import { API_URL, E2E_VAULT } from './support/env';
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
