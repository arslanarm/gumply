#!/usr/bin/env node
// THIRD_PARTY_NOTICES.md (#mbim529b): every third-party package Gumply
// actually ships, from what the bundlers put into the output (not what
// package.json declares, so dev tools and tree-shaken code never appear):
//
// - web:     the Vite build (every chunk, the lazy KaTeX and Mermaid ones too)
// - desktop: the Electron main bundle (it bundles the server and core)
// - mcp:     the `gumply` bin bundle
//
// Usage:
//   node scripts/notices.mjs           write THIRD_PARTY_NOTICES.md
//   node scripts/notices.mjs --check   fail if it's out of date, or a licence isn't allowed
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import {
  authorOf,
  copyrightLines,
  declaredLicense,
  disallowed,
  licenseFiles,
  licenseFromText,
  licenseIds,
  packageOf,
  readJson,
  renderNotices,
  repositoryUrl,
} from "./notices-lib.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(repo, "THIRD_PARTY_NOTICES.md");
const TEXTS = join(repo, "scripts/licenses");
const EXCEPTIONS = readJson(join(repo, "scripts/notices-allow.json"), {});
const check = process.argv.includes("--check");
const coreAlias = { "@gumply/core": join(repo, "packages/core/src/index.ts") };

/** Bundled files, per product. */
async function bundledFiles() {
  const web = await viteBuild({
    configFile: join(repo, "apps/web/vite.config.ts"),
    root: join(repo, "apps/web"),
    logLevel: "error",
    build: { write: false, emptyOutDir: false, outDir: join(repo, "apps/web/.notices-tmp") },
  });
  const outputs = (Array.isArray(web) ? web : [web]).flatMap((result) => result.output);
  const webFiles = outputs.filter((item) => item.type === "chunk").flatMap((chunk) => chunk.moduleIds);

  const node = (entry, external = []) =>
    esbuild({
      entryPoints: [join(repo, entry)],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      external,
      alias: coreAlias,
      metafile: true,
      write: false,
      logLevel: "error",
      outfile: join(repo, ".notices-tmp.mjs"),
    }).then((result) => Object.keys(result.metafile.inputs).map((input) => join(repo, input)));

  return {
    web: webFiles,
    desktop: await node("apps/desktop/src/main.ts", ["electron"]),
    mcp: await node("apps/mcp/src/cli.ts"),
  };
}

const standardText = (id) => {
  try {
    return readFileSync(join(TEXTS, `${id}.txt`), "utf8");
  } catch {
    return null;
  }
};

const TITLES = {
  MIT: "MIT License",
  ISC: "ISC License",
  "0BSD": "Zero-Clause BSD License (0BSD)",
  "BSD-2-Clause": "BSD 2-Clause License",
  "BSD-3-Clause": "BSD 3-Clause License",
  "Apache-2.0": "Apache License 2.0",
  "MPL-2.0": "Mozilla Public License 2.0",
  "OFL-1.1": "SIL Open Font License 1.1",
};

