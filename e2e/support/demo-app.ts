import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser } from '@playwright/test';
import { API_PORT, WEB_PORT } from './env';

/**
 * A second, isolated Gumply app for the demo-vault first-run test.
 *
 * The normal e2e suite starts one app with `GUMPLY_SEED_DEMO=0` and wipes that
 * vault between tests. The demo test needs the opposite: a **fresh** vault with
 * server-side seeding **on**, and the ability to restart the API against the
 * same vault to prove the `.gumply/demo-seeded.json` marker prevents re-seeding.
 * Running it as a second app keeps both guarantees without touching the shared
 * instance.
 *
 * Ports default to the suite's own ports + 2 (5479/8979 with the defaults), so
 * they stay inside each agent's port range. Fixed ports here let two suites
 * running at the same time on different ports collide on the demo app.
 */
export const DEMO_WEB_PORT = Number(process.env.GUMPLY_DEMO_WEB_PORT ?? WEB_PORT + 2);
export const DEMO_API_PORT = Number(process.env.GUMPLY_DEMO_PORT ?? API_PORT + 2);
export const DEMO_WEB_URL = `http://localhost:${DEMO_WEB_PORT}`;
export const DEMO_API_URL = `http://127.0.0.1:${DEMO_API_PORT}`;

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class DemoApp {
  /** Fresh vault for this suite run. Never point this at a real vault. */
  readonly vault = mkdtempSync(path.join(os.tmpdir(), 'gumply-demo-e2e-'));
  readonly marker = path.join(this.vault, '.gumply', 'demo-seeded.json');

  private server: ChildProcess | null = null;
  private web: ChildProcess | null = null;
  private readonly logs: string[] = [];

  async start(): Promise<void> {
    await this.startServer();
    this.web = this.launch('web', 'node_modules/.bin/vite', [
      'apps/web',
      '--port',
      String(DEMO_WEB_PORT),
      '--strictPort',
    ], { GUMPLY_PORT: String(DEMO_API_PORT) });
    await this.waitFor(DEMO_WEB_URL, 'demo web server');
  }

  /**
   * Warm the demo's own Vite before the first test (#ktf26af8).
   *
   * This app's Vite is cold: the first page load pays for dependency
   * pre-bundling and the first transform of every module, which under load can
   * outlast the page-open budget (`support/nav.ts`). So load the app once in a
   * throwaway context first, with every `/api` request answered **in the
   * browser** (a single fake page), so the server never sees a request and
   * first-run seeding stays untouched for the tests. The editor opens on the
   * fake page, so its modules are transformed and cached too.
   *
   * Best effort: a slow or failed warm-up doesn't fail the suite; the tests
   * then simply open a less warm app.
   */
  async warmUp(browser: Browser): Promise<void> {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const now = new Date().toISOString();
      const meta = { id: 'Warm', kind: 'page', title: 'Warm', tags: [], parentId: null, childCount: 0, created: now, updated: now };
      // Only the server's `/api/…`, never Vite modules such as `/src/api/client.ts`.
      await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
        const { pathname } = new URL(route.request().url());
        if (pathname === '/api/pages') return route.fulfill({ json: [meta] });
        if (pathname === '/api/pages/Warm') return route.fulfill({ json: { ...meta, content: 'Warm up.' } });
        if (pathname === '/api/health') return route.fulfill({ json: { ok: true, name: 'Gumply', version: 'warm-up', vaultPath: '' } });
        return route.fulfill({ status: 404, json: { error: 'warm-up' } });
      });
      const started = Date.now();
      await page.goto(`${DEMO_WEB_URL}/#/Warm`);
      await page.getByTestId('editor-content').waitFor({ state: 'visible', timeout: 90_000 });
      console.log(`[demo warm-up] cold Vite ready after ${((Date.now() - started) / 1000).toFixed(1)} s`);
    } catch (error) {
      this.logs.push(`[warm-up] ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    } finally {
      await context.close();
    }
  }

  /**
   * The demo servers' recent output (Vite's and the API's), for a failure
   * report: a Vite "http proxy error" there explains a stray 500 (#g95wkd9y).
   */
  recentLogs(count = 80): string[] {
    return this.logs.slice(-count);
  }

  async restartServer(): Promise<void> {
    await this.stopChild(this.server);
    this.server = null;
    await this.startServer();
  }

  /** Restart the API on an emptied vault: a second first run (#93yv3ban). */
  async freshVault(): Promise<void> {
    await this.stopChild(this.server);
    this.server = null;
    rmSync(this.vault, { recursive: true, force: true });
    mkdirSync(this.vault, { recursive: true });
    await this.startServer();
  }

  async stop(): Promise<void> {
    await this.stopChild(this.web);
    await this.stopChild(this.server);
    this.web = null;
    this.server = null;
    rmSync(this.vault, { recursive: true, force: true });
  }

  private async startServer(): Promise<void> {
    this.server = this.launch('server', 'node_modules/.bin/tsx', ['apps/server/src/index.ts'], {
      GUMPLY_PORT: String(DEMO_API_PORT),
      // Same-origin through the demo's Vite proxy; don't inherit the suite's.
      GUMPLY_WEB_PORT: '',
      GUMPLY_VAULT: this.vault,
      GUMPLY_SEED_DEMO: '1',
    });
    await this.waitFor(`${DEMO_API_URL}/api/health`, 'demo API server');
  }

  private launch(
    name: string,
    command: string,
    args: string[],
    env: Record<string, string>,
  ): ChildProcess {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const record = (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim().length === 0) continue;
        this.logs.push(`[${name}] ${line}`);
        if (this.logs.length > 200) this.logs.shift();
      }
    };
    child.stdout?.on('data', record);
    child.stderr?.on('data', record);
    child.on('error', (error) => this.logs.push(`[${name}] spawn error: ${error.message}`));
    return child;
  }

  private async waitFor(url: string, what: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    let last = 'no response';
    while (Date.now() < deadline) {
      try {
        const response = await fetch(url);
        if (response.ok) return;
        last = `HTTP ${response.status}`;
      } catch (error) {
        last = error instanceof Error ? error.message : String(error);
      }
      await sleep(100);
    }
    throw new Error(
      `${what} did not start at ${url} (${last})\n${this.logs.slice(-20).join('\n')}`,
    );
  }

  private async stopChild(child: ChildProcess | null): Promise<void> {
    if (!child || child.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    await Promise.race([exited, sleep(4_000)]);
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await Promise.race([exited, sleep(2_000)]);
    }
  }
}
