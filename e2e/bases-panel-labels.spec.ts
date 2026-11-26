import fs from 'node:fs/promises';
import path from 'node:path';
import { api, expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * #8fm4gp7z (visual QA 6): a database view's Group panel gave its "Group by" label the width of
 * "Where", so it wrapped to two lines in English and was cut off in Russian («Группировать по»).
 * The label keeps one line and its whole text, in both languages; the filter rows' "Where"/"And"
 * labels stay aligned. Invented content.
 */
const BASE = 'filters:\n  and:\n    - file.inFolder("Work")\nviews:\n  - type: table\n    name: Table\n    order:\n      - file.name\n      - status\n';

for (const [lang, label] of [['en', 'Group by'], ['ru', 'Группировать по']] as const) {
  test(`the Group panel's label is whole and on one line (${lang})`, async ({ page, request, vault }) => {
    void vault; // resets the vault before and after
    await page.addInitScript((l) => window.localStorage.setItem('gumply:language', l), lang);
    await fs.mkdir(path.join(E2E_VAULT, 'Work'), { recursive: true });
    await fs.writeFile(path.join(E2E_VAULT, 'Work', 'Tasks.base'), BASE, 'utf8');
    await fs.writeFile(path.join(E2E_VAULT, 'Work', 'Alpha.md'), '---\nstatus: Todo\n---\nA\n', 'utf8');
    await expect.poll(async () => (await api.listPages(request)).some((m) => m.id === 'Work/Alpha'), { timeout: 10_000 }).toBe(true);
    await page.goto('/#/Work/Tasks.base');
    await page.getByTestId('base-table').waitFor();
    await page.getByTestId('base-group-button').click();
    const lead = page.getByTestId('base-group-panel').locator('.base-rule-lead');
    await expect(lead).toHaveText(label);
    const size = await lead.evaluate((element) => {
      // The text's own line boxes: one distinct top per rendered line.
      const range = document.createRange();
      range.selectNodeContents(element);
      const tops = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top)));
      return { scroll: element.scrollWidth, client: element.clientWidth, lines: tops.size };
    });
    expect(size.scroll, 'the whole label fits its box').toBeLessThanOrEqual(size.client + 1);
    expect(size.lines, 'one line').toBe(1);
  });
}

test.describe('on a narrow window', () => {
  test.use({ viewport: { width: 420, height: 800 } });

  test('a filter row (ru, the widest lead label) still fits its panel and the window', async ({ page, request, vault }) => {
    void vault; // resets the vault before and after
    await page.addInitScript(() => window.localStorage.setItem('gumply:language', 'ru'));
    await fs.mkdir(path.join(E2E_VAULT, 'Work'), { recursive: true });
    await fs.writeFile(path.join(E2E_VAULT, 'Work', 'Tasks.base'), BASE, 'utf8');
    await fs.writeFile(path.join(E2E_VAULT, 'Work', 'Alpha.md'), '---\nstatus: Todo\n---\nA\n', 'utf8');
    await expect.poll(async () => (await api.listPages(request)).some((m) => m.id === 'Work/Alpha'), { timeout: 10_000 }).toBe(true);
    await page.goto('/#/Work/Tasks.base');
    await page.getByTestId('base-table').waitFor();
    await page.getByTestId('base-filter-button').click();
    await page.getByTestId('base-add-rule').click();
    await page.getByTestId('base-add-rule').click();
    const panel = (await page.getByTestId('base-filter-panel').boundingBox())!;
    expect(panel.x).toBeGreaterThanOrEqual(0);
    expect(panel.x + panel.width).toBeLessThanOrEqual(420);
    for (const row of await page.getByTestId('base-rule').all()) {
      const box = (await row.boundingBox())!;
      expect(box.x + box.width, 'the row ends inside its panel').toBeLessThanOrEqual(panel.x + panel.width + 1);
      const lead = row.locator('.base-rule-lead');
      expect(await lead.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    }
  });
});
