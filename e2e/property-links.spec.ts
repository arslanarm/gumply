import fs from 'node:fs/promises';
import path from 'node:path';
import type { APIRequestContext } from '@playwright/test';
import { api, expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';
import { expectPageTitle } from './support/ui';

/**
 * #vc4hivrr: `[[links]]` in property values show as links (properties block,
 * database cells), as in Obsidian; editing is the raw text and the file stays
 * as it was. Page cards on boards show tasks with read-only boxes.
 */

const read = (relative: string) => fs.readFile(path.join(E2E_VAULT, relative), 'utf8');

/** A real 40×30 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAACgAAAAeCAIAAADRv8uKAAAAN0lEQVR4nGPQmts/IIhh1OLRoB5NXKPZabQAGS0yRyuJ0WpxtAUy2uYabWWOtqtHexJag7bvBAC2mEN7vU6FZQAAAABJRU5ErkJggg==',
  'base64',
);

async function writeVault(request: APIRequestContext, files: Record<string, string | Buffer>) {
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(E2E_VAULT, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content);
  }
  const ids = Object.keys(files)
    .filter((file) => /\.(md|base|canvas)$/.test(file))
    .map((file) => file.replace(/\.md$/, ''));
  await expect
    .poll(async () => {
      const listed = new Set((await api.listPages(request)).map((meta) => meta.id));
      return ids.every((id) => listed.has(id));
    }, { timeout: 10_000 })
    .toBe(true);
}

const NOTE = '---\nrelated: "[[Project A]]"\ncover-ref: "[[att/cover-a.png]]"\nsee: "Read [[Project A#Goals|the goals]] first"\nlinks:\n  - "[[Project A]]"\n  - plain\n---\n\nBody.\n';

test.describe('links in property values (#vc4hivrr)', () => {
  test('the properties block shows links; a click opens them, a click beside them edits the raw text', async ({ page, request, vault }) => {
    void vault;
    await writeVault(request, { 'Project A.md': '# Goals\n\nA\n', 'att/cover-a.png': PNG, 'Note.md': NOTE });
    await page.goto('/#/Note');
    await expectPageTitle(page, 'Note');

    const related = page.getByTestId('property-linked-related');
    await expect(related.getByTestId('property-link')).toHaveText('Project A');
    await expect(related.getByTestId('property-link')).not.toHaveClass(/is-unresolved/);
    // Text around a link stays text; an alias is the label.
    await expect(page.getByTestId('property-linked-see')).toHaveText('Read the goals first');
    // An attachment link opens the file.
    await expect(page.getByTestId('property-linked-cover-ref').getByTestId('property-link')).toHaveAttribute('href', '/api/files/att/cover-a.png');
    // A list value: the chip holding a link shows it as one.
    await expect(page.getByTestId('property-chip-[[Project A]]').getByTestId('property-link')).toHaveText('Project A');
    await expect(page.getByTestId('property-chip-plain')).toHaveText('plain');

    // Clicking beside the link edits the raw value; leaving shows the link again.
    const box = (await related.boundingBox())!;
    await page.mouse.click(box.x + box.width - 6, box.y + box.height / 2);
    const input = page.getByTestId('property-value-related').locator('input');
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('[[Project A]]');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('property-linked-related')).toBeVisible();
    // Tab reaches it from the keyboard too, as the raw text.
    await page.getByTestId('property-linked-related').focus();
    await expect(input).toBeFocused();
    await page.keyboard.press('Escape');

    // Clicking the link opens the page; nothing was written.
    await page.getByTestId('property-linked-related').getByTestId('property-link').click();
    await expectPageTitle(page, 'Project A');
    expect(await read('Note.md')).toBe(NOTE);
  });

  test('database cells show links; clicking one opens the page instead of editing the cell', async ({ page, request, vault }) => {
    void vault;
    const base = 'filters:\n  and:\n    - file.inFolder("Work")\nviews:\n  - type: table\n    name: All\n    order:\n      - file.name\n      - related\n';
    await writeVault(request, {
      'Project A.md': 'A\n',
      'Work/Item.md': '---\nrelated: "[[Project A]]"\n---\nItem\n',
      'Work/Items.base': base,
    });
    await page.goto('/#/Work/Items.base');
    const cell = page.getByTestId('base-cell-Work/Item-note.related');
    await expect(cell.getByTestId('property-link')).toHaveText('Project A');
    await cell.getByTestId('property-link').click();
    await expectPageTitle(page, 'Project A');
    expect(await read('Work/Item.md')).toBe('---\nrelated: "[[Project A]]"\n---\nItem\n');
    expect(await read('Work/Items.base')).toBe(base);
  });
});

test('a page card on a board shows the page\'s tasks with read-only boxes (#vc4hivrr)', async ({ page, request, vault }) => {
  void vault;
  const canvas = JSON.stringify({ nodes: [{ id: 'p1', type: 'file', file: 'Tasks.md', x: 0, y: 0, width: 360, height: 240 }], edges: [] });
  await writeVault(request, {
    'Tasks.md': 'Before the trip:\n\n- [ ] Book train\n- [x] Pack **bag**\n- Plain bullet\n',
    'Trip.canvas': canvas,
  });
  await page.goto('/#/Trip.canvas');
  const card = page.getByTestId('board-page-card');
  await expect(card.getByTestId('board-page-card-title')).toHaveText('Tasks');
  const tasks = card.getByTestId('board-page-card-task');
  await expect(tasks).toHaveCount(2);
  await expect(tasks.nth(0)).toHaveText('Book train');
  await expect(tasks.nth(0).locator('input[type="checkbox"]')).not.toBeChecked();
  await expect(tasks.nth(1)).toHaveText('Pack bag');
  await expect(tasks.nth(1).locator('input[type="checkbox"]')).toBeChecked();
  await expect(tasks.nth(1).locator('input[type="checkbox"]')).toBeDisabled();
  await expect(card.getByTestId('board-page-card-preview')).toContainText('Plain bullet');
  expect(await read('Tasks.md')).toBe('Before the trip:\n\n- [ ] Book train\n- [x] Pack **bag**\n- Plain bullet\n');
});
