import { APP_NAME, CORE_VERSION, type ApiError, type HealthResponse } from "@gumply/core";
import { Hono } from "hono";
import { VaultError } from "./errors.js";
import { createApiRoutes } from "./routes.js";
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
  /**
   * Desktop app only (#7h5utv23): the interface language lives in the desktop
   * settings. With this, `/api/health` reports it and `PUT /api/ui/language`
   * exists; without it (the browser) the route isn't registered at all.
   */
  uiLanguage?: UiLanguageStore;
}

export interface UiLanguageStore {
  /** Language codes the app ships, e.g. `["en", "ru"]`. */
  languages: readonly string[];
  /** The saved language, or null to follow the system. */
  get(): string | null;
  set(language: string | null): void;
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
    };
    if (options.uiLanguage) body.uiLanguage = options.uiLanguage.get();
    return c.json(body);
  });

  const uiLanguage = options.uiLanguage;
  if (uiLanguage) {
    // Behind localOnly like every write: Host and Origin are checked first.
    app.put("/api/ui/language", async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json<ApiError>({ error: "Expected a JSON body" }, 400);
      }
      const value = (body as { language?: unknown } | null)?.language;
      // "system" (or null) follows the OS; otherwise only a shipped language.
      const language = value === "system" || value === null ? null : value;
      if (language !== null && (typeof language !== "string" || !uiLanguage.languages.includes(language))) {
        return c.json<ApiError>({ error: "Unknown language" }, 400);
      }
      uiLanguage.set(language);
      return c.json({ uiLanguage: language });
    });
  }

  app.route("/api", createApiRoutes(options.store));

  if (options.webRoot) app.use("*", serveWebApp(options.webRoot));

  app.notFound((c) => c.json<ApiError>({ error: "Not found" }, 404));

  app.onError((error, c) => {
    if (error instanceof VaultError) {
      return c.json<ApiError>({ error: error.message }, error.status);
    }
    console.error("[gumply] unhandled error:", error);
    return c.json<ApiError>({ error: "Internal server error" }, 500);
  });

  return app;
}
