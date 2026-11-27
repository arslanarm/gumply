import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { api, expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * Translations (#7h5utv23): with Russian chosen, the sidebar, slash menu,
 * board toolbar and the dialogs show no English leftovers and no raw keys;
 * switching language keeps the caret and the text being typed; new pages get
 * their default name in the interface language.
 */

type Tree = { [key: string]: string | Tree };
const read = (file: string) => JSON.parse(readFileSync(new URL(`../apps/web/src/i18n/${file}`, import.meta.url), 'utf8')) as Tree;
function flatten(tree: Tree, prefix = '', out = new Map<string, string>()): Map<string, string> {
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.set(path, value);
    else flatten(value, path, out);
  }
  return out;
}
const english = flatten(read('en.json'));

/**
 * English phrases that must not appear in the Russian UI: every English
 * message's text pieces (between {{placeholders}}) of 2+ words. (Copies of
 * English in a locale file are caught by the unit test too.)
 */
const leftovers = [
  ...new Set(
    [...english]
      .filter(([key]) => key !== 'app.name' && !key.startsWith('desktop.'))
      .flatMap(([, text]) => text.split(/\{\{\s*\w+\s*\}\}/))
      .map((piece) => piece.trim().replace(/[.…:—]+$/, ''))
      .filter((piece) => /[A-Za-z]{3,}\s+[A-Za-z]{2,}/.test(piece)),
  ),
];
const KEY_PATTERN = /\b(?:common|sidebar|board|slash|graph|page|search|settings|templates|blocks|save|table|emoji|delete|move|trash|folders|counts|format|editorMenu|tags)\.[a-z][A-Za-z.]+\b/;

/** Everything a user sees or hears: text, labels, tooltips, placeholders. */
async function visibleStrings(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [document.body.innerText];
    for (const element of document.querySelectorAll<HTMLElement>('*')) {
      for (const name of ['aria-label', 'title', 'placeholder', 'data-tooltip']) {
        const value = element.getAttribute(name);
        if (value) out.push(value);
      }
    }
    return out;
  });
}

async function expectNoEnglish(page: Page, where: string): Promise<void> {
  const strings = await visibleStrings(page);
  const text = strings.join('\n');
  const found = leftovers.filter((phrase) => text.includes(phrase));
  expect(found, `English left in ${where}`).toEqual([]);
  expect(text.match(KEY_PATTERN)?.[0] ?? null, `raw message key in ${where}`).toBeNull();
}

async function openInRussian(page: Page, hash = ''): Promise<void> {
  await page.addInitScript(() => window.localStorage.setItem('gumply:language', 'ru'));
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`/${hash}`);
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
}

