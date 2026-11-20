import { describe, expect, it } from "vitest";
import { classifyNavigation, vaultFileAction } from "../src/urls";

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

describe("vault files: open documents, only reveal anything that could run", () => {
  it("opens documents, media and archives with the default app", () => {
    for (const path of ["attachments/report.pdf", "a/b/Photo.JPG", "notes.md", "data.csv", "deck.pptx", "clip.mp4", "song.flac", "backup.tar.gz", "x.zip"]) {
      expect(vaultFileAction(path), path).toBe("open");
    }
  });

  it("never opens programs, scripts or launchers: they are revealed instead", () => {
    for (const path of [
      "attachments/x.exe", "x.bat", "x.cmd", "x.com", "x.ps1", "x.vbs", "x.vbe", "x.js", "x.jse", "x.wsf", "x.hta",
      "x.lnk", "x.url", "x.msi", "x.scr", "x.cpl", "x.jar", "x.reg",
      "x.sh", "x.bash", "x.desktop", "x.AppImage", "x.run", "x.bin", "x.py", "x.pl", "x.deb", "x.rpm",
      "x.app", "x.command", "x.dmg", "x.pkg", "x.html", "x.svg", "x.pdf.exe",
      "noextension", ".hidden", "folder/.bashrc",
    ]) {
      expect(vaultFileAction(path), path).toBe("reveal");
    }
  });
});
