import { describe, expect, it } from "vitest";
import { classifyNavigation, newWindowUrl, userGuideUrl, vaultFileAction } from "../src/urls";

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

describe("trash: Show in file manager (#ppag3ugh)", () => {
  it("is a reveal action for a plain trash id, and nothing else", () => {
    expect(classifyNavigation(`${origin}/api/trash/0b1c-2d3e/reveal`, origin)).toEqual({
      kind: "trash-reveal",
      trashId: "0b1c-2d3e",
    });
    for (const bad of ["/api/trash/..%2F..%2Fx/reveal", "/api/trash/a.b/reveal", "/api/trash/%2E%2E/reveal", "/api/trash//reveal"]) {
      // (`%2E%2E` is resolved by the URL parser into another, harmless app path.)
      expect(classifyNavigation(`${origin}${bad}`, origin).kind, bad).not.toBe("trash-reveal");
    }
    // Another site can't ask for it.
    expect(classifyNavigation("http://127.0.0.1:9999/api/trash/abc/reveal", origin).kind).toBe("external");
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

describe("Help → User guide (#6ka8s7mf)", () => {
  it("opens the guide on GitHub in the app's language, English otherwise", () => {
    expect(userGuideUrl("en")).toBe("https://github.com/arslanarm/gumply/blob/main/docs/guide/en/README.md");
    expect(userGuideUrl("ru")).toBe("https://github.com/arslanarm/gumply/blob/main/docs/guide/ru/README.md");
    expect(userGuideUrl("de")).toBe("https://github.com/arslanarm/gumply/blob/main/docs/guide/en/README.md");
  });
});


describe("which window.open becomes a new Gumply window (#vhdp68sm, N8)", () => {
  const origin = "http://127.0.0.1:4100";
  it("the app's own page, with or without a page route", () => {
    expect(newWindowUrl(`${origin}/#/Projects%2FRoadmap`, origin)).toBe(`${origin}/#/Projects%2FRoadmap`);
    expect(newWindowUrl(`${origin}/`, origin)).toBe(`${origin}/`);
  });
  it("never files, the API, a blob, another site, a query, or another hash", () => {
    expect(newWindowUrl(`${origin}/api/files/a.pdf`, origin)).toBeNull();
    expect(newWindowUrl(`${origin}/api/pages`, origin)).toBeNull();
    expect(newWindowUrl(`blob:${origin}/123e4567`, origin)).toBeNull();
    expect(newWindowUrl("https://example.com/#/Notes", origin)).toBeNull();
    expect(newWindowUrl(`${origin}/?x=1#/Notes`, origin)).toBeNull();
    expect(newWindowUrl(`${origin}/#graph`, origin)).toBeNull();
    expect(newWindowUrl("not a url", origin)).toBeNull();
    expect(newWindowUrl(`${origin}/#/Notes`, "")).toBeNull();
  });
});