test.describe('Russian interface (#7h5utv23)', () => {
  test('sidebar, page, slash menu, dialogs and Cmd+K: no English, no raw keys', async ({ page, vault }) => {
    await vault.seed([
      { title: 'Заметки', content: 'Первая строка' },
      { title: 'Планы', content: 'Ссылка на [[Заметки]]' },
      { title: 'Неделя', parentId: 'Планы', content: 'x' },
    ]);
    await openInRussian(page, '#/Заметки');
    await expect(page.getByTestId('new-page-button')).toHaveText('Новая страница');
    await expect(page.getByTestId('editor-content')).toContainText('Первая строка');
    await expectNoEnglish(page, 'the page view');

    // Slash menu.
    await page.getByTestId('editor-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('/');
    await expect(page.getByTestId('slash-menu-item-heading-1')).toContainText('Заголовок 1');
    await expectNoEnglish(page, 'the slash menu');
    // Russian words find blocks too.
    await page.keyboard.type('табл');
    await expect(page.getByTestId('slash-menu-item-table')).toBeVisible();
    await page.keyboard.press('Escape');

    // Row menu, delete and move dialogs.
    await page.getByTestId('page-item-Планы').hover();
    await page.getByTestId('page-menu-button-Планы').click();
    await expectNoEnglish(page, 'the row menu');
    await page.getByTestId('delete-page-Планы').click();
    await expect(page.getByTestId('delete-confirm-dialog')).toContainText('Удалить «Планы»?');
    await expect(page.getByTestId('delete-confirm-dialog')).toContainText('Её 1 подстраница тоже будет удалена.');
    await expectNoEnglish(page, 'the delete dialog');
    await page.getByTestId('delete-cancel').click();
    await page.getByTestId('page-item-Планы').hover();
    await page.getByTestId('page-menu-button-Планы').click();
    await page.getByTestId('move-page-Планы').click();
    await expect(page.getByTestId('move-dialog')).toBeVisible();
    await expectNoEnglish(page, 'the move dialog');
    await page.keyboard.press('Escape');

    // Keyboard shortcuts, Cmd+K, the template gallery and Settings.
    await page.getByTestId('shortcuts-button').click();
    await expect(page.getByRole('dialog')).toContainText('Сочетания клавиш');
    await expectNoEnglish(page, 'the shortcuts dialog');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+k');
    await page.getByTestId('quick-switcher-input').fill('язык');
    await expect(page.getByTestId('search-language')).toHaveText('Язык…');
    await expectNoEnglish(page, 'Cmd+K');
    await page.keyboard.press('Escape');
    await page.getByTestId('new-board-button').click();
    await expect(page.getByTestId('template-gallery')).toContainText('Канбан');
    await expectNoEnglish(page, 'the template gallery');
    await page.keyboard.press('Escape');
    await page.getByTestId('settings-button').click();
    await expect(page.getByTestId('settings-popover')).toContainText('Язык');
    await expectNoEnglish(page, 'Settings');
  });

  test('trash, folders, the formatting toolbar and the right-click menu in Russian', async ({ page, request, vault }) => {
    await vault.seed([
      { title: 'Заметки', content: 'Первая строка текста' },
      { title: 'Черновик', content: 'x' },
      { title: 'Метки', content: 'Про #проект/альфа' },
    ]);
    // A plain folder (D33) with a page and another file.
    await fs.mkdir(path.join(E2E_VAULT, 'Архив'), { recursive: true });
    await fs.writeFile(path.join(E2E_VAULT, 'Архив', 'Старое.md'), 'Старое', 'utf8');
    await fs.writeFile(path.join(E2E_VAULT, 'Архив', 'скан.pdf'), '%PDF-1.4', 'utf8');
    await expect
      .poll(async () => (await api.listPages(request)).some((meta) => meta.kind === 'folder' && meta.id === 'Архив'), { timeout: 10_000 })
      .toBe(true);
    await openInRussian(page, '#/Заметки');

    // The formatting toolbar on a selection, and the editor's right-click menu.
    await page.getByTestId('editor-content').getByText('Первая строка текста').dblclick();
    await expect(page.getByTestId('selection-toolbar')).toBeVisible();
    await expect(page.getByTestId('selection-turn-into')).toContainText('Текст');
    await expectNoEnglish(page, 'the formatting toolbar');
    await page.getByTestId('editor-content').getByText('Первая строка текста').click({ button: 'right' });
    await expect(page.getByTestId('editor-context-menu')).toContainText('Дублировать блок');
    await expect(page.getByTestId('editor-context-menu')).toContainText('Жирный');
    await expectNoEnglish(page, 'the right-click menu');
    await page.keyboard.press('Escape');

    // A folder's overview and its delete dialog.
    await page.getByTestId('page-item-Архив').click();
    await expect(page.getByTestId('folder-view-meta')).toHaveText('Папка · 1 элемент · 1 другой файл');
    await expect(page.getByTestId('folder-new-page')).toHaveText('Новая страница здесь');
    await expectNoEnglish(page, 'the folder overview');
    await page.getByTestId('page-item-Архив').hover();
    await page.getByTestId('page-menu-button-Архив').click();
    await expect(page.getByTestId('delete-page-Архив')).toHaveText('Удалить папку');
    await page.getByTestId('delete-page-Архив').click();
    await expect(page.getByTestId('delete-confirm-dialog')).toContainText('Её содержимое (1 страница и 1 другой файл) будет перемещено в корзину.');
    await expectNoEnglish(page, 'the folder delete dialog');
    await page.getByTestId('delete-cancel').click();

    // The tags pane and the rename dialog (#9bx3aznb).
    await page.getByTestId('tags-pane-toggle').click();
    await expect(page.getByTestId('tag-count-проект')).toHaveText('1');
    await expectNoEnglish(page, 'the tags pane');
    await page.getByTestId('tag-row-проект').click({ button: 'right' });
    await expect(page.getByTestId('tag-rename-dialog')).toContainText('Переименовать #проект');
    await expectNoEnglish(page, 'the tag rename dialog');
    await page.keyboard.press('Escape');

    // The trash: list, a trashed page and the "delete forever" dialog.
    await page.getByTestId('page-item-Черновик').hover();
    await page.getByTestId('page-menu-button-Черновик').click();
    // No sub-pages: deleted at once (D15), with an Undo toast.
    await page.getByTestId('delete-page-Черновик').click();
    await expect(page.getByTestId('sidebar-trash-count')).toHaveText('1');
    await page.getByTestId('sidebar-trash').click();
    await expect(page.getByTestId('trash-view')).toContainText('Корзина');
    await expect(page.getByTestId('trash-search')).toHaveAttribute('placeholder', 'Поиск по 1 удалённому объекту');
    await expectNoEnglish(page, 'the trash');
    await page.getByTestId('trash-item-Черновик').getByTestId('trash-delete-forever').click();
    await expect(page.getByTestId('trash-confirm-dialog')).toContainText('Удалить «Черновик» навсегда?');
    await expectNoEnglish(page, 'the delete-forever dialog');
    await page.keyboard.press('Escape');
    await page.getByTestId('trash-item-Черновик').locator('.trash-row-main').click();
    await expect(page.getByTestId('trashed-banner')).toContainText('Эта страница в корзине.');
    await expectNoEnglish(page, 'a trashed page');
  });

  test('the graph and its legend in Russian (#93yv3ban)', async ({ page, vault }) => {
    await vault.seed([
      { title: 'Заметки', content: 'Ссылка на [[Планы]] и [[Нет такой]]', icon: '🌱' },
      { title: 'Планы', content: '#проект' },
    ]);
    await openInRussian(page, '#/Заметки');
    await page.getByTestId('sidebar-graph').click();
    await expect(page.getByTestId('graph-legend-icon')).toHaveText(/эмодзи — значок страницы/);
    await expectNoEnglish(page, 'the graph view');
  });

  test('board toolbar, menu and a template board in Russian', async ({ page, request, vault }) => {
    await vault.seed([{ title: 'Заметки', content: 'Текст' }]);
    await openInRussian(page, '#/Заметки');
    await page.getByTestId('new-board-button').click();
    await page.getByTestId('template-kanban').click();
    await expect(page.getByTestId('board-frame')).toHaveCount(3);
    // The board is named after the template, in Russian, on disk too (D20).
    await expect(page).toHaveURL(/#\/%D0%9A%D0%B0%D0%BD%D0%B1%D0%B0%D0%BD\.canvas$/);
    const board = (await (await request.get(`/api/boards/${encodeURIComponent('Канбан.canvas')}`)).json()) as {
      board: { nodes: Array<{ label?: string }> };
    };
    expect(board.board.nodes.map((node) => node.label).filter(Boolean)).toEqual(['Сделать', 'В работе', 'Готово']);
    await page.keyboard.press('Escape');
    // #pypzxe6i: export is in the board's own ⋯ (its row): the item and the dialog in Russian.
    await page.getByTestId('page-item-Канбан.canvas').hover();
    await page.getByTestId('page-menu-button-Канбан.canvas').click();
    await expect(page.getByTestId('export-board-Канбан.canvas')).toHaveText('Экспортировать как изображение…');
    await page.getByTestId('export-board-Канбан.canvas').click();
    await expect(page.getByTestId('board-export-dialog')).toBeVisible();
    await expectNoEnglish(page, 'the board');
  });

  test('new pages get their default name in Russian; switching language keeps the caret', async ({ page, request, vault }) => {
    await vault.seed([{ title: 'Notes', content: 'Hello' }]);
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto('/#/Notes');
    await expect(page.getByTestId('new-page-button')).toHaveText('New page');

    // Typing, then switching to Russian mid-sentence: the text and caret stay.
    const editor = page.getByTestId('editor-content');
    await editor.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' world');
    await page.getByTestId('settings-button').click();
    await page.getByTestId('settings-language').selectOption('ru');
    await expect(page.getByTestId('new-page-button')).toHaveText('Новая страница');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
    await page.keyboard.press('Escape');
    await editor.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('!');
    await expect(editor).toContainText('Hello world!');
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
    expect((await api.getPage(request, 'Notes')).content).toContain('Hello world!');

    // A new page in Russian: "Без названия" on disk (D20).
    await page.getByTestId('new-page-button').click();
    await expect(page.getByTestId('page-title-input')).toHaveValue('Без названия');
    await expect.poll(async () => (await api.listPages(request)).map((item) => item.id)).toContain('Без названия');

    // The choice survives a reload; "Same as system" goes back to English (the browser's).
    await page.reload();
    await expect(page.getByTestId('new-page-button')).toHaveText('Новая страница');
    await page.getByTestId('settings-button').click();
    await page.getByTestId('settings-language').selectOption('system');
    await expect(page.getByTestId('new-page-button')).toHaveText('New page');
  });
});
