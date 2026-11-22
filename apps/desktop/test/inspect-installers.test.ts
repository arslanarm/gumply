import { describe, expect, it } from "vitest";
import {
  debianVersion,
  expectedInstallers,
  expectedUpdateFiles,
  inspectAsar,
  inspectUpdateConfig,
  inspectUpdateInfo,
  parseFlatYaml,
  parseDebControl,
  parseDesktopEntry,
  peVersionString,
  readAr,
  readAsar,
  summaryMarkdown,
} from "../src/inspect-installers";

/** A minimal asar archive (same layout Electron reads) from path → content. */
function makeAsar(files: Record<string, string>): Buffer {
  const root: { files: Record<string, unknown> } = { files: {} };
  const blobs: Buffer[] = [];
  let offset = 0;
  for (const [path, content] of Object.entries(files)) {
    const parts = path.split("/").filter(Boolean);
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      dir.files[part] ??= { files: {} };
      dir = dir.files[part] as typeof root;
    }
    const data = Buffer.from(content, "utf8");
    dir.files[parts.at(-1)!] = { size: data.length, offset: String(offset) };
    blobs.push(data);
    offset += data.length;
  }
  const json = Buffer.from(JSON.stringify(root), "utf8");
  const padded = Buffer.alloc((json.length + 3) & ~3);
  json.copy(padded);
  const pickle = Buffer.alloc(8 + padded.length);
  pickle.writeUInt32LE(4 + padded.length, 0);
  pickle.writeUInt32LE(json.length, 4);
  padded.copy(pickle, 8);
  const head = Buffer.alloc(8);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(pickle.length, 4);
  return Buffer.concat([head, pickle, ...blobs]);
}

/** One VS_VERSIONINFO String entry, as Windows stores it. */
function peString(key: string, value: string): Buffer {
  const keyBytes = Buffer.from(`${key}\0`, "utf16le");
  const headerAndKey = 6 + keyBytes.length;
  const pad = ((headerAndKey + 3) & ~3) - headerAndKey;
  const valueBytes = Buffer.from(`${value}\0`, "utf16le");
  const out = Buffer.alloc(headerAndKey + pad + valueBytes.length);
  out.writeUInt16LE(out.length, 0);
  out.writeUInt16LE(value.length + 1, 2);
  out.writeUInt16LE(1, 4);
  keyBytes.copy(out, 6);
  valueBytes.copy(out, headerAndKey + pad);
  return out;
}

const goodApp = {
  "/package.json": JSON.stringify({ name: "@gumply/desktop", version: "0.5.0-rc.3", main: "dist/main.mjs" }),
  "/dist/main.mjs": "console.log('main');\n",
  "/dist/web/index.html": "<!doctype html><title>Gumply</title>",
};

const failing = (results: ReturnType<typeof inspectAsar>) => results.filter((r) => !r.ok && !r.warn).map((r) => r.check);

