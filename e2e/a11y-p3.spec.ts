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
