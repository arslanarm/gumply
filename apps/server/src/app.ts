import { APP_NAME, CORE_VERSION, type ApiError, type HealthResponse, type McpLaunchCommand } from "@gumply/core";
import { Hono } from "hono";
import { badRequest, VaultError } from "./errors.js";
import { parseUiStateChange, type UiStateStore } from "./ui-state.js";
import { createApiRoutes } from "./routes.js";
import { mcpSettingsRoutes } from "./mcp-settings.js";
import { desktopUpdatesRoutes, type DesktopUpdates } from "./desktop-updates.js";
import { localOnly, type SecurityOptions } from "./security.js";
import { serveWebApp } from "./static.js";
import type { VaultStore } from "./vault-store.js";

export interface AppOptions {
  vaultPath: string;
  store: VaultStore;
  /** Local-only guard (#rv57cvhm); defaults to loopback + web port 5173. */
  security?: SecurityOptions;
  /** Serve the built web app from this folder at `/` (desktop shell, D26). */
  webRoot?: string;
  /** Reported by /api/health; the desktop app passes its own (e.g. `0.5.0-rc.3`). */
  version?: string;
  /** The desktop app's server (v1.9): /api/health says so. */
  desktop?: boolean;
  /** Desktop only (G2): the per-launch print token, reported by /api/health. */
  printToken?: string;
  /** Desktop only (#c7fzzxk8): serve `GET/PUT /api/ui/state` from this store. */
  uiState?: UiStateStore;
  /** A3: how an AI app starts this Gumply's MCP server (the desktop app's own executable); default `gumply mcp`. */
  mcpCommand?: McpLaunchCommand;
  /** Desktop only (spec/auto-update): serve `/api/desktop/updates` from this controller. */
  updates?: DesktopUpdates;
}

/**
 * Build the API app without starting a listener (tests use `app.request`).
 */
export function createApp(options: AppOptions): Hono {
  const app = new Hono();

  // No CORS: the web app is same-origin (Vite proxy), so other sites can't
  // read responses; Host and Origin checks stop rebinding and CSRF.
  app.use("/api/*", localOnly(options.security ?? { webPorts: [5173] }));

  app.get("/api/health", (c) => {
    const body: HealthResponse = {
      ok: true,
      name: APP_NAME,
      version: options.version ?? CORE_VERSION,
      vaultPath: options.vaultPath,
      ...(options.desktop ? { desktop: true } : {}),
      ...(options.desktop && options.printToken ? { printToken: options.printToken } : {}),
    };
    return c.json(body);
  });

  // #c7fzzxk8: the desktop app's UI preferences survive its random port.
  const uiState = options.uiState;
  if (uiState) {
    app.get("/api/ui/state", (c) => c.json(uiState.get()));
    app.put("/api/ui/state", async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        throw badRequest("Expected JSON");
      }
      return c.json(uiState.update(parseUiStateChange(body)));
    });
  }

  // spec/auto-update: Settings → Updates and the update notice (desktop app only).
  if (options.updates) app.route("/api/desktop/updates", desktopUpdatesRoutes(options.updates));

  // A3 (spec/api-mcp-settings): Settings → MCP.
  app.route("/api/mcp", mcpSettingsRoutes(options.vaultPath, options.mcpCommand));

  app.route("/api", createApiRoutes(options.store));

  if (options.webRoot) app.use("*", serveWebApp(options.webRoot));

  app.notFound((c) => c.json<ApiError>({ error: "Not found" }, 404));

  app.onError((error, c) => {
    if (error instanceof VaultError) {
      return c.json<ApiError>(
        { error: error.message, ...(error.reason ? { reason: error.reason } : {}), ...(error.title !== undefined ? { title: error.title } : {}) },
        error.status,
      );
    }
    console.error("[gumply] unhandled error:", error);
    return c.json<ApiError>({ error: "Internal server error" }, 500);
  });

  return app;
}
