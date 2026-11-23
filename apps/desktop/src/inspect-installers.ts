// Pure checks for the shipped installers (#sj44x5ph). The CLI in
// scripts/inspect-installers.mjs extracts each installer and feeds the pieces
// here; everything in this file works on bytes and strings only, so it is
// unit-tested without real installers.
//
// Erasable TypeScript only: Node runs this file directly (type stripping).

/** One check's outcome. `warn` results are reported but don't fail the build. */
export interface CheckResult {
  target: string;
  check: string;
  ok: boolean;
  detail: string;
  warn?: boolean;
}

/* ------------------------------------------------------------------------ */
/* Names and versions                                                        */
/* ------------------------------------------------------------------------ */

export type Platform = "linux" | "win" | "mac";

/** The installer file names electron-builder produces for `version`. */
export function expectedInstallers(platform: Platform, version: string): string[] {
  switch (platform) {
    case "linux":
      return [`Gumply-${version}-x86_64.AppImage`, `Gumply-${version}-amd64.deb`];
    case "win":
      return [`Gumply-Setup-${version}-x64.exe`];
    case "mac":
      return [
        `Gumply-${version}-arm64.dmg`,
        `Gumply-${version}-x64.dmg`,
        `Gumply-${version}-arm64.zip`,
        `Gumply-${version}-x64.zip`,
      ];
  }
}

/* ------------------------------------------------------------------------ */
/* Update files (spec/auto-update, #a7qepp99)                                */
/* ------------------------------------------------------------------------ */

/**
 * The update files each platform's build must ship next to its installers:
 * electron-updater's `latest*.yml` (versions, file names, sha512) and, for
 * NSIS, the installer's blockmap (differential downloads; the AppImage
 * embeds its own).
 */
export function expectedUpdateFiles(platform: Platform, version: string): { yml: string; blockmaps: string[] } {
  switch (platform) {
    case "linux":
      // The AppImage carries its blockmap inside (`blockMapSize` in the yml).
      return { yml: "latest-linux.yml", blockmaps: [] };
    case "win":
      return { yml: "latest.yml", blockmaps: [`Gumply-Setup-${version}-x64.exe.blockmap`] };
    case "mac":
      return { yml: "latest-mac.yml", blockmaps: [] };
  }
}

/** A release file's digest as electron-updater lists it: sha512 in base64, size in bytes. */
export interface AssetDigest {
  sha512: string;
  size: number;
}

/**
 * A parsed `latest*.yml` against the files actually in the release: the
 * version is the tag's, and every listed file is there with that sha512 and
 * size (electron-updater refuses a mismatch, so this is the release working).
 */
export function inspectUpdateInfo(name: string, info: unknown, version: string, assets: Record<string, AssetDigest>): CheckResult[] {
  const results: CheckResult[] = [];
  const data = (info && typeof info === "object" ? info : {}) as Record<string, unknown>;
  results.push({ target: name, check: "update info version", ok: data.version === version, detail: String(data.version ?? "(missing)") });
  const files = Array.isArray(data.files) ? (data.files as Array<Record<string, unknown>>) : [];
  results.push({ target: name, check: "update info lists files", ok: files.length > 0, detail: files.map((file) => String(file.url)).join(", ") || "none" });
  for (const file of files) {
    const url = String(file.url ?? "");
    const asset = assets[url];
    if (!asset) {
      results.push({ target: name, check: `${url}: in the release`, ok: false, detail: "missing" });
      continue;
    }
    const ok = file.sha512 === asset.sha512 && Number(file.size) === asset.size;
    results.push({
      target: name,
      check: `${url}: sha512 and size`,
      ok,
      detail: ok ? `${asset.size} bytes` : `listed ${String(file.size)} / ${String(file.sha512).slice(0, 12)}…, file ${asset.size} / ${asset.sha512.slice(0, 12)}…`,
    });
  }
  if (typeof data.path === "string") {
    results.push({ target: name, check: "update info path in the release", ok: data.path in assets, detail: data.path });
  }
  return results;
}

/** The flat `key: value` lines of `app-update.yml` (electron-builder writes no nesting there). */
export function parseFlatYaml(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z][\w-]*):\s*(.*?)\s*$/.exec(line);
    if (match) out[match[1]!] = match[2]!.replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

/**
 * The app's own update source (`resources/app-update.yml`): GitHub,
 * arslanarm/gumply. A release build must never point anywhere else.
 */
export function inspectUpdateConfig(target: string, text: string | null): CheckResult {
  if (text === null) return { target, check: "app-update.yml: GitHub releases", ok: false, detail: "missing" };
  const config = parseFlatYaml(text);
  const ok = config.provider === "github" && config.owner === "arslanarm" && config.repo === "gumply";
  return { target, check: "app-update.yml: GitHub releases", ok, detail: `${config.provider ?? "?"} ${config.owner ?? "?"}/${config.repo ?? "?"}` };
}

