import { loadConfig } from "./config.js";
import { serverInstanceId } from "./instance-id.js";
import { startGumplyServer } from "./start.js";

const config = loadConfig();

await startGumplyServer({
  vaultPath: config.vaultPath,
  instanceId: serverInstanceId(),
  port: config.port,
  host: config.host,
  seedDemo: config.seedDemo,
  webPorts: config.webPorts,
});
