import { mkdirSync } from "node:fs";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
mkdirSync(config.vaultPath, { recursive: true });

const app = createApp({ vaultPath: config.vaultPath });

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`[gumply] API on http://localhost:${info.port}/api  vault: ${config.vaultPath}`);
});
