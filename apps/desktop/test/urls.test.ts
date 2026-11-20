import { describe, expect, it } from "vitest";
import { classifyNavigation } from "../src/urls";

const origin = "http://127.0.0.1:43123";

describe("desktop navigation policy (D26)", () => {
  it("keeps the app's own origin in the window", () => {
    expect(classifyNavigation(`${origin}/`, origin)).toEqual({ kind: "app" });
    expect(classifyNavigation(`${origin}/#/Projects/Map.canvas`, origin)).toEqual({ kind: "app" });
  });

  it("sends web and mail links to the system", () => {
    expect(classifyNavigation("https://example.com/a?b=1", origin)).toEqual({ kind: "external", url: "https://example.com/a?b=1" });
    expect(classifyNavigation("http://example.com", origin)).toEqual({ kind: "external", url: "http://example.com/" });
    expect(classifyNavigation("mailto:me@example.com", origin)).toEqual({ kind: "external", url: "mailto:me@example.com" });
    // Another local port is another site, not the app.
    expect(classifyNavigation("http://127.0.0.1:9999/", origin)).toEqual({ kind: "external", url: "http://127.0.0.1:9999/" });
  });

  it("ignores every other scheme", () => {
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,<b>x</b>", "obsidian://open?vault=x", "ftp://x", "not a url", ""]) {
      expect(classifyNavigation(url, origin), url).toEqual({ kind: "ignore" });
    }
  });

  it("opens vault files (/api/files/…) with the system, never outside the vault", () => {
    expect(classifyNavigation(`${origin}/api/files/attachments/report%20v2.pdf`, origin)).toEqual({
      kind: "vault-file",
      path: "attachments/report v2.pdf",
    });
    // A literal `../` is resolved by the URL parser: it no longer names a file.
    expect(classifyNavigation(`${origin}/api/files/a/../../b`, origin)).toEqual({ kind: "app" });
    for (const bad of ["/api/files/..%2Fsecret", "/api/files/a%2F..%2F..%2Fb", "/api/files/.gumply/x", "/api/files/%2Fetc%2Fpasswd", "/api/files/", "/api/files/%E0%A4%A"]) {
      expect(classifyNavigation(`${origin}${bad}`, origin), bad).toEqual({ kind: "ignore" });
    }
  });
});
