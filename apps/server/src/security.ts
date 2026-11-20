/**
 * Local-only API (#rv57cvhm). The API can read, overwrite and delete the
 * whole vault, so only the user's own Gumply tab may talk to it:
 *
 * - **Bind** to loopback by default (`index.ts`); `GUMPLY_HOST` opts in to
 *   other interfaces.
 * - **No CORS**: the web app calls the API same-origin through the Vite
 *   proxy, so browsers block every other site from reading responses.
 * - **DNS rebinding**: a `Host` header that isn't a loopback name (or the
 *   configured host) is refused. A rebinding attack reaches 127.0.0.1 under
 *   the attacker's domain name, so its `Host` gives it away.
 * - **CSRF**: a state-changing request (POST/PUT/PATCH/DELETE) carrying an
 *   `Origin` from anywhere but the Gumply web app is refused. The web app is
 *   recognised by its port (`GUMPLY_WEB_PORT`) or, on any port, by being
 *   same-origin with the (loopback) `Host` it reached us through. This covers
 *   "simple" requests (form posts, `text/plain`, multipart) that skip CORS
 *   preflight. Requests without `Origin` (curl, scripts, tests) pass: browsers
 *   always send `Origin` on cross-site POSTs.
 */
import type { ApiError } from "@gumply/core";
import type { MiddlewareHandler } from "hono";

export interface SecurityOptions {
  /** Extra host name accepted in `Host` (from `GUMPLY_HOST`, non-loopback). */
  host?: string | null;
  /** Ports the web app is served on (Vite: 5173 by default). */
  webPorts: readonly number[];
  /** The API's own port (direct same-origin requests). */
  apiPort?: number | null;
}

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** `localhost:5173` → `localhost`; `[::1]:8787` → `[::1]`. */
export function hostName(host: string): string {
  const value = host.trim().toLowerCase();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end === -1 ? value : value.slice(0, end + 1);
  }
  const colon = value.lastIndexOf(":");
  return colon === -1 ? value : value.slice(0, colon);
}

export function isLoopbackName(name: string): boolean {
  return LOOPBACK_NAMES.has(name.toLowerCase());
}

/** Whether `origin` is the Gumply web app (or the API itself) on this machine. */
export function isAllowedOrigin(origin: string, options: SecurityOptions): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const name = url.hostname.toLowerCase();
  const configured = options.host ? options.host.toLowerCase() : null;
  if (!isLoopbackName(name) && name !== configured) return false;
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  return options.webPorts.includes(port) || port === options.apiPort;
}

/**
 * Same-origin through a proxy (#kmff9wkt): Vite (any port, `vite preview`)
 * passes the browser's `Host` through, so the web app's own requests have
 * `Origin` host:port equal to `Host`. `Host` has already passed the loopback
 * check above, so this can't let another website in.
 */
export function isSameOrigin(origin: string, host: string | undefined): boolean {
  if (!host) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return url.host.toLowerCase() === host.trim().toLowerCase();
}

const warned = new Set<string>();
function warnOnce(origin: string): void {
  if (warned.has(origin) || warned.size > 50) return;
  warned.add(origin);
  console.warn(
    `[gumply] refused a write from ${origin}. If that is your Gumply web app, set GUMPLY_WEB_PORT to its port.`,
  );
}

function refuse(message: string) {
  return { error: message } satisfies ApiError;
}

export function localOnly(options: SecurityOptions): MiddlewareHandler {
  const configured = options.host ? options.host.toLowerCase() : null;
  return async (c, next) => {
    const host = c.req.header("host");
    if (host) {
      const name = hostName(host);
      if (!isLoopbackName(name) && name !== configured) {
        return c.json(refuse("Gumply's API only answers on this computer (unexpected Host)."), 403);
      }
    }

    if (UNSAFE_METHODS.has(c.req.method)) {
      const origin = c.req.header("origin");
      // "null" is what sandboxed frames and file:// pages send: refuse too.
      if (origin !== undefined && !isAllowedOrigin(origin, options) && !isSameOrigin(origin, host)) {
        warnOnce(origin);
        return c.json(refuse("Requests from other websites are not allowed."), 403);
      }
    }

    await next();
  };
}

/** `GUMPLY_WEB_PORT=5173,5174` → [5173, 5174]; default 5173. */
export function parsePorts(value: string | undefined, fallback: number[]): number[] {
  const ports = (value ?? "")
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((port) => Number.isInteger(port) && port > 0 && port <= 65535);
  return ports.length > 0 ? ports : fallback;
}
