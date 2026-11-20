import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePorts } from "./security.js";

/** Repo root, resolved from apps/server/{src,dist}/config.*. */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export interface ServerConfig {
  /** Absolute path of the Markdown vault (D2). */
  vaultPath: string;
  port: number;
  /** Seed the demo vault on an empty first run (default true). */
  seedDemo: boolean;
  /** Interface to listen on: loopback unless GUMPLY_HOST says otherwise. */
  host: string;
  /** Ports the web app runs on (allowed Origin for writes), GUMPLY_WEB_PORT. */
  webPorts: number[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = Number(env.GUMPLY_PORT ?? "8787");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid GUMPLY_PORT: ${env.GUMPLY_PORT ?? ""}`);
  }

  const demoFlag = env.GUMPLY_SEED_DEMO;
  return {
    vaultPath: resolve(REPO_ROOT, env.GUMPLY_VAULT ?? "vault"),
    port,
    seedDemo: demoFlag === undefined ? true : demoFlag !== "0" && demoFlag !== "false",
    host: env.GUMPLY_HOST?.trim() || "127.0.0.1",
    webPorts: parsePorts(env.GUMPLY_WEB_PORT, [5173]),
  };
}