/** Debian has no `-` in upstream versions: electron-builder writes 0.5.0-rc.3 as 0.5.0~rc.3. */
export function debianVersion(version: string): string {
  return version.replace(/-/g, "~");
}

/** `Key: value` lines of a Debian control file (continuation lines ignored). */
export function parseDebControl(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = /^([A-Za-z][A-Za-z0-9-]*):\s?(.*)$/.exec(line);
    if (match) fields[match[1]!] = match[2]!.trim();
  }
  return fields;
}

/** `Key=value` lines of the [Desktop Entry] group of a .desktop file. */
export function parseDesktopEntry(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  let inEntry = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      inEntry = trimmed === "[Desktop Entry]";
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (inEntry && eq > 0) fields[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return fields;
}

/* ------------------------------------------------------------------------ */
/* ar archives (.deb)                                                        */
/* ------------------------------------------------------------------------ */

/** Members of an `ar` archive (a .deb is one: debian-binary, control.tar.*, data.tar.*). */
export function readAr(buf: Buffer): Map<string, Buffer> {
  if (buf.toString("latin1", 0, 8) !== "!<arch>\n") throw new Error("not an ar archive");
  const members = new Map<string, Buffer>();
  let offset = 8;
  while (offset + 60 <= buf.length) {
    const name = buf.toString("latin1", offset, offset + 16).trim().replace(/\/$/, "");
    const size = Number.parseInt(buf.toString("latin1", offset + 48, offset + 58).trim(), 10);
    if (!Number.isFinite(size)) throw new Error(`bad ar header at ${offset}`);
    const start = offset + 60;
    members.set(name, buf.subarray(start, start + size));
    offset = start + size + (size % 2); // members are 2-byte aligned
  }
  return members;
}

/* ------------------------------------------------------------------------ */
/* app.asar                                                                  */
/* ------------------------------------------------------------------------ */

interface AsarEntry {
  files?: Record<string, AsarEntry>;
  size?: number;
  offset?: string;
  unpacked?: boolean;
  link?: string;
}

export interface AsarFile {
  path: string;
  size: number;
  unpacked: boolean;
  /** File content (empty for unpacked files, which live in app.asar.unpacked). */
  read(): Buffer;
}

/**
 * The files of an asar archive. Format: uint32 4, uint32 header pickle size,
 * then a pickle holding uint32 payload size, uint32 JSON length and the JSON
 * header; file data starts right after the header pickle.
 */
export function readAsar(buf: Buffer): AsarFile[] {
  const headerPickleSize = buf.readUInt32LE(4);
  const jsonLength = buf.readUInt32LE(12);
  const header = JSON.parse(buf.toString("utf8", 16, 16 + jsonLength)) as AsarEntry;
  const base = 8 + headerPickleSize;
  const out: AsarFile[] = [];
  const walk = (entry: AsarEntry, prefix: string): void => {
    for (const [name, child] of Object.entries(entry.files ?? {})) {
      const path = `${prefix}/${name}`;
      if (child.files) walk(child, path);
      else if (child.link === undefined) {
        const size = child.size ?? 0;
        const unpacked = child.unpacked === true;
        const start = base + Number(child.offset ?? 0);
        out.push({ path, size, unpacked, read: () => (unpacked ? Buffer.alloc(0) : buf.subarray(start, start + size)) });
      }
    }
  };
  walk(header, "");
  return out;
}

/** Credentials that must never ship. */
export const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["GitHub token", /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{36}\b/],
  ["GitHub fine-grained token", /\bgithub_pat_[A-Za-z0-9_]{22,}\b/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["npm token", /\bnpm_[A-Za-z0-9]{36}\b/],
];

/** Build-machine paths: not secret, but they shouldn't be baked into the app (warning only). */
export const BUILD_PATH_PATTERNS: Array<[string, RegExp]> = [
  ["CI checkout path", /\/home\/runner\/work\/|\/Users\/runner\/work\/|[A-Z]:\\a\\[^\\]+\\/],
  ["developer home path", /\/home\/[a-z][a-z0-9_-]*\/(?:projects|\.swarm)\//],
];

/** Every check on one app.asar. `label` names the installer it came from. */
export function inspectAsar(files: AsarFile[], version: string, label: string): CheckResult[] {
  const results: CheckResult[] = [];
  const add = (check: string, ok: boolean, detail: string, warn = false): void => {
    results.push({ target: label, check, ok, detail, ...(warn ? { warn } : {}) });
  };
  const paths = files.map((f) => f.path);
  const nodeModules = paths.filter((p) => p.includes("/node_modules/"));
  const maps = paths.filter((p) => p.endsWith(".map"));
  const sources = paths.filter((p) => /\.(?:tsx?|mts|cts)$/.test(p) && !p.endsWith(".d.ts"));
  add("asar: no node_modules", nodeModules.length === 0, nodeModules.length ? nodeModules.slice(0, 3).join(", ") : `${files.length} files`);
  add("asar: no source maps", maps.length === 0, maps.length ? maps.slice(0, 3).join(", ") : "0 .map files");
  add("asar: no TypeScript sources", sources.length === 0, sources.length ? sources.slice(0, 3).join(", ") : "none");

  const mapRefs: string[] = [];
  const secrets: string[] = [];
  const buildPaths: string[] = [];
  const testFeed: string[] = [];
  for (const file of files) {
    if (file.unpacked) continue;
    const text = file.read().toString("latin1");
    if (/[#@]\s*sourceMappingURL=/.test(text)) mapRefs.push(file.path);
    // spec/auto-update §8: only CI's update-test builds may redirect updates.
    if (text.includes("GUMPLY_UPDATE_FEED")) testFeed.push(file.path);
    for (const [name, re] of SECRET_PATTERNS) if (re.test(text)) secrets.push(`${name} in ${file.path}`);
    for (const [name, re] of BUILD_PATH_PATTERNS) if (re.test(text)) buildPaths.push(`${name} in ${file.path}`);
  }
  add("asar: no sourceMappingURL", mapRefs.length === 0, mapRefs.length ? mapRefs.join(", ") : "none");
  add("asar: no secrets", secrets.length === 0, secrets.length ? secrets.join("; ") : "none");
  add("asar: no update test feed", testFeed.length === 0, testFeed.length ? `GUMPLY_UPDATE_FEED in ${testFeed.join(", ")}` : "none");
  add("asar: no build-machine paths", buildPaths.length === 0, buildPaths.length ? buildPaths.join("; ") : "none", buildPaths.length > 0);

  const pkg = files.find((f) => f.path === "/package.json");
  let pkgVersion = "(missing)";
  try {
    if (pkg) pkgVersion = String((JSON.parse(pkg.read().toString("utf8")) as { version?: unknown }).version);
  } catch {
    pkgVersion = "(unreadable)";
  }
  add("asar: package.json version", pkgVersion === version, pkgVersion);
  return results;
}

/* ------------------------------------------------------------------------ */
/* Windows version resources                                                 */
/* ------------------------------------------------------------------------ */

/**
 * A string from a PE file's VS_VERSIONINFO (FileDescription, FileVersion, …).
 * Each String entry is: uint16 wLength, uint16 wValueLength (in UTF-16
 * units, including the terminator), uint16 wType, the key in UTF-16 with a
 * terminator, padding to a 4-byte boundary, then the value.
 */
export function peVersionString(buf: Buffer, key: string): string | null {
  const needle = Buffer.from(`${key}\0`, "utf16le");
  let from = 0;
  for (;;) {
    const at = buf.indexOf(needle, from);
    if (at < 0) return null;
    from = at + 2;
    if (at < 6) continue;
    const valueLength = buf.readUInt16LE(at - 4);
    const type = buf.readUInt16LE(at - 2);
    if (type !== 1 || valueLength === 0 || valueLength > 512) continue;
    // Padding is relative to the start of this String entry (6 bytes before the key).
    const entry = at - 6;
    const valueStart = entry + ((6 + needle.length + 3) & ~3);
    const value = buf.toString("utf16le", valueStart, valueStart + (valueLength - 1) * 2);
    return value.replace(/\0+$/, "");
  }
}

/* ------------------------------------------------------------------------ */
/* Report                                                                    */
/* ------------------------------------------------------------------------ */

/** Markdown for $GITHUB_STEP_SUMMARY. */
export function summaryMarkdown(title: string, results: CheckResult[], sums: string[]): string {
  const failed = results.filter((r) => !r.ok && !r.warn).length;
  const warned = results.filter((r) => !r.ok && r.warn).length;
  const lines = [
    `### ${failed === 0 ? "✅" : "❌"} ${title}: ${results.length - failed - warned} passed, ${failed} failed${warned ? `, ${warned} warning(s)` : ""}`,
    "",
    "| | Installer | Check | Detail |",
    "|---|---|---|---|",
    ...results.map((r) => `| ${r.ok ? "✅" : r.warn ? "⚠️" : "❌"} | ${r.target} | ${r.check} | ${r.detail.replace(/\|/g, "\\|").slice(0, 200)} |`),
  ];
  if (sums.length) lines.push("", "<details><summary>SHA-256</summary>", "", "```", ...sums, "```", "</details>");
  return `${lines.join("\n")}\n`;
}
