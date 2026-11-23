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

test('non-text content (1.1.1): the global and the local graph are images named by their counts', async ({ page, vault }) => {
  await vault.seed([{ title: 'Alpha', content: 'See [[Beta]] and [[Nowhere]].' }, { title: 'Beta', content: 'Back to [[Alpha]].' }]);
  await page.goto('/#graph');
  const graph = page.getByRole('img', { name: /^2 pages, \d+ links?, 1 missing$/ });
  await expect(graph).toHaveCount(1);
  await page.goto('/#/Alpha');
  await page.getByTestId('local-graph-toggle').click();
  await expect(page.getByTestId('local-graph').getByRole('img', { name: /pages?, .*links?/ })).toHaveCount(1);
});

test('focus visible (2.4.7): a focused property input shows an accent border, ≥ 3:1 against the page', async ({ page }) => {
  writeFileSync(path.join(E2E_VAULT, 'Props.md'), '---\ntags: [plan]\nstatus: Active\n---\n\nBody.\n');
  await page.goto('/#/Props');
  await expectPageTitle(page, 'Props');
  for (const input of [page.getByTestId('property-value-tags').locator('input'), page.getByTestId('property-value-status').locator('input')]) {
    await input.focus();
    const ratio = await input.evaluate((el) => {
      const rgba = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
      const lum = (rgb: number[]) => rgb.slice(0, 3).map((v) => (v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i]!, 0);
      const visible = (c: string) => !!c && !/transparent/.test(c) && (rgba(c)[3] ?? 1) > 0;
      // The field: the chips box for a chip input, else the input. Its indicator: a
      // visible border colour, else the first box-shadow colour; none → 0.
      const field = (el.closest('.property-chips') as HTMLElement | null) ?? el;
      const cs = getComputedStyle(field);
      const shadow = cs.boxShadow.match(/rgba?\([^)]*\)/)?.[0] ?? '';
      const indicator = visible(cs.borderTopColor) && cs.borderTopWidth !== '0px' ? cs.borderTopColor : visible(shadow) ? shadow : '';
      if (!indicator) return 0;
      let node: Element | null = field.parentElement;
      let bg = 'rgba(0, 0, 0, 0)';
      while (node && !visible(bg)) { bg = getComputedStyle(node).backgroundColor; node = node.parentElement; }
      const [a, b] = [lum(rgba(indicator)), lum(rgba(bg))];
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
    expect(ratio).toBeGreaterThanOrEqual(3);
  }
  await page.getByTestId('property-value-tags').locator('input').focus();
  await page.getByTestId('property-row-tags').screenshot({ path: test.info().outputPath('tags-focus.png') });
});

test('focus order (2.4.3): after editing a base cell with the keyboard, focus is back on the cell', async ({ page, request }) => {
  writeFileSync(path.join(E2E_VAULT, 'One.md'), '---\nstatus: Active\n---\n\nOne.\n');
  writeFileSync(path.join(E2E_VAULT, 'Cells.base'), 'views:\n  - type: table\n    name: Table\n    order:\n      - file.name\n      - status\n');
  await expect
    .poll(async () => ((await (await request.get(`${API_URL}/api/pages`)).json()) as { id: string }[]).some((meta) => meta.id === 'Cells.base'), { timeout: 10_000 })
    .toBe(true);
  await page.goto(`/#/${encodeURIComponent('Cells.base')}`);
  const cell = page.getByTestId('base-cell-One-note.status');
  await expect(cell).toHaveText('Active');

  // Escape: nothing saved, focus back on the cell.
  await cell.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('base-cell-editor-One-note.status')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(cell).toBeFocused();

  // Enter in the editor saves and gives focus back too.
  await page.keyboard.press('Enter');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Done');
  await page.keyboard.press('Enter');
  await expect(cell).toHaveText('Done');
  await expect(cell).toBeFocused();
});

test('reduced motion (2.3.3): with "reduce", the board\'s Fit jumps instead of animating', async ({ page, request }) => {
  const nodes = [
    { id: 'a', type: 'text', text: 'Far left', x: -2000, y: 0, width: 200, height: 60 },
    { id: 'b', type: 'text', text: 'Far right', x: 2000, y: 400, width: 200, height: 60 },
  ];
  writeFileSync(path.join(E2E_VAULT, 'Wide.canvas'), JSON.stringify({ nodes, edges: [] }));
  await expect
    .poll(async () => ((await (await request.get(`${API_URL}/api/pages`)).json()) as { id: string }[]).some((meta) => meta.id === 'Wide.canvas'), { timeout: 10_000 })
    .toBe(true);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`/#/${encodeURIComponent('Wide.canvas')}`);
  await expect(page.getByTestId('board-toolbar')).toBeVisible();
  const viewport = () => page.locator('.react-flow__viewport').evaluate((el) => (el as HTMLElement).style.transform);
  // Move away from the fitted view, then Fit: the very next frame is already the end state.
  await page.getByTestId('board-zoom-in').click();
  await page.getByTestId('board-zoom-in').click();
  await page.waitForTimeout(400);
  await page.getByTestId('board-fit').click();
  const soon = await page.evaluate(() => new Promise<string>((resolve) => requestAnimationFrame(() => resolve((document.querySelector('.react-flow__viewport') as HTMLElement).style.transform))));
  await page.waitForTimeout(500);
  expect(soon).toBe(await viewport());
});

test('read-only (4.1.2): task boxes in the History preview are not offered as controls', async ({ page, vault, request }) => {
  const [note] = await vault.seed([{ title: 'Tasks', content: '- [ ] Write the brief\n- [x] Book the room\n' }]);
  await request.put(`${API_URL}/api/pages/${encodeURIComponent(note!.id)}`, { data: { content: '- [ ] Write the brief\n- [x] Book the room\n- [ ] One more\n' } });
  await page.goto(`/#/${encodeURIComponent(note!.id)}`);
  await expectPageTitle(page, 'Tasks');
  // The page's own boxes are controls.
  const own = page.getByTestId('editor').getByRole('checkbox');
  await expect(own).toHaveCount(3);
  for (const box of await own.all()) {
    await expect(box).not.toHaveAttribute('aria-disabled', 'true');
    await expect(box).not.toHaveAttribute('tabindex', '-1');
  }
  await page.getByTestId(`page-item-${note!.id}`).hover();
  await page.getByTestId(`page-menu-button-${note!.id}`).click();
  await page.getByTestId(`page-history-${note!.id}`).click();
  const dialog = page.getByTestId('history-dialog');
  await dialog.getByTestId('history-item').first().click();
  const preview = dialog.getByTestId('history-preview').getByRole('checkbox');
  await expect(preview).toHaveCount(2);
  for (const box of await preview.all()) {
    await expect(box).toHaveAttribute('aria-disabled', 'true');
    await expect(box).toHaveAttribute('tabindex', '-1');
  }
});
