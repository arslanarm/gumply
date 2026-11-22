// Pure parts of `scripts/notices.mjs` (#mbim529b): which package a bundled
// file belongs to, licence expressions and the allowlist, copyright lines, and
// the Markdown of THIRD_PARTY_NOTICES.md. No bundler here, so tests can run it.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Licences Gumply may ship without asking (one option of an `OR` is enough). */
export const ALLOWED = new Set(["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "0BSD", "OFL-1.1"]);

/**
 * The package directory and name of a bundled file, from its path: the part
 * after the last `node_modules/` (scoped names have two segments). Null for
 * Gumply's own sources and virtual modules.
 */
export function packageOf(file) {
  const path = String(file).replace(/\\/g, "/").replace(/\?.*$/, "");
  if (path.startsWith("\0")) return null;
  const at = path.lastIndexOf("/node_modules/");
  if (at === -1) return null;
  const rest = path.slice(at + "/node_modules/".length).split("/");
  const name = rest[0]?.startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
  if (!name) return null;
  return { name, dir: `${path.slice(0, at)}/node_modules/${name}` };
}

/** A package.json `license` (or old `licenses`) as an SPDX expression, or null. */
export function declaredLicense(pkg) {
  const value = pkg.license ?? pkg.licenses;
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) {
    const types = value.map((item) => (typeof item === "string" ? item : item?.type)).filter(Boolean);
    return types.length ? (types.length > 1 ? `(${types.join(" OR ")})` : types[0]) : null;
  }
  if (value && typeof value === "object" && typeof value.type === "string") return value.type;
  return null;
}

/** Recognise a standard licence from its text (for packages that don't declare one). */
export function licenseFromText(text) {
  const t = text.replace(/\s+/g, " ");
  if (/Permission is hereby granted, free of charge, to any person obtaining a copy/i.test(t)) return "MIT";
  if (/Permission to use, copy, modify, and\/or distribute this software for any purpose with or without fee is hereby granted, provided that/i.test(t)) return "ISC";
  if (/Permission to use, copy, modify, and\/or distribute this software for any purpose with or without fee is hereby granted\./i.test(t)) return "0BSD";
  if (/Apache License,? Version 2\.0/i.test(t)) return "Apache-2.0";
  if (/Neither the name of/i.test(t) && /Redistribution and use in source and binary forms/i.test(t)) return "BSD-3-Clause";
  if (/Redistribution and use in source and binary forms/i.test(t)) return "BSD-2-Clause";
  if (/SIL OPEN FONT LICENSE Version 1\.1/i.test(t)) return "OFL-1.1";
  return null;
}

/** The ids in an expression: `(MPL-2.0 OR Apache-2.0)` → MPL-2.0, Apache-2.0. */
export function licenseIds(expression) {
  return String(expression).replace(/[()]/g, " ").split(/\s+(?:OR|AND|WITH)\s+|\s+/).filter((id) => id && !/^(OR|AND|WITH)$/.test(id));
}

/**
 * Whether an SPDX expression may ship: some `OR` alternative whose `AND`
 * parts are all allowed. (No nesting deeper than `(A OR B) AND C` occurs in
 * practice; parentheses are flattened, which errs on the strict side for AND.)
 */
export function isAllowed(expression, allowed = ALLOWED) {
  if (!expression) return false;
  const flat = String(expression).replace(/[()]/g, " ").trim();
  return flat.split(/\s+OR\s+/).some((alternative) => alternative.split(/\s+AND\s+/).every((id) => allowed.has(id.trim())));
}

const LICENSE_FILE = /^(licen[cs]e|copying|notice)([.-].*)?$/i;

/** The licence-ish files of a package directory. */
export function licenseFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => LICENSE_FILE.test(name))
    .sort()
    .map((name) => join(dir, name));
}

/** Copyright lines from licence texts (deduplicated, at most `max`). */
export function copyrightLines(texts, max = 4) {
  const out = [];
  for (const text of texts) {
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim().replace(/\s+/g, " ");
      // "Copyright …", or "(c)"/"©" followed by a year. Not a licence's own
      // lettered clauses ("(c) You must retain…").
      const isCopyright = /^(?:portions\s+)?copyright\b/i.test(line) || /^(?:\(c\)|©)\s*\d{4}/i.test(line);
      if (!isCopyright) continue;
      if (!/(\d{4}|\(c\)|©)/i.test(line)) continue;
      if (/copyright (notice|holder|owner)s?\b/i.test(line) && !/\d{4}/.test(line)) continue;
      if (!out.includes(line)) out.push(line);
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** `author` from package.json, as text. */
export function authorOf(pkg) {
  const author = pkg.author;
  if (typeof author === "string") return author.replace(/\s*<[^>]*>/, "").replace(/\s*\([^)]*\)/, "").trim();
  if (author && typeof author.name === "string") return author.name.trim();
  return "";
}

/** The package's source repository as a browsable URL, or "". */
export function repositoryUrl(pkg) {
  const repo = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  if (typeof repo !== "string" || !repo) return typeof pkg.homepage === "string" ? pkg.homepage : "";
  return repo
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^github:/, "https://github.com/")
    .replace(/^ssh:\/\/git@github\.com\//, "https://github.com/")
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/\.git$/, "")
    .replace(/^([\w.-]+\/[\w.-]+)$/, "https://github.com/$1");
}

const cell = (text) => String(text).replace(/\|/g, "\\|").replace(/\s*\n\s*/g, "<br>");

/**
 * The file. `packages`: [{ name, version, license, copyright: string[], usedBy: string[], note? }];
 * `texts`: [{ id, title, text }] (standard texts, once each); `ownTexts`: [{ name, version, text }]
 * for packages whose licence has no standard text here.
 */
export function renderNotices({ packages, texts, ownTexts, intro }) {
  const lines = [];
  lines.push("# Third-party notices", "");
  lines.push(...intro, "");
  lines.push(`${packages.length} components.`, "");
  lines.push("| Component | Version | Licence | Used in | Copyright |", "|---|---|---|---|---|");
  for (const item of packages) {
    const copyright = item.copyright.length ? item.copyright.join("\n") : "—";
    const note = item.note ? `<br>${item.note}` : "";
    lines.push(`| ${cell(item.name)} | ${cell(item.version)} | ${cell(item.license)} | ${cell(item.usedBy.join(", "))} | ${cell(copyright)}${cell(note)} |`);
  }
  lines.push("", "## Licence texts", "");
  lines.push("Each component's copyright notice is listed in the table above; its licence text, below, applies together with that notice.", "");
  for (const text of texts) {
    lines.push(`### ${text.title}`, "", "```text", text.text.replace(/\s+$/, ""), "```", "");
  }
  for (const own of ownTexts) {
    lines.push(`### ${own.name} ${own.version}`, "", "```text", own.text.replace(/\s+$/, ""), "```", "");
  }
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

/** Packages whose licence isn't allowed and isn't in the approved exceptions. */
export function disallowed(packages, exceptions = {}) {
  return packages.filter((item) => !isAllowed(item.license) && !exceptions[`${item.name}@${item.version}`] && !exceptions[item.name]);
}

/** Read a JSON file, or `fallback`. */
export function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}