async function collect() {
  const files = await bundledFiles();
  /** name@version → entry */
  const byKey = new Map();
  for (const [product, list] of Object.entries(files)) {
    for (const file of list) {
      const found = packageOf(file);
      if (!found) continue;
      const pkg = readJson(join(found.dir, "package.json"), null);
      if (!pkg?.version) continue;
      const key = `${found.name}@${pkg.version}`;
      let entry = byKey.get(key);
      if (!entry) {
        const texts = licenseFiles(found.dir).map((path) => readFileSync(path, "utf8"));
        const license = declaredLicense(pkg) ?? texts.map(licenseFromText).find(Boolean) ?? "UNKNOWN";
        const copyright = copyrightLines(texts);
        const author = authorOf(pkg);
        entry = {
          name: found.name,
          version: pkg.version,
          license,
          // No notice in the package: its authors, and where its notice lives.
          copyright: copyright.length
            ? copyright
            : author
              ? [author]
              : [`The ${found.name} authors${repositoryUrl(pkg) ? ` (${repositoryUrl(pkg)})` : ""}`],
          usedBy: new Set(),
          texts,
        };
        byKey.set(key, entry);
      }
      entry.usedBy.add(product);
    }
  }

  // What the bundlers can't see.
  const katex = readJson(join(repo, "node_modules/katex/package.json"), null);
  if (katex) {
    // From the fonts' own `name` table (copyright and licence records).
    byKey.set(`KaTeX fonts@${katex.version}`, {
      name: "KaTeX fonts",
      version: katex.version,
      license: "OFL-1.1",
      copyright: ["Copyright (c) 2009-2010, Design Science, Inc. (<www.mathjax.org>)", "Copyright (c) 2014-2018 Khan Academy (<www.khanacademy.org>)"],
      usedBy: new Set(["web"]),
      note: "Reserved Font Names: KaTeX_AMS, KaTeX_Caligraphic, KaTeX_Fraktur, KaTeX_Main, KaTeX_Math, KaTeX_SansSerif, KaTeX_Script, KaTeX_Size1–4, KaTeX_Typewriter.",
      texts: [],
    });
  }
  const electron = readJson(join(repo, "node_modules/electron/package.json"), null);
  if (electron) {
    byKey.set(`electron@${electron.version}`, {
      name: "electron",
      version: electron.version,
      license: declaredLicense(electron) ?? "MIT",
      copyright: copyrightLines(licenseFiles(join(repo, "node_modules/electron")).map((path) => readFileSync(path, "utf8"))),
      usedBy: new Set(["desktop"]),
      note: "The desktop installers also carry Electron's own LICENSE.electron.txt and LICENSES.chromium.html (Chromium and its components), shipped by electron-builder next to the app.",
      texts: [],
    });
  }

  const packages = [...byKey.values()]
    .map((entry) => ({ ...entry, usedBy: [...entry.usedBy].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version, undefined, { numeric: true }));

  // Each standard licence text once; a component whose licence has no standard
  // text here gets its own text in full.
  const ids = new Set();
  const ownTexts = [];
  for (const item of packages) {
    const known = licenseIds(item.license).filter((id) => standardText(id));
    for (const id of known) ids.add(id);
    if (known.length === 0 && item.texts.length) ownTexts.push({ name: item.name, version: item.version, text: item.texts.join("\n\n") });
  }
  const texts = [...ids].sort().map((id) => ({ id, title: TITLES[id] ?? id, text: standardText(id) }));
  return { packages, texts, ownTexts };
}

const { packages, texts, ownTexts } = await collect();
const markdown = renderNotices({
  packages,
  texts,
  ownTexts,
  intro: [
    "Gumply itself is MIT-licensed (see `LICENSE`). It ships the third-party components below: in the web app (**web**), inside the desktop installers (**desktop**: the app's main process, which includes the server), and in the `gumply` command-line MCP server (**mcp**).",
    "",
    "This file is generated by `npm run notices` from what the bundlers actually put into each build, and CI checks that it is up to date (`npm run notices:check`).",
  ],
});

const problems = disallowed(packages, EXCEPTIONS);
const report = (list) => list.map((item) => `  - ${item.name}@${item.version}: ${item.license} (${item.usedBy.join(", ")})`).join("\n");

if (check) {
  let failed = false;
  let current = "";
  try {
    current = readFileSync(OUT, "utf8");
  } catch {
    current = "";
  }
  if (current !== markdown) {
    console.error(`THIRD_PARTY_NOTICES.md is out of date: run \`npm run notices\` and commit it.`);
    failed = true;
  }
  if (problems.length) {
    console.error(`Licences that need @lead's OK (add them to scripts/notices-allow.json with a reason):\n${report(problems)}`);
    failed = true;
  }
  if (failed) process.exit(1);
  console.log(`THIRD_PARTY_NOTICES.md is up to date: ${packages.length} components, all licences allowed.`);
} else {
  writeFileSync(OUT, markdown);
  console.log(`Wrote ${relative(repo, OUT)}: ${packages.length} components, ${texts.length} licence texts.`);
  if (problems.length) {
    console.error(`Licences that need @lead's OK:\n${report(problems)}`);
    process.exitCode = 1;
  }
}
