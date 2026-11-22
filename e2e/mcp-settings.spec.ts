import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';
import { expectPageTitle } from './support/ui';

/**
 * v0.8 A3 (spec/mcp §5): Settings → AI apps (MCP) turns MCP on or off for
 * the vault, sets its access level in `.gumply/mcp.json`, shows setup
 * snippets for Claude Code and Claude Desktop, and the recent MCP writes.
 */

const settingsFile = path.join(E2E_VAULT, '.gumply', 'mcp.json');
const logFile = path.join(E2E_VAULT, '.gumply', 'mcp-log.jsonl');
/** The file's settings (null until it exists). */
const readSettings = async () => JSON.parse(await fs.readFile(settingsFile, 'utf8').catch(() => 'null')) as Record<string, unknown> | null;

async function openMcp(page: Page) {
  await page.getByTestId('settings-button').click();
  await page.getByTestId('settings-mcp').click();
  await expect(page.getByTestId('mcp-settings')).toBeVisible();
  await expect(page.getByTestId('mcp-loading')).toHaveCount(0);
}

test.afterEach(async () => {
  await fs.rm(settingsFile, { force: true });
  await fs.rm(logFile, { force: true });
});

test.describe('Settings → AI apps (MCP)', () => {
  test('on/off and the access level write .gumply/mcp.json; read only by default', async ({ page, vault }) => {
    await vault.seed([{ title: 'Home', content: 'Hi' }]);
    await page.goto('/#/Home');
    await expectPageTitle(page, 'Home');
    await openMcp(page);

    // No file: enabled, read only, and reading the settings wrote nothing.
    await expect(page.getByTestId('mcp-enabled')).toBeChecked();
    await expect(page.getByTestId('mcp-access-read')).toBeChecked();
    await expect(fs.access(settingsFile)).rejects.toThrow();

    // Raising asks first; Cancel (or Escape) leaves everything as it was.
    await page.getByTestId('mcp-access-edit').click();
    await expect(page.getByTestId('mcp-raise')).toContainText('Let AI apps edit and trash pages in this vault?');
    await page.getByTestId('mcp-raise-cancel').click();
    await expect(page.getByTestId('mcp-raise')).toHaveCount(0);
    await expect(page.getByTestId('mcp-access-read')).toBeChecked();
    await expect(page.getByTestId('mcp-settings')).toBeVisible();
    await expect(fs.access(settingsFile)).rejects.toThrow();

    await page.getByTestId('mcp-access-append').click();
    await expect(page.getByTestId('mcp-raise')).toContainText('Let AI apps add pages and text to this vault?');
    await page.getByTestId('mcp-raise-confirm').click();
    await expect.poll(readSettings).toEqual({ enabled: true, access: 'append' });
    await page.getByTestId('mcp-access-edit').click();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('mcp-raise')).toHaveCount(0);
    await expect(page.getByTestId('mcp-settings')).toBeVisible();
    await expect.poll(readSettings).toEqual({ enabled: true, access: 'append' });
    await page.getByTestId('mcp-access-edit').click();
    await page.getByTestId('mcp-raise-confirm').click();
    await expect.poll(readSettings).toEqual({ enabled: true, access: 'edit' });

    // Lowering is instant.
    await page.getByTestId('mcp-access-append').click();
    await expect(page.getByTestId('mcp-raise')).toHaveCount(0);
    await expect.poll(readSettings).toEqual({ enabled: true, access: 'append' });
    await page.getByTestId('mcp-access-edit').click();
    await page.getByTestId('mcp-raise-confirm').click();
    await expect.poll(readSettings).toEqual({ enabled: true, access: 'edit' });

    await page.getByTestId('mcp-enabled').uncheck();
    await expect.poll(readSettings).toEqual({ enabled: false, access: 'edit' });
    // Off: the levels can't be changed.
    await expect(page.getByTestId('mcp-access-read')).toBeDisabled();

    // Reopening shows what the file says.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('mcp-settings')).toHaveCount(0);
    await openMcp(page);
    await expect(page.getByTestId('mcp-enabled')).not.toBeChecked();
    await expect(page.getByTestId('mcp-access-edit')).toBeChecked();
  });

  test('setup snippets carry this vault and the command; Copy puts them on the clipboard', async ({ page, context, vault }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await vault.seed([{ title: 'Home', content: 'Hi' }]);
    await page.goto('/#/Home');
    await openMcp(page);

    const code = page.getByTestId('mcp-snippet-claude-code');
    await expect(code).toContainText('claude mcp add --transport stdio --scope user');
    await expect(code).toContainText(`gumply mcp --vault`);
    await expect(code).toContainText(E2E_VAULT);
    const desktop = JSON.parse((await page.getByTestId('mcp-snippet-claude-desktop').textContent()) ?? '{}') as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    const [entry] = Object.values(desktop.mcpServers);
    expect(entry).toEqual({ command: 'gumply', args: ['mcp', '--vault', E2E_VAULT] });

    await page.getByTestId('mcp-copy-claude-code').click();
    await expect(page.getByTestId('mcp-copy-claude-code')).toContainText('Copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await code.textContent());
  });

  test('recent activity: the newest MCP writes first; a page opens from the list', async ({ page, vault }) => {
    await vault.seed([{ title: 'Home', content: 'Hi' }, { title: 'Inbox', content: 'Ideas' }]);
    await fs.mkdir(path.dirname(logFile), { recursive: true });
    const now = Date.now();
    const row = (minutesAgo: number, tool: string, id: string, after: string | null) =>
      JSON.stringify({ at: new Date(now - minutesAgo * 60_000).toISOString(), tool, id, before: 'v0', after, client: 'claude-code' });
    await fs.writeFile(logFile, [row(30, 'create_page', 'Inbox', 'v1'), row(5, 'append_to_page', 'Inbox', 'v2'), row(1, 'trash_page', 'Old', null)].join('\n') + '\n');

    await page.goto('/#/Home');
    await expectPageTitle(page, 'Home');
    await openMcp(page);
    const rows = page.getByTestId('mcp-recent').locator('li');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText('Old');
    await expect(rows.nth(0)).toContainText('trash_page · claude-code');
    // A trashed page isn't a link.
    await expect(rows.nth(0).getByRole('button')).toBeDisabled();
    await expect(rows.nth(2)).toContainText('create_page');
    await rows.nth(1).getByRole('button', { name: 'Inbox' }).click();
    await expect(page.getByTestId('mcp-settings')).toHaveCount(0);
    await expectPageTitle(page, 'Inbox');
  });

  test('in Russian', async ({ page, vault }) => {
    await page.addInitScript(() => window.localStorage.setItem('gumply:language', 'ru'));
    await vault.seed([{ title: 'Home', content: 'Hi' }]);
    await page.goto('/#/Home');
    await expectPageTitle(page, 'Home');
    await page.getByTestId('settings-button').click();
    await expect(page.getByTestId('settings-mcp')).toHaveText('ИИ-приложения (MCP)…');
    await page.getByTestId('settings-mcp').click();
    await expect(page.getByTestId('mcp-settings').getByRole('heading', { level: 2 })).toHaveText('ИИ-приложения (MCP)');
    await expect(page.getByTestId('mcp-recent-empty')).toHaveText('ИИ-приложения пока ничего не меняли.');
  });
});
