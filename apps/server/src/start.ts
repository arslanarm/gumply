/**
 * Start a Gumply server for one vault. Used by the CLI (`index.ts`) and,
 * in-process, by the desktop shell (D26), which asks for a random free port
 * and for the built web app to be served from the same origin.
 */
import { mkdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { createApp } from "./app.js";
import type { DesktopUpdates } from "./desktop-updates.js";
import type { UiStateStore } from "./ui-state.js";
import type { McpLaunchCommand } from "@gumply/core";
import { logUnhandledRejections } from "./last-resort.js";
import { isLoopbackName } from "./security.js";
import { VaultStore } from "./vault-store.js";

export interface StartOptions {
  vaultPath: string;
  /** D47: this installation's id (app data, never the vault), for the rename crash journal. */
  instanceId?: string;
  /** 0 = a random free port. */
  port: number;
  host?: string;
  seedDemo?: boolean;
  /** Web app ports allowed to write (GUMPLY_WEB_PORT); see security.ts. */
  webPorts?: number[];
  /** Serve this built web app (apps/web/dist) at `/` (desktop only). */
  webRoot?: string;
  /** Watch the vault for external changes (default true). */
  watch?: boolean;
  /** The app version /api/health reports (defaults to the core version). */
  version?: string;
  /** Started by the desktop app (reported by /api/health). */
  desktop?: boolean;
  /** Desktop only (G2): the per-launch print token. */
  printToken?: string;
  /** Desktop only (#c7fzzxk8): where the app's UI preferences live. */
  uiState?: UiStateStore;
  /** A3: how an AI app starts this app's MCP mode (desktop: its own executable with `--mcp`). */
  mcpCommand?: McpLaunchCommand;
  /** Desktop only (spec/auto-update): the update controller behind `/api/desktop/updates`. */
  updates?: DesktopUpdates;
  log?: (message: string) => void;
  /** Tests: how long close() waits for the history flush (default {@link HISTORY_FLUSH_TIMEOUT_MS}). */
  historyFlushTimeoutMs?: number;
}

/** Shutdown never waits on version history longer than this (#a7qepp99). */
export const HISTORY_FLUSH_TIMEOUT_MS = 3_000;
/** #xgnvipyd: how long close() waits for a rename's remaining link-rewrite batches. */
export const RENAME_SETTLE_TIMEOUT_MS = 5_000;

/**
 * Run the history flush, but give up after `timeoutMs`: a stuck history
 * write must never hold up quitting. Open sessions then miss their last
 * "End of editing" version; the page files themselves are already saved.
 */
export async function flushWithin(flush: () => Promise<void>, timeoutMs: number, warn: (message: string) => void = (message) => console.error(message)): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
    timer.unref?.();
  });
  const done = flush().then(
    () => "done" as const,
    () => "done" as const,
  );
  const result = await Promise.race([done, timedOut]);
  if (timer) clearTimeout(timer);
  if (result === "timeout") warn(`[gumply] version history flush still running after ${timeoutMs} ms; closing without it`);
}

export interface RunningServer {
  port: number;
  host: string;
  /** `http://127.0.0.1:<port>` */
  url: string;
  store: VaultStore;
  close(): Promise<void>;
}

export async function startGumplyServer(options: StartOptions): Promise<RunningServer> {
  const host = options.host ?? "127.0.0.1";
  const log = options.log ?? ((message: string) => console.log(message));
  mkdirSync(options.vaultPath, { recursive: true });

  // #35q6kt6e: a stray rejection is logged, never the end of the server.
  logUnhandledRejections();
  const store = new VaultStore(options.vaultPath, options.instanceId ? { instanceId: options.instanceId } : {});
  // #g95wkd9y: answer once the files are read; the links are indexed next, in
  // the background (whatever reads links waits for it).
  await store.init({ background: true });

  // #93yv3ban: seeded on the first GET /pages, in the language it asks for.
  if (options.seedDemo ?? true) store.armDemo(log);

  if (options.watch ?? true) store.startWatching();
  const loopback = isLoopbackName(host);

  // The port is only known once listening (port 0); the security options
  // read it lazily.
  const security = {
    host: loopback ? null : host,
    webPorts: options.webPorts ?? [5173],
    apiPort: options.port || null,
  };
  const app = createApp({
    vaultPath: options.vaultPath,
    store,
    security,
    ...(options.webRoot ? { webRoot: options.webRoot } : {}),
    ...(options.version ? { version: options.version } : {}),
    ...(options.desktop ? { desktop: true } : {}),
    ...(options.uiState ? { uiState: options.uiState } : {}),
    ...(options.mcpCommand ? { mcpCommand: options.mcpCommand } : {}),
    ...(options.updates ? { updates: options.updates } : {}),
    ...(options.printToken ? { printToken: options.printToken } : {}),
  });

  const server: ServerType = await new Promise((resolveServer, reject) => {
    const instance = serve({ fetch: app.fetch, port: options.port, hostname: host }, () => resolveServer(instance));
    instance.once("error", reject);
  });
  const port = (server.address() as AddressInfo).port;
  security.apiPort = port;

  const shown = host.includes(":") ? `[${host}]` : host;
  const url = `http://${shown}:${port}`;
  log(`[gumply] API on ${url}/api  vault: ${options.vaultPath} (${store.list().length} pages)`);
  if (!loopback) {
    console.warn(
      `[gumply] WARNING: GUMPLY_HOST=${host} makes the API (full read/write access to your vault) reachable from other computers on that network.`,
    );
  }

  return {
    port,
    host,
    url,
    store,
    close: () =>
      new Promise<void>((resolveClose) => {
        store.stopWatching();
        // #xgnvipyd: a rename still rewriting links gets a few seconds to finish (fewer `[[Old]]` links left),
        // then D41: open editing sessions become versions on close.
        void store
          .settleRenames(RENAME_SETTLE_TIMEOUT_MS)
          .then(() => flushWithin(() => store.flushHistory(), options.historyFlushTimeoutMs ?? HISTORY_FLUSH_TIMEOUT_MS))
          .catch((error: unknown) => console.error("[gumply] history flush on close failed:", error))
          .finally(() => {
            server.close(() => resolveClose());
            // Keep-alive sockets (the window) would hold close() open.
            (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
          });
      }),
  };
}
