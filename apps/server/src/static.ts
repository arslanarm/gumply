/**
 * Serve the built web app (`apps/web/dist`) from the API server, same origin
 * (D26). Used only by the desktop shell; `npm run dev` keeps Vite.
 *
 * - Only files inside `root` are served (no traversal, no dot files).
 * - Unknown paths fall back to `index.html` (the app routes by hash, so this
 *   is only for robustness).
 * - Every response carries a strict Content-Security-Policy. The one inline
 *   script in `index.html` (the first-paint theme) is allowed by its hash.
 */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import type { MiddlewareHandler } from "hono";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

/** sha256 CSP sources for every inline `<script>` in an HTML document. */
export function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  const pattern = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
    const body = match[1] ?? "";
    if (body.trim().length === 0) continue;
    hashes.push(`'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`);
  }
  return hashes;
}

/**
 * The app's policy: its own scripts and styles only, API calls to itself,
 * web images allowed (pasted/remote images render directly, #9zqypgmh).
 */
export function appContentSecurityPolicy(scriptHashes: readonly string[]): string {
  return [
    "default-src 'self'",
    `script-src 'self' ${scriptHashes.join(" ")}`.trim(),
    // React writes style attributes; TipTap/React Flow inject style tags.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https: http:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'none'",
  ].join("; ");
}

export function serveWebApp(rootDir: string): MiddlewareHandler {
  const root = resolve(rootDir);
  let indexCache: { html: string; csp: string } | null = null;

  const index = async () => {
    if (!indexCache) {
      const html = await readFile(join(root, "index.html"), "utf8");
      indexCache = { html, csp: appContentSecurityPolicy(inlineScriptHashes(html)) };
    }
    return indexCache;
  };

  return async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return next();
    const path = c.req.path;
    if (path === "/api" || path.startsWith("/api/")) return next();

    const { csp, html } = await index();
    const headers: Record<string, string> = {
      "Content-Security-Policy": csp,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    };

    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      return c.text("Bad request", 400);
    }
    const relativePath = decoded.replace(/^\/+/, "");
    const isIndex = relativePath === "" || relativePath === "index.html";
    if (!isIndex && !relativePath.split("/").some((part) => part.startsWith("."))) {
      const absolute = resolve(root, relativePath);
      if (absolute.startsWith(`${root}${sep}`)) {
        try {
          const info = await stat(absolute);
          if (info.isFile()) {
            const type = TYPES[extname(absolute).toLowerCase()] ?? "application/octet-stream";
            const fileHeaders = {
              ...headers,
              "Content-Type": type,
              "Content-Length": String(info.size),
              // Vite fingerprints everything under assets/.
              "Cache-Control": relativePath.startsWith("assets/")
                ? "public, max-age=31536000, immutable"
                : "no-cache",
            };
            if (c.req.method === "HEAD") return c.body(null, 200, fileHeaders);
            return c.body(new Uint8Array(await readFile(absolute)), 200, fileHeaders);
          }
        } catch {
          // Not a file: fall back to the app.
        }
      }
    }

    const htmlHeaders = { ...headers, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" };
    if (c.req.method === "HEAD") return c.body(null, 200, htmlHeaders);
    return c.body(html, 200, htmlHeaders);
  };
}
