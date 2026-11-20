import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { startGumplyServer } from "../src/start";
import { appContentSecurityPolicy, inlineScriptHashes } from "../src/static";

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "gumply-static-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const INLINE = "document.documentElement.dataset.theme = 'light';";
function webRoot(): string {
  const root = temp();
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "index.html"), `<!doctype html><script>${INLINE}</script><script type="module" src="/assets/app.js"></script>`);
  writeFileSync(join(root, "assets", "app.js"), "console.log('app')");
  writeFileSync(join(root, ".secret"), "nope");
  return root;
}

describe("serving the built web app (desktop, D26)", () => {
  it("hashes inline scripts for the CSP and nothing else", () => {
    const hash = createHash("sha256").update(INLINE).digest("base64");
    expect(inlineScriptHashes(`<script>${INLINE}</script><script src="/x.js"></script><script> </script>`)).toEqual([`'sha256-${hash}'`]);
    const csp = appContentSecurityPolicy([`'sha256-${hash}'`]);
    expect(csp).toContain(`script-src 'self' 'sha256-${hash}'`);
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("connect-src 'self'");
  });

  it("starts on a random port, serves the app and the API on one origin", async () => {
    const server = await startGumplyServer({ vaultPath: temp(), port: 0, webRoot: webRoot(), log: () => undefined });
    try {
      expect(server.port).toBeGreaterThan(0);
      expect(server.url).toBe(`http://127.0.0.1:${server.port}`);

      const index = await fetch(`${server.url}/`);
      expect(index.status).toBe(200);
      expect(index.headers.get("content-type")).toContain("text/html");
      expect(index.headers.get("content-security-policy")).toContain("'sha256-");
      expect(await index.text()).toContain(INLINE);

      const asset = await fetch(`${server.url}/assets/app.js`);
      expect(asset.headers.get("content-type")).toContain("javascript");
      expect(asset.headers.get("cache-control")).toContain("immutable");

      // Unknown paths fall back to the app; dot files and traversal never leak.
      for (const path of ["/some/route", "/.secret", "/..%2F..%2Fetc%2Fpasswd", "/assets/../.secret"]) {
        const response = await fetch(`${server.url}${path}`);
        expect(await response.text(), path).toContain(INLINE);
      }

      // The API is there, with the demo, and writes from its own origin pass.
      const pages = (await (await fetch(`${server.url}/api/pages`)).json()) as Array<{ title: string }>;
      expect(pages.map((page) => page.title)).toContain("Welcome");
      const created = await fetch(`${server.url}/api/pages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: server.url },
        body: JSON.stringify({ title: "From the app" }),
      });
      expect(created.status).toBe(201);
      const foreign = await fetch(`${server.url}/api/pages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
        body: JSON.stringify({ title: "nope" }),
      });
      expect(foreign.status).toBe(403);
    } finally {
      await server.close();
    }
  });

  it("without webRoot nothing but the API is served (npm run dev)", async () => {
    const server = await startGumplyServer({ vaultPath: temp(), port: 0, seedDemo: false, log: () => undefined });
    try {
      expect((await fetch(`${server.url}/`)).status).toBe(404);
      expect((await fetch(`${server.url}/api/pages`)).status).toBe(200);
    } finally {
      await server.close();
    }
  });
});
