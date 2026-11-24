import fs from 'node:fs/promises';
import path from 'node:path';
import type { APIRequestContext, Page } from '@playwright/test';
import { api, expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * #ups4ikpj (D22): a database view's own save that meets a changed file
 * (Obsidian, sync, a restore) keeps the user's change and asks, as pages do:
 * Keep mine writes it (the disk version is kept in .gumply/conflicts/), Reload
 * shows the file as it is now. Before, the change was dropped.
 */

const read = (relative: string) => fs.readFile(path.join(E2E_VAULT, relative), 'utf8');

const BASE = `filters:
  and:
    - file.inFolder("Work")
views:
  - type: cards
    name: Gallery
    order:
      - file.name
      - status
    image: note.cover
  - type: list
    name: List
    order:
      - file.name
      - status
`;
// Someone else (Obsidian) adds a column to the List view while the user changes the Gallery's card size.
const OUTSIDE = BASE.replace('    name: List\n    order:\n      - file.name\n      - status\n', '    name: List\n    order:\n      - file.name\n      - status\n      - due\n');
const MINE = BASE.replace('    image: note.cover\n', '    image: note.cover\n    cardSize: 300\n');

async function openGallery(page: Page, request: APIRequestContext) {
  const files: Record<string, string> = { 'Work/Tasks.base': BASE, 'Work/Alpha.md': '---\nstatus: Todo\n---\nA\n' };
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(E2E_VAULT, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, 'utf8');
  }
  await expect.poll(async () => (await api.listPages(request)).some((meta) => meta.id === 'Work/Tasks.base'), { timeout: 10_000 }).toBe(true);
  await page.goto('/#/Work/Tasks.base');
  await page.getByTestId('base-tab-Gallery').click();
  await expect(page.getByTestId('base-card-Work/Alpha')).toBeVisible();
}

/** The next view save waits until the file has been changed on disk, so it meets a 409. */
async function changeOnDiskBeforeTheSave(page: Page) {
  let done = false;
  await page.route(/\/api\/bases\//, async (route) => {
    if (done || route.request().method() !== 'PUT') return route.continue();
    done = true;
    await fs.writeFile(path.join(E2E_VAULT, 'Work/Tasks.base'), OUTSIDE, 'utf8');
    // A clearly newer mtime than the version the view holds.
    const later = new Date(Date.now() + 2000);
    await fs.utimes(path.join(E2E_VAULT, 'Work/Tasks.base'), later, later);
    await route.continue();
  });
}

async function conflictBackups(): Promise<string[]> {
  const dir = path.join(E2E_VAULT, '.gumply', 'conflicts');
  const found: string[] = [];
  const walk = async (folder: string) => {
    for (const entry of await fs.readdir(folder, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) await walk(full);
      else found.push(await fs.readFile(full, 'utf8'));
    }
  };
  await walk(dir);
  return found;
}

async function changeCardSize(page: Page) {
  await page.getByTestId('base-settings-button').click();
  await page.getByTestId('base-setting-cardSize').fill('300');
}

