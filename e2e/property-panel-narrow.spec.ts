import fs from 'node:fs/promises';
import path from 'node:path';
import { api, expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * #jtck4izu (visual QA 2): on a narrow window (a phone, a split screen) the property panel keeps
 * every value inside the window. A long tag or name chip used to run off the right edge with its
 * remove button out of reach; now it ends in an ellipsis. Invented content.
 */
test.use({ viewport: { width: 420, height: 800 } });

test('long property chips stay inside a narrow window, with their remove button reachable', async ({ page, request, vault }) => {
  void vault; // resets the vault before and after
  await fs.writeFile(
    path.join(E2E_VAULT, 'Details.md'),
    '---\ntags: [work, a-very-long-tag-name-that-does-not-fit-on-a-phone]\npeople: [Alexandra Konstantinopolskaya-Vasilevskaya]\n---\nBody.\n',
    'utf8',
  );
  await expect.poll(async () => (await api.listPages(request)).some((meta) => meta.id === 'Details'), { timeout: 10_000 }).toBe(true);
  await page.goto('/#/Details');
  await page.getByTestId('properties-block').waitFor();

  for (const id of ['property-chip-a-very-long-tag-name-that-does-not-fit-on-a-phone', 'property-chip-Alexandra Konstantinopolskaya-Vasilevskaya']) {
    const chip = page.getByTestId(id);
    await expect(chip).toBeVisible();
    const box = (await chip.boundingBox())!;
    expect(box.x + box.width, `${id} ends inside the window`).toBeLessThanOrEqual(420);
    const remove = (await chip.getByRole('button').boundingBox())!;
    expect(remove.x + remove.width, `${id}: its remove button is on screen`).toBeLessThanOrEqual(420);
    expect(Math.min(remove.width, remove.height), `${id}: a 24×24 hit target (WCAG 2.5.8)`).toBeGreaterThanOrEqual(24);
    // The label is cut with an ellipsis, not clipped mid-letter.
    expect(await chip.locator('.property-chip-label').evaluate((el) => getComputedStyle(el).textOverflow)).toBe('ellipsis');
    // A cut value can still be read in full: on hover.
    expect(await chip.locator('.property-chip-label').getAttribute('title')).toBe(id.replace('property-chip-', ''));
  }
  // Nothing in the panel makes the page scroll sideways.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(420);
});
