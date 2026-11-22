import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error -- plain .mjs helper without types
import * as lib from "./notices-lib.mjs";

/** #mbim529b: the pure parts of THIRD_PARTY_NOTICES generation. */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("packageOf", () => {
  it("maps bundled files to their package, scoped and nested", () => {
    expect(lib.packageOf("/r/node_modules/react/index.js")).toEqual({ name: "react", dir: "/r/node_modules/react" });
    expect(lib.packageOf("/r/node_modules/@tiptap/core/dist/index.js")?.name).toBe("@tiptap/core");
    expect(lib.packageOf("/r/node_modules/mermaid/node_modules/katex/dist/katex.mjs")).toEqual({
      name: "katex",
      dir: "/r/node_modules/mermaid/node_modules/katex",
    });
    expect(lib.packageOf("C:\\r\\node_modules\\hono\\dist\\index.js")?.name).toBe("hono");
    expect(lib.packageOf("/r/node_modules/katex/dist/katex.min.css?inline")?.name).toBe("katex");
  });

  it("ignores Gumply's own sources and virtual modules", () => {
    expect(lib.packageOf("/r/apps/web/src/App.tsx")).toBeNull();
    expect(lib.packageOf("\0vite/preload-helper.js")).toBeNull();
  });
});

describe("licences", () => {
  it("reads declared licences in every package.json shape", () => {
    expect(lib.declaredLicense({ license: "MIT" })).toBe("MIT");
    expect(lib.declaredLicense({ license: { type: "ISC" } })).toBe("ISC");
    expect(lib.declaredLicense({ licenses: [{ type: "MIT" }, { type: "Apache-2.0" }] })).toBe("(MIT OR Apache-2.0)");
    expect(lib.declaredLicense({})).toBeNull();
  });

  it("recognises standard texts when nothing is declared", () => {
    expect(lib.licenseFromText("The MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy")).toBe("MIT");
    expect(lib.licenseFromText("Redistribution and use in source and binary forms ... Neither the name of")).toBe("BSD-3-Clause");
    expect(lib.licenseFromText("Apache License\nVersion 2.0, January 2004\nApache License, Version 2.0")).toBe("Apache-2.0");
    expect(lib.licenseFromText("Some custom terms")).toBeNull();
  });

  it("allows the listed licences, and an OR when one option is allowed", () => {
    for (const ok of ["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "0BSD", "OFL-1.1", "(MPL-2.0 OR Apache-2.0)", "MIT OR GPL-3.0"]) {
      expect(lib.isAllowed(ok), ok).toBe(true);
    }
    for (const no of ["MPL-2.0", "GPL-3.0", "EPL-2.0 OR GPL-3.0-or-later", "LGPL-2.1", "UNKNOWN", "", null, "MIT AND GPL-2.0", "CC-BY-4.0"]) {
      expect(lib.isAllowed(no), String(no)).toBe(false);
    }
    expect(lib.licenseIds("(MPL-2.0 OR Apache-2.0)")).toEqual(["MPL-2.0", "Apache-2.0"]);
  });

  it("disallowed lists what needs an OK, minus approved exceptions", () => {
    const packages = [
      { name: "a", version: "1.0.0", license: "MIT" },
      { name: "b", version: "2.0.0", license: "LGPL-3.0" },
      { name: "c", version: "3.0.0", license: "UNKNOWN" },
    ];
    expect(lib.disallowed(packages).map((item: { name: string }) => item.name)).toEqual(["b", "c"]);
    expect(lib.disallowed(packages, { "b@2.0.0": { reason: "approved" } }).map((item: { name: string }) => item.name)).toEqual(["c"]);
  });
});

describe("copyright lines", () => {
  it("takes real notices, not licence clauses", () => {
    const text = [
      "Copyright (c) 2013-2020 Khan Academy and other contributors",
      "(c) You must retain, in the Source form of any Derivative Works",
      "the above copyright notice and this permission notice",
      "© 2021 Someone",
      "Portions Copyright 2017 Google Inc.",
    ].join("\n");
    expect(lib.copyrightLines([text])).toEqual([
      "Copyright (c) 2013-2020 Khan Academy and other contributors",
      "© 2021 Someone",
      "Portions Copyright 2017 Google Inc.",
    ]);
  });

  it("finds licence files and falls back to the repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "notices-"));
    dirs.push(dir);
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "LICENSE.md"), "x");
    writeFileSync(join(dir, "NOTICE"), "y");
    writeFileSync(join(dir, "index.js"), "z");
    expect(lib.licenseFiles(dir).map((path: string) => path.slice(dir.length + 1))).toEqual(["LICENSE.md", "NOTICE"]);
    expect(lib.repositoryUrl({ repository: { url: "git+https://github.com/ueberdosis/tiptap.git" } })).toBe("https://github.com/ueberdosis/tiptap");
    expect(lib.repositoryUrl({ repository: "markdown-it/uc.micro" })).toBe("https://github.com/markdown-it/uc.micro");
    expect(lib.authorOf({ author: "Ann <ann@example.invalid> (https://x.invalid)" })).toBe("Ann");
  });
});

describe("renderNotices", () => {
  it("a table, then each licence text once; cells escaped; deterministic", () => {
    const input = {
      intro: ["Intro."],
      packages: [{ name: "a|b", version: "1.0.0", license: "MIT", usedBy: ["web"], copyright: ["Copyright 2020 A", "Copyright 2021 B"] }],
      texts: [{ id: "MIT", title: "MIT License", text: "Permission is hereby granted…\n\n" }],
      ownTexts: [],
    };
    const markdown = lib.renderNotices(input);
    expect(markdown).toContain("| a\\|b | 1.0.0 | MIT | web | Copyright 2020 A<br>Copyright 2021 B |");
    expect(markdown).toContain("### MIT License\n\n```text\nPermission is hereby granted…\n```");
    expect(markdown.endsWith("```\n")).toBe(true);
    expect(lib.renderNotices(input)).toBe(markdown);
  });
});