test.describe('a database view save meets a changed file (#ups4ikpj, D22)', () => {
  test('the change is kept and the save bar asks; Keep mine writes it and keeps the other version', async ({ page, request, vault }) => {
    void vault;
    await openGallery(page, request);
    await changeOnDiskBeforeTheSave(page);
    await changeCardSize(page);

    const status = page.getByTestId('save-status');
    await expect(status).toHaveAttribute('data-state', 'conflict', { timeout: 10_000 });
    // The change is still there, on screen, and nothing was written over the other version.
    await expect(page.getByTestId('base-setting-cardSize')).toHaveValue('300');
    expect(await read('Work/Tasks.base')).toBe(OUTSIDE);

    await page.getByTestId('conflict-keep-mine').click();
    await expect(status).toHaveAttribute('data-state', 'saved', { timeout: 10_000 });
    // The user's config, and every key neither side changed byte for byte (D37).
    expect(await read('Work/Tasks.base')).toBe(MINE);
    expect(await conflictBackups()).toContain(OUTSIDE);
  });

  test('Reload drops the change knowingly and shows the file as it is now', async ({ page, request, vault }) => {
    void vault;
    await openGallery(page, request);
    await changeOnDiskBeforeTheSave(page);
    await changeCardSize(page);

    const status = page.getByTestId('save-status');
    await expect(status).toHaveAttribute('data-state', 'conflict', { timeout: 10_000 });
    await page.getByTestId('conflict-reload').click();
    await expect(status).not.toHaveAttribute('data-state', 'conflict');
    // The view is the file again: the card size the user set is gone (as chosen), the file is theirs.
    await page.getByTestId('base-tab-Gallery').click();
    await page.getByTestId('base-settings-button').click();
    await expect(page.getByTestId('base-setting-cardSize')).not.toHaveValue('300');
    expect(await read('Work/Tasks.base')).toBe(OUTSIDE);
    await page.waitForTimeout(1000);
    expect(await read('Work/Tasks.base')).toBe(OUTSIDE);
  });

  test('after renaming the open view, a change saves to the renamed file (no 404, no lost change)', async ({ page, request, vault }) => {
    void vault;
    await openGallery(page, request);
    // Rename it from the sidebar while it's open.
    await page.getByTestId('page-item-Work/Tasks.base').click();
    await page.keyboard.press('F2');
    await page.getByTestId('page-rename-input-Work/Tasks.base').fill('Projects');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('page-item-Work/Projects.base')).toBeVisible();
    await expect.poll(() => fs.access(path.join(E2E_VAULT, 'Work/Projects.base')).then(() => true, () => false)).toBe(true);

    // Where the view's save goes: the renamed id, not the old one (main's server redirect hid that).
    const puts: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'PUT' && request.url().includes('/api/bases/')) puts.push(decodeURIComponent(request.url()));
    });
    await changeCardSize(page);
    await expect.poll(() => read('Work/Projects.base')).toBe(MINE);
    expect(puts.length).toBeGreaterThan(0);
    for (const url of puts) {
      expect(url).toContain('Work/Projects.base');
      expect(url).not.toContain('Work/Tasks.base');
    }
    // Not recreated under the old name, and no conflict or error on the way.
    expect(await fs.access(path.join(E2E_VAULT, 'Work/Tasks.base')).then(() => true, () => false)).toBe(false);
    await expect(page.getByTestId('save-status')).not.toHaveAttribute('data-state', 'conflict');
    await expect(page.locator('.banner-error[role="alert"]')).toHaveCount(0);
  });

  test('quitting waits for a view change still on its way, and reports it saved (#wrr9fjn9)', async ({ page, request, vault }) => {
    void vault;
    await openGallery(page, request);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let seen = false;
    await page.route(/\/api\/bases\//, async (route) => {
      if (seen || route.request().method() !== 'PUT') return route.continue();
      seen = true;
      await held;
      await route.continue();
    });
    await changeCardSize(page);
    await expect.poll(() => seen).toBe(true);

    // What the desktop app calls before closing a window or quitting.
    await page.evaluate(() => {
      const w = window as unknown as { __gumplyFlush: () => Promise<unknown>; __flushDone?: unknown };
      void w.__gumplyFlush().then((report) => {
        w.__flushDone = report;
      });
    });
    await page.waitForTimeout(500);
    // Still waiting for the view's save: the quit doesn't go ahead without it.
    expect(await page.evaluate(() => (window as unknown as { __flushDone?: unknown }).__flushDone ?? null)).toBeNull();
    release();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __flushDone?: { saved: boolean } }).__flushDone?.saved ?? null))
      .toBe(true);
    expect(await read('Work/Tasks.base')).toBe(MINE);
  });

  // #hrdgchfb: an embed (![[Tasks.base#Gallery]] in a page) has no save bar, so it asks in place.
  async function openEmbed(page: Page, request: APIRequestContext) {
    const files: Record<string, string> = {
      'Work/Tasks.base': BASE,
      'Work/Alpha.md': '---\nstatus: Todo\n---\nA\n',
      'Notes.md': 'Intro.\n\n![[Work/Tasks.base#Gallery]]\n',
    };
    for (const [relative, content] of Object.entries(files)) {
      const absolute = path.join(E2E_VAULT, relative);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, content, 'utf8');
    }
    await expect.poll(async () => (await api.listPages(request)).some((meta) => meta.id === 'Notes'), { timeout: 10_000 }).toBe(true);
    await page.goto('/#/Notes');
    const embed = page.getByTestId('base-embed');
    await expect(embed.getByTestId('base-card-Work/Alpha')).toBeVisible();
    return embed;
  }

  test('embedded: the change is kept and the embed asks; Keep mine writes it and notes the backup (#hrdgchfb)', async ({ page, request, vault }) => {
    void vault;
    const embed = await openEmbed(page, request);
    await changeOnDiskBeforeTheSave(page);
    await embed.getByTestId('base-settings-button').click();
    await page.getByTestId('base-setting-cardSize').fill('300');

    const ask = embed.getByTestId('base-conflict');
    await expect(ask).toBeVisible({ timeout: 10_000 });
    await expect(ask).toContainText('This database view changed on disk.');
    await expect(embed.getByTestId('base-conflict-keep-mine')).toBeFocused();
    expect(await read('Work/Tasks.base')).toBe(OUTSIDE);

    await embed.getByTestId('base-conflict-keep-mine').click();
    await expect(ask).toHaveCount(0);
    await expect(embed.getByTestId('base-conflict-kept')).toContainText('.gumply/conflicts/');
    await expect.poll(() => read('Work/Tasks.base')).toBe(MINE);
    expect(await conflictBackups()).toContain(OUTSIDE);
    // Focus stays in the view, not on <body>.
    expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
    // The page around it was never touched.
    expect(await read('Notes.md')).toBe('Intro.\n\n![[Work/Tasks.base#Gallery]]\n');
  });

  test('embedded: Reload drops the change knowingly and shows the file as it is (#hrdgchfb)', async ({ page, request, vault }) => {
    void vault;
    const embed = await openEmbed(page, request);
    await changeOnDiskBeforeTheSave(page);
    await embed.getByTestId('base-settings-button').click();
    await page.getByTestId('base-setting-cardSize').fill('300');

    await expect(embed.getByTestId('base-conflict')).toBeVisible({ timeout: 10_000 });
    await embed.getByTestId('base-conflict-reload').click();
    await expect(embed.getByTestId('base-conflict')).toHaveCount(0);
    await page.waitForTimeout(1000);
    expect(await read('Work/Tasks.base')).toBe(OUTSIDE);
    expect(await conflictBackups()).not.toContain(OUTSIDE);
  });
});
