import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { hostName, isAllowedOrigin, isSameOrigin, parsePorts } from "../src/security";
import { VaultStore } from "../src/vault-store";
import { cleanupVaults, createTestServer } from "./helpers";

afterEach(cleanupVaults);

const json = (body: unknown) => JSON.stringify(body);

async function server() {
  const { app, store, dir } = await createTestServer();
  const page = await store.create({ title: "Secret", content: "my notes" });
  return { app, store, dir, page };
}

describe("local-only API (#rv57cvhm)", () => {
  it("sends no CORS headers, not even for a preflight", async () => {
    const { app } = await server();
    const get = await app.request("http://localhost/api/pages", {
      headers: { Origin: "https://evil.example", Host: "localhost:8787" },
    });
    expect(get.headers.get("access-control-allow-origin")).toBeNull();
    const preflight = await app.request("http://localhost/api/pages", {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example",
        Host: "localhost:8787",
        "Access-Control-Request-Method": "PUT",
      },
    });
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    expect(preflight.headers.get("access-control-allow-methods")).toBeNull();
  });

  it("refuses a foreign Host (DNS rebinding) with 403 JSON", async () => {
    const { app } = await server();
    for (const host of ["evil.example", "evil.example:8787", "127.0.0.1.nip.io:8787", "192.168.1.5:8787"]) {
      const response = await app.request("http://localhost/api/pages", { headers: { Host: host } });
      expect(response.status, host).toBe(403);
      expect(((await response.json()) as { error: string }).error).toContain("only answers on this computer");
    }
  });

  it("accepts loopback hosts on any port", async () => {
    const { app } = await server();
    for (const host of ["localhost:5173", "localhost", "127.0.0.1:8787", "[::1]:8787", "LOCALHOST:1"]) {
      const response = await app.request("http://localhost/api/pages", { headers: { Host: host } });
      expect(response.status, host).toBe(200);
    }
  });

  it("refuses writes from other origins (CSRF), including simple requests", async () => {
    const { app, store, page } = await server();
    const attempts: Array<[string, RequestInit]> = [
      [`/api/pages/${page.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: json({ content: "pwned" }) }],
      // A form-style text/plain POST skips CORS preflight in browsers.
      ["/api/pages", { method: "POST", headers: { "Content-Type": "text/plain" }, body: json({ title: "pwned" }) }],
      [`/api/pages/${page.id}`, { method: "DELETE" }],
      ["/api/attachments", { method: "POST", body: (() => { const f = new FormData(); f.set("file", new File(["x"], "x.png")); return f; })() }],
      ["/api/attachments/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: json({ url: "https://x.example/a.png" }) }],
    ];
    for (const origin of ["https://evil.example", "http://localhost:3000", "null", "http://127.0.0.1.evil.example:5173"]) {
      for (const [path, init] of attempts) {
        const headers = new Headers(init.headers);
        headers.set("Origin", origin);
        headers.set("Host", "localhost:8787");
        const response = await app.request(`http://localhost${path}`, { ...init, headers });
        expect(response.status, `${init.method} ${path} from ${origin}`).toBe(403);
      }
    }
    // Nothing changed.
    expect(store.get(page.id).content).toBe("my notes");
    expect(store.list().map((item) => item.title)).toEqual(["Secret"]);
  });

  it("accepts writes from the web app's origin and without an Origin (scripts, curl)", async () => {
    const { app, store, page } = await server();
    for (const origin of ["http://localhost:5173", "http://127.0.0.1:5173", "http://[::1]:5173", undefined]) {
      const headers: Record<string, string> = { "Content-Type": "application/json", Host: "localhost:5173" };
      if (origin) headers.Origin = origin;
      const response = await app.request(`http://localhost/api/pages/${page.id}`, {
        method: "PUT",
        headers,
        body: json({ content: `from ${origin ?? "script"}` }),
      });
      expect(response.status, origin ?? "no origin").toBe(200);
    }
    expect(store.get(page.id).content).toBe("from script");
  });

  it("accepts the web app on any local port through its proxy (same Origin and Host, #kmff9wkt)", async () => {
    const { app, store, page } = await server();
    const put = (origin: string, host: string) =>
      app.request(`http://localhost/api/pages/${page.id}`, {
        method: "PUT",
        headers: { Origin: origin, Host: host, "Content-Type": "application/json" },
        body: json({ content: `via ${host}` }),
      });
    // Vite on 10400 and `vite preview` on 4173, no GUMPLY_WEB_PORT.
    expect((await put("http://localhost:10400", "localhost:10400")).status).toBe(200);
    expect((await put("http://127.0.0.1:4173", "127.0.0.1:4173")).status).toBe(200);
    // Same-origin only helps a loopback Host; a foreign site never matches.
    expect((await put("http://evil.example:80", "evil.example")).status).toBe(403);
    expect((await put("https://evil.example", "localhost:10400")).status).toBe(403);
    expect((await put("http://localhost:10400", "localhost:10401")).status).toBe(403);
    expect(store.get(page.id).content).toBe("via 127.0.0.1:4173");
  });

  it("uses the configured web ports and host", async () => {
    const dir = (await createTestServer()).dir;
    const store = new VaultStore(dir);
    await store.init();
    const app = createApp({
      vaultPath: dir,
      store,
      security: { webPorts: [11001], apiPort: 11000, host: "gumply.lan" },
    });
    const put = (origin: string, host = "localhost:11001") =>
      app.request("http://localhost/api/pages", {
        method: "POST",
        headers: { Origin: origin, Host: host, "Content-Type": "application/json" },
        body: json({ title: "T" }),
      });
    expect((await put("http://localhost:11001")).status).toBe(201);
    expect((await put("http://localhost:11000")).status).toBe(201); // the API itself
    expect((await put("http://localhost:5173")).status).toBe(403);
    expect((await put("http://gumply.lan:11001", "gumply.lan:11000")).status).toBe(201);
    expect((await put("http://other.lan:11001", "gumply.lan:11000")).status).toBe(403);
  });
});

describe("config and helpers", () => {
  it("binds to loopback by default; GUMPLY_HOST and GUMPLY_WEB_PORT opt in", () => {
    expect(loadConfig({}).host).toBe("127.0.0.1");
    expect(loadConfig({}).webPorts).toEqual([5173]);
    expect(loadConfig({ GUMPLY_HOST: "0.0.0.0", GUMPLY_WEB_PORT: "5174, 6000" })).toMatchObject({
      host: "0.0.0.0",
      webPorts: [5174, 6000],
    });
  });

  it("parses hosts and origins strictly", () => {
    expect(hostName("localhost:5173")).toBe("localhost");
    expect(hostName("[::1]:8787")).toBe("[::1]");
    expect(hostName("EVIL.example")).toBe("evil.example");
    expect(isAllowedOrigin("http://localhost:5173", { webPorts: [5173] })).toBe(true);
    expect(isAllowedOrigin("http://localhost", { webPorts: [5173] })).toBe(false);
    expect(isAllowedOrigin("file://", { webPorts: [5173] })).toBe(false);
    expect(isAllowedOrigin("not a url", { webPorts: [5173] })).toBe(false);
    expect(parsePorts("x,0,70000", [5173])).toEqual([5173]);
    expect(isSameOrigin("http://localhost:10400", "localhost:10400")).toBe(true);
    expect(isSameOrigin("http://localhost:10400", undefined)).toBe(false);
    expect(isSameOrigin("null", "localhost:10400")).toBe(false);
  });
});
