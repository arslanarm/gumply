import os from 'node:os';
import path from 'node:path';

/**
 * Ports / URLs per decision D7 (wiki `decisions`):
 *  - web: fixed on 5173, Vite `strictPort` (no fallback port)
 *  - server: `GUMPLY_PORT`, default 8787 — the same variable the server itself reads
 *  - Playwright `baseURL`: `GUMPLY_WEB_URL`, default http://localhost:5173
 */
export const WEB_PORT = 5173;
export const API_PORT = Number(process.env.GUMPLY_PORT ?? 8787);

export const BASE_URL = process.env.GUMPLY_WEB_URL ?? `http://localhost:${WEB_PORT}`;

/** Tests talk to the local server directly on the port it booted with. */
export const API_URL = `http://localhost:${API_PORT}`;

/**
 * Dedicated throwaway vault for e2e. The `vault` fixture wipes it between
 * tests, so this must never point at a real vault (`./vault`).
 */
export const E2E_VAULT = process.env.GUMPLY_VAULT ?? path.join(os.tmpdir(), 'gumply-e2e-vault');
