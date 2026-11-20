import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Ports / URLs for e2e.
 *
 * Deliberately **not** the D7 dev ports and not 52xx/88xx used by parallel
 * agents: the suite starts its own app so it never collides with someone's
 * `npm run dev` (a reused server means tests run against the wrong code, or
 * wipe the wrong vault). Override with `GUMPLY_WEB_PORT` / `GUMPLY_PORT`
 * (the server reads GUMPLY_PORT itself, the web server gets GUMPLY_WEB_PORT
 * via `vite --port`).
 */
export const WEB_PORT = Number(process.env.GUMPLY_WEB_PORT ?? 5477);
export const API_PORT = Number(process.env.GUMPLY_PORT ?? 8977);

/**
 * Stub "remote" image server for "Save to vault" (#w6i6e6u7). The server
 * refuses local addresses (SSRF), so the e2e server gets exactly this
 * host:port in GUMPLY_IMPORT_ALLOW.
 */
export const IMAGE_STUB_PORT = Number(process.env.GUMPLY_IMAGE_STUB_PORT ?? API_PORT + 13);

export const BASE_URL = process.env.GUMPLY_WEB_URL ?? `http://localhost:${WEB_PORT}`;

/** Tests talk to the local server directly on the port it booted with. */
export const API_URL = `http://localhost:${API_PORT}`;

/**
 * Dedicated throwaway vault for e2e. The `vault` fixture wipes it between
 * tests, so this must never point at a real vault (`./vault`).
 *
 * Unless `GUMPLY_VAULT` is set, every run gets a **fresh** `mkdtemp` directory.
 * Several agents run the suite on one machine at the same time, and the old
 * fixed default (`/tmp/gumply-e2e-vault`) let one run's `resetVault` delete
 * another run's pages mid-test (random "No pages yet" / "Page not found").
 *
 * The path is created once, in the Playwright main process when it loads the
 * config, and published through `process.env`. The web server and the worker
 * processes inherit that env, so they all see the same directory. When this
 * module created it, `GUMPLY_E2E_VAULT_OWNED=1` lets the global teardown
 * (`support/teardown.ts`) delete it after the run.
 */
function resolveVault(): string {
  const explicit = process.env.GUMPLY_VAULT;
  if (explicit) return explicit;
  const created = mkdtempSync(path.join(os.tmpdir(), 'gumply-e2e-'));
  process.env.GUMPLY_VAULT = created;
  process.env.GUMPLY_E2E_VAULT_OWNED = '1';
  return created;
}

export const E2E_VAULT = resolveVault();
