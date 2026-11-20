import { APP_NAME, CORE_VERSION, type ApiError, type HealthResponse } from "@gumply/core";
import { Hono } from "hono";
import { VaultError } from "./errors.js";
import { createApiRoutes } from "./routes.js";
import { localOnly, type SecurityOptions } from "./security.js";
import type { VaultStore } from "./vault-store.js";

export interface AppOptions {
  vaultPath: string;
  store: VaultStore;
  /** Local-only guard (#rv57cvhm); defaults to loopback + web port 5173. */
  security?: SecurityOptions;
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
      version: CORE_VERSION,
      vaultPath: options.vaultPath,
    };
    return c.json(body);
  });

  app.route("/api", createApiRoutes(options.store));

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
