import { mkdirSync } from "node:fs";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { VaultStore } from "./vault-store.js";

const config = loadConfig();
mkdirSync(config.vaultPath, { recursive: true });

const store = new VaultStore(config.vaultPath);
await store.init();

if (config.seedDemo) {
  try {
    const welcomeId = await store.seedDemoIfFirstRun();
    if (welcomeId) console.log(`[gumply] demo vault seeded (open ${welcomeId})`);
  } catch (error) {
    // A failed seed must not stop the app; the next start retries on an empty vault.
    console.error("[gumply] demo seeding failed:", error);
  }
}

const app = createApp({ vaultPath: config.vaultPath, store });

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(
    `[gumply] API on http://localhost:${info.port}/api  vault: ${config.vaultPath} (${store.list().length} pages)`,
  );
});
