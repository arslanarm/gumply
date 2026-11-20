import { loadConfig } from "./config.js";
import { startGumplyServer } from "./start.js";

const config = loadConfig();

await startGumplyServer({
  vaultPath: config.vaultPath,
  port: config.port,
  host: config.host,
  seedDemo: config.seedDemo,
  webPorts: config.webPorts,
});
