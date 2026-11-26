import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * #nadk3urm: the graph panel's Forces, like Obsidian's: four sliders
 * (multipliers on Gumply's own forces, 100% = unchanged), saved per vault in
 * `.gumply/graph.json` when a slider is let go, kept across a reload, and a
 * Reset. That a force reaches the layout is the unit suite's
 * (`graph-forces.test.ts`: Center at 0 lets two unlinked groups drift apart).
 */

const GUMPLY_GRAPH = path.join(E2E_VAULT, '.gumply', 'graph.json');

function cleanup() {
  rmSync(GUMPLY_GRAPH, { force: true });
}
test.beforeEach(cleanup);
test.afterEach(cleanup);

/** Two groups of invented pages, linked inside, with no link between them. */
async function seed(vault: { seed: (pages: Array<{ title: string; content?: string }>) => Promise<unknown> }) {
  const group = (name: string) =>
    Array.from({ length: 5 }, (_, i) => ({ title: `${name} ${i + 1}`, content: `See [[${name} ${((i + 1) % 5) + 1}]] and [[${name} ${((i + 2) % 5) + 1}]].` }));
  await vault.seed([...group('Kiln'), ...group('Comet')]);
}

async function openForces(page: Page) {
  await page.goto('/');
  await page.getByTestId('sidebar-graph').click();
  await expect(page.getByTestId('graph-canvas').locator('canvas')).toBeVisible();
  await page.getByTestId('graph-panel-toggle').click();
  const toggle = page.getByTestId('graph-forces-toggle');
  // Collapsed at first, as in Obsidian.
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
}

const savedForces = () => (existsSync(GUMPLY_GRAPH) ? (JSON.parse(readFileSync(GUMPLY_GRAPH, 'utf8')) as { forces?: Record<string, number> }).forces ?? null : null);

test('four labelled sliders at 100%; Center at 0 is saved when let go, kept after a reload, and Reset puts it back', async ({ page, vault }) => {
  test.setTimeout(60_000);
  await seed(vault);
  await openForces(page);

  // Each slider has its name, and its value read out as a percentage.
  for (const name of ['Center force', 'Repel force', 'Link force', 'Link distance']) {
    await expect(page.getByRole('slider', { name })).toHaveAttribute('aria-valuetext', '100% (default)');
  }
  const reset = page.getByTestId('graph-forces-reset');
  await expect(reset).toBeDisabled();

  // Keyboard: Home moves it to 0; letting go of the key applies and saves it.
  const center = page.getByRole('slider', { name: 'Center force' });
  await center.focus();
  await center.press('Home');
  await expect(center).toHaveAttribute('aria-valuetext', '0%');
  await expect.poll(savedForces, { timeout: 5_000 }).toEqual({ center: 0, repel: 1, linkStrength: 1, linkDistance: 1 });
  await expect(reset).toBeEnabled();

  await page.reload();
  await openForces(page);
  await expect(page.getByRole('slider', { name: 'Center force' })).toHaveAttribute('aria-valuetext', '0%');

  await page.getByTestId('graph-forces-reset').click();
  await expect(page.getByRole('slider', { name: 'Center force' })).toHaveAttribute('aria-valuetext', '100% (default)');
  await expect(page.getByTestId('graph-forces-reset')).toBeDisabled();
  await expect.poll(savedForces, { timeout: 5_000 }).toEqual({ center: 1, repel: 1, linkStrength: 1, linkDistance: 1 });
});

test('while a slider is dragged nothing is saved; letting go saves once', async ({ page, vault }) => {
  test.setTimeout(60_000);
  await seed(vault);
  await openForces(page);
  const repel = page.getByRole('slider', { name: 'Repel force' });
  const box = (await repel.boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 3, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.9, y, { steps: 8 });
  // Mid-drag: the slider shows its value, nothing has been saved (the graph would re-arrange per step).
  await expect(repel).not.toHaveAttribute('aria-valuetext', '100% (default)');
  await page.waitForTimeout(800);
  expect(savedForces()).toBeNull();
  await page.mouse.up();
  await expect.poll(() => savedForces()?.repel ?? null, { timeout: 5_000 }).toBeGreaterThan(2);
});
