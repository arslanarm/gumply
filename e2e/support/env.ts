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

export const BASE_URL = process.env.GUMPLY_WEB_URL ?? `http://localhost:${WEB_PORT}`;

/** Tests talk to the local server directly on the port it booted with. */
export const API_URL = `http://localhost:${API_PORT}`;

/**
 * Dedicated throwaway vault for e2e. The `vault` fixture wipes it between
 * tests, so this must never point at a real vault (`./vault`).
 *
 * The default is keyed by the API port: several agents run the suite on one
 * machine at the same time (on their own ports), and a shared fixed path let
 * one run's `resetVault` delete another run's pages mid-test. That showed up as
 * random "No pages yet" / "Page not found" failures.
 */
export const E2E_VAULT =
  process.env.GUMPLY_VAULT ?? path.join(os.tmpdir(), `gumply-e2e-vault-${API_PORT}`);