describe("installer inspection (#sj44x5ph)", () => {
  it("reads an asar archive and passes a clean app", () => {
    const files = readAsar(makeAsar(goodApp));
    expect(files.map((f) => f.path).sort()).toEqual(["/dist/main.mjs", "/dist/web/index.html", "/package.json"]);
    expect(files.find((f) => f.path === "/dist/main.mjs")!.read().toString()).toBe("console.log('main');\n");
    expect(failing(inspectAsar(files, "0.5.0-rc.3", "x"))).toEqual([]);
  });

  it("fails an asar with node_modules, a source map, a sourceMappingURL, TS sources or the wrong version", () => {
    const files = readAsar(
      makeAsar({
        ...goodApp,
        "/dist/main.mjs": "console.log('main');\n//# sourceMappingURL=main.mjs.map\n",
        "/dist/main.mjs.map": "{}",
        "/node_modules/left-pad/index.js": "module.exports = 1;",
        "/src/main.ts": "export {};",
      }),
    );
    expect(failing(inspectAsar(files, "0.5.0", "x"))).toEqual([
      "asar: no node_modules",
      "asar: no source maps",
      "asar: no TypeScript sources",
      "asar: no sourceMappingURL",
      "asar: package.json version",
    ]);
  });

  it("fails an asar that contains a credential, and only warns about build paths", () => {
    // Built from pieces so this test file itself never contains a token pattern.
    const token = ["gh", "p_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("");
    const key = ["-----BEGIN ", "OPENSSH PRIVATE", " KEY-----"].join("");
    const results = inspectAsar(
      readAsar(makeAsar({ ...goodApp, "/dist/a.js": `const t = "${token}";`, "/dist/b.js": key, "/dist/c.js": "/home/runner/work/gumply/x.ts" })),
      "0.5.0-rc.3",
      "x",
    );
    expect(failing(results)).toEqual(["asar: no secrets"]);
    expect(results.find((r) => r.check === "asar: no secrets")!.detail).toMatch(/GitHub token in \/dist\/a\.js; private key in \/dist\/b\.js/);
    expect(results.find((r) => r.check === "asar: no build-machine paths")).toMatchObject({ ok: false, warn: true });
  });

  it("reads Windows version strings (FileDescription, FileVersion)", () => {
    const pe = Buffer.concat([Buffer.alloc(13, 0xaa), peString("FileDescription", "Gumply"), peString("FileVersion", "0.5.0-rc.3"), Buffer.alloc(5)]);
    expect(peVersionString(pe, "FileDescription")).toBe("Gumply");
    expect(peVersionString(pe, "FileVersion")).toBe("0.5.0-rc.3");
    expect(peVersionString(pe, "ProductName")).toBeNull();
    const old = peString("FileDescription", "Gumply desktop app: Electron shell around the local server and the web app (D26).");
    expect(peVersionString(old, "FileDescription")).toMatch(/\(D26\)\.$/);
  });

  it("reads .deb (ar) members, control fields and .desktop entries", () => {
    const member = (name: string, body: string) => {
      const header = Buffer.alloc(60, 0x20);
      header.write(`${name}/`, 0, "latin1");
      header.write(String(body.length), 48, "latin1");
      header.write("`\n", 58, "latin1");
      return Buffer.concat([header, Buffer.from(body, "latin1"), body.length % 2 ? Buffer.from("\n") : Buffer.alloc(0)]);
    };
    const ar = Buffer.concat([Buffer.from("!<arch>\n"), member("debian-binary", "2.0\n"), member("control.tar.xz", "abc")]);
    const members = readAr(ar);
    expect([...members.keys()]).toEqual(["debian-binary", "control.tar.xz"]);
    expect(members.get("control.tar.xz")!.toString()).toBe("abc");
    expect(() => readAr(Buffer.from("not an archive"))).toThrow(/not an ar archive/);

    const control = parseDebControl("Package: gumply\nVersion: 0.5.0~rc.3\nLicense: UNLICENSED\nDescription: Notes\n  more text\n");
    expect(control).toMatchObject({ Package: "gumply", Version: "0.5.0~rc.3", License: "UNLICENSED" });
    expect(debianVersion("0.5.0-rc.3")).toBe("0.5.0~rc.3");
    expect(parseDesktopEntry("[Desktop Entry]\nExec=/opt/Gumply/gumply %U\nX-AppImage-Version=0.5.0\n[Other]\nExec=nope\n")).toEqual({
      Exec: "/opt/Gumply/gumply %U",
      "X-AppImage-Version": "0.5.0",
    });
  });

  it("knows the installer names per platform and writes a summary", () => {
    expect(expectedInstallers("win", "0.5.0")).toEqual(["Gumply-Setup-0.5.0-x64.exe"]);
    expect(expectedInstallers("mac", "0.5.0")).toContain("Gumply-0.5.0-arm64.dmg");
    const md = summaryMarkdown("t", [
      { target: "a", check: "ok one", ok: true, detail: "fine" },
      { target: "a", check: "bad | one", ok: false, detail: "x|y" },
    ], ["abc  a"]);
    expect(md).toMatch(/^### ❌ t: 1 passed, 1 failed/);
    expect(md).toContain("x\\|y");
    expect(md).toContain("abc  a");
  });
});

describe("update files (spec/auto-update)", () => {
  it("names the yml and blockmaps each platform ships", () => {
    expect(expectedUpdateFiles("win", "0.9.0")).toEqual({ yml: "latest.yml", blockmaps: ["Gumply-Setup-0.9.0-x64.exe.blockmap"] });
    expect(expectedUpdateFiles("linux", "0.9.0")).toEqual({ yml: "latest-linux.yml", blockmaps: [] });
    expect(expectedUpdateFiles("mac", "0.9.0")).toEqual({ yml: "latest-mac.yml", blockmaps: [] });
  });

  const assets = { "Gumply-Setup-0.9.0-x64.exe": { sha512: "abc==", size: 10 } };
  const info = {
    version: "0.9.0",
    files: [{ url: "Gumply-Setup-0.9.0-x64.exe", sha512: "abc==", size: 10 }],
    path: "Gumply-Setup-0.9.0-x64.exe",
    sha512: "abc==",
  };

  it("passes when the version is the tag and every listed file matches", () => {
    expect(inspectUpdateInfo("latest.yml", info, "0.9.0", assets).every((r) => r.ok)).toBe(true);
  });

  it("fails a wrong version, a missing file, or a changed file", () => {
    const failed = (results: ReturnType<typeof inspectUpdateInfo>) => results.filter((r) => !r.ok).map((r) => r.check);
    expect(failed(inspectUpdateInfo("latest.yml", info, "0.9.1", assets))).toEqual(["update info version"]);
    expect(failed(inspectUpdateInfo("latest.yml", info, "0.9.0", {}))).toEqual(["Gumply-Setup-0.9.0-x64.exe: in the release", "update info path in the release"]);
    expect(failed(inspectUpdateInfo("latest.yml", info, "0.9.0", { "Gumply-Setup-0.9.0-x64.exe": { sha512: "xyz==", size: 10 } }))).toEqual([
      "Gumply-Setup-0.9.0-x64.exe: sha512 and size",
    ]);
    expect(failed(inspectUpdateInfo("latest.yml", { version: "0.9.0", files: [] }, "0.9.0", assets))).toEqual(["update info lists files"]);
  });

  it("app-update.yml must point at GitHub arslanarm/gumply", () => {
    const github = "owner: arslanarm\nrepo: gumply\nprovider: github\nreleaseType: release\nupdaterCacheDirName: gumply-updater\n";
    expect(parseFlatYaml(github)).toMatchObject({ provider: "github", owner: "arslanarm", repo: "gumply" });
    expect(inspectUpdateConfig("x", github).ok).toBe(true);
    expect(inspectUpdateConfig("x", "provider: generic\nurl: http://127.0.0.1:9/\n").ok).toBe(false);
    expect(inspectUpdateConfig("x", null)).toMatchObject({ ok: false, detail: "missing" });
  });
});
