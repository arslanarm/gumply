import { mkdirSync } from "node:fs";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { isLoopbackName } from "./security.js";
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

store.startWatching();
const loopback = isLoopbackName(config.host);
const app = createApp({
  vaultPath: config.vaultPath,
  store,
  security: {
    host: loopback ? null : config.host,
    webPorts: config.webPorts,
    apiPort: config.port,
  },
});

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  const shown = config.host.includes(":") ? `[${config.host}]` : config.host;
  console.log(
    `[gumply] API on http://${shown}:${info.port}/api  vault: ${config.vaultPath} (${store.list().length} pages)`,
  );
  if (!loopback) {
    console.warn(
      `[gumply] WARNING: GUMPLY_HOST=${config.host} makes the API (full read/write access to your vault) reachable from other computers on that network.`,
    );
  }
});
