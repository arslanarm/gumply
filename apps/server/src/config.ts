import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root, resolved from apps/server/{src,dist}/config.*. */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export interface ServerConfig {
  /** Absolute path of the Markdown vault (D2). */
  vaultPath: string;
  port: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = Number(env.GUMPLY_PORT ?? "8787");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid GUMPLY_PORT: ${env.GUMPLY_PORT ?? ""}`);
  }

  return {
    vaultPath: resolve(REPO_ROOT, env.GUMPLY_VAULT ?? "vault"),
    port,
  };
}
