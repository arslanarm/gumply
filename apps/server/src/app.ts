import { APP_NAME, CORE_VERSION, type ApiError, type HealthResponse } from "@gumply/core";
import { Hono } from "hono";
import { cors } from "hono/cors";

export interface AppOptions {
  vaultPath: string;
}

/**
 * Build the API app without starting a listener (tests use `app.request`).
 * Page/graph/search routes land here in M1a.
 */
export function createApp(options: AppOptions): Hono {
  const app = new Hono();

  app.use("/api/*", cors());

  app.get("/api/health", (c) => {
    const body: HealthResponse = {
      ok: true,
      name: APP_NAME,
      version: CORE_VERSION,
      vaultPath: options.vaultPath,
    };
    return c.json(body);
  });

  app.notFound((c) => c.json<ApiError>({ error: "Not found" }, 404));

  app.onError((error, c) => {
    console.error("[gumply] unhandled error:", error);
    return c.json<ApiError>({ error: "Internal server error" }, 500);
  });

  return app;
}
