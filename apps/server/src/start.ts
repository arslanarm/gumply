/**
 * Start a Gumply server for one vault. Used by the CLI (`index.ts`) and,
 * in-process, by the desktop shell (D26), which asks for a random free port
 * and for the built web app to be served from the same origin.
 */
import { mkdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { createApp, type UiLanguageStore } from "./app.js";
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
  /** Desktop app only: the interface language setting (#7h5utv23). */
  uiLanguage?: UiLanguageStore;
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

  if (options.seedDemo ?? true) {
    try {
      const welcomeId = await store.seedDemoIfFirstRun();
      if (welcomeId) log(`[gumply] demo vault seeded (open ${welcomeId})`);
    } catch (error) {
      // A failed seed must not stop the app; the next start retries on an empty vault.
      console.error("[gumply] demo seeding failed:", error);
    }
  }

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
    ...(options.uiLanguage ? { uiLanguage: options.uiLanguage } : {}),
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
