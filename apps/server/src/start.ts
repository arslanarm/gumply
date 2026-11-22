/**
 * Start a Gumply server for one vault. Used by the CLI (`index.ts`) and,
 * in-process, by the desktop shell (D26), which asks for a random free port
 * and for the built web app to be served from the same origin.
 */
import { mkdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { createApp } from "./app.js";
import type { UiStateStore } from "./ui-state.js";
import type { McpLaunchCommand } from "@gumply/core";
import { isLoopbackName } from "./security.js";
import { VaultStore } from "./vault-store.js";

export interface StartOptions {
  vaultPath: string;
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
  /** Desktop only (#c7fzzxk8): where the app's UI preferences live. */
  uiState?: UiStateStore;
  /** A3: how an AI app starts this app's MCP mode (desktop: its own executable with `--mcp`). */
  mcpCommand?: McpLaunchCommand;
  log?: (message: string) => void;
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

  const store = new VaultStore(options.vaultPath);
  await store.init();

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
        server.close(() => resolveClose());
        // Keep-alive sockets (the window) would hold close() open.
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      }),
  };
}
