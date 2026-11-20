import { APP_NAME, CORE_VERSION, type ApiError, type HealthResponse } from "@gumply/core";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { VaultError } from "./errors.js";
import { createApiRoutes } from "./routes.js";
import type { VaultStore } from "./vault-store.js";

export interface AppOptions {
  vaultPath: string;
  store: VaultStore;
}

/**
 * Build the API app without starting a listener (tests use `app.request`).
 */
export function createApp(options: AppOptions): Hono {
  const app = new Hono();

  app.use(
    "/api/*",
    cors({
      exposeHeaders: ["X-Gumply-New-Vault"],
    }),
  );

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
