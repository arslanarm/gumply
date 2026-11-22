import type { BaseViewResult, Page, PageMeta } from "@gumply/core";
import { describe, expect, it } from "vitest";
import { buildPageHtml, exportFileName, MAX_BASE_ROWS, pageRule, siblingHref, unescapeHtml, type ExportSource } from "../src/export/html-export.js";

const meta = (id: string, kind: PageMeta["kind"] = "page"): PageMeta =>
  ({ id, title: id.split("/").pop()!.replace(/\.(canvas|base)$/, ""), kind, parentId: null, updated: "2026-11-22T10:00:00.000Z", created: "2026-11-22T10:00:00.000Z" }) as PageMeta;

const page = (id: string, content: string, extra: Partial<Page> = {}): Page => ({ ...meta(id), content, ...extra }) as Page;

/** A source over an in-memory vault; records every file it was asked for. */
function source(files: Record<string, string>, pages: Page[], extra: Partial<ExportSource> = {}) {
  const asked: string[] = [];
  const all: PageMeta[] = [...pages.map((item) => meta(item.id)), meta("Map.canvas", "whiteboard"), meta("Work/Tasks.base", "base")];
  const value: ExportSource = {
    pages: all,
    loadPage: async (id) => pages.find((item) => item.id === id) ?? null,
    resolveFile: async (link) => Object.keys(files).find((path) => path === link || path.endsWith(`/${link}`)) ?? null,
    loadFile: async (path) => {
      asked.push(path);
      return files[path] ? { mime: "image/png", base64: files[path]! } : null;
    },
    runBase: async () => null,
    formatValue: (value) => (value === null || value === undefined ? "" : String(value)),
    highlight: async (language, code) => (language === "js" ? `<span class="hljs-keyword">${code.slice(0, 5)}</span>${code.slice(5).replace(/</g, "&lt;")}` : null),
    css: "body{}",
    t: (key, vars) => `${key}${vars ? `(${Object.values(vars).join(",")})` : ""}`,
    language: "en",
    ...extra,
  };
  return { value, asked };
}

const options = { theme: "light" as const, links: "text" as const };

describe("HTML export (G1)", () => {
  it("is one document: CSP, no script, the title, the stylesheet, the theme", async () => {
    const root = page("Notes/Plan", "Hello **world**");
    const html = await buildPageHtml(root, source({}, [root]).value, { theme: "dark", links: "text" });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<html lang="en" data-theme="dark">');
    expect(html).toContain(`content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'none'; script-src 'none'`);
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain("<title>Plan</title>");
    expect(html).toContain("<style>body{}</style>");
    expect(html).toContain("<strong>world</strong>");
  });

  it("inlines vault images as data URIs, once each; missing and web images become notes", async () => {
    const root = page("Notes/Plan", "![[pic.png]]\n\n![[pic.png|120]]\n\n![](../att/b.png)\n\n![[gone.png]]\n\n![web](https://example.com/x.png)");
    const { value, asked } = source({ "att/pic.png": "AAAA", "att/b.png": "BBBB" }, [root]);
    const html = await buildPageHtml(root, value, options);
    expect(html).toContain('src="data:image/png;base64,AAAA"');
    expect(html).toContain('width="120"');
    expect(html).toContain('src="data:image/png;base64,BBBB"');
    expect(asked.filter((path) => path === "att/pic.png")).toHaveLength(1);
    expect(html).toContain('export.missingImage(gone.png)');
    expect(html).toContain('export.remoteImage(https://example.com/x.png)');
    expect(html).not.toContain("https://example.com/x.png\"");
    expect(html).not.toMatch(/src="(?!data:)/);
  });

  it("highlights code, keeps math and Mermaid as source, inlines callout icons, opens folded callouts", async () => {
    const root = page("P", "```js\nconst a = 1 < 2;\n```\n\n```mermaid\ngraph TD; A-->B\n```\n\n$E = mc^2$\n\n> [!warning]- Careful\n> Body");
    const html = await buildPageHtml(root, source({}, [root]).value, options);
    expect(html).toContain('<code class="language-js"><span class="hljs-keyword">const</span> a = 1 &lt; 2;');
    // No renderers in this source: math and diagrams keep their source.
    expect(html).toContain("graph TD; A--&gt;B");
    expect(html).toContain("E = mc^2");
    expect(html).toMatch(/<span class="callout-icon" aria-hidden="true"><svg viewBox="0 0 24 24"/);
    expect(html).not.toContain("callout-fold");
    expect(html).not.toContain("is-closed");
    expect(html).toContain("Careful");
  });

  it("math as MathML and diagrams as SVG through the renderers; a failed diagram keeps its source", async () => {
    const root = page("P", "Inline $a^2$ here.\n\n$$\nE = mc^2\n$$\n\n```mermaid\ngraph TD; A-->B\n```\n\n```mermaid\nnot a diagram\n```\n\nIt costs $5 and $10.");
    const themes: string[] = [];
    const html = await buildPageHtml(
      root,
      source({}, [root], {
        math: async (tex, display) => `<math${display ? ' display="block"' : ""}><mi>${tex}</mi></math>`,
        diagram: async (code, theme) => {
          themes.push(theme);
          return code.startsWith("graph") ? { svg: '<svg data-test="diagram"></svg>' } : { error: "Parse error" };
        },
      }).value,
      { theme: "dark", links: "text" },
    );
    expect(html).toContain("<math><mi>a^2</mi></math>");
    expect(html).toContain('<div class="math-block"><math display="block"><mi>E = mc^2</mi></math></div>');
    expect(html).toContain('<div class="export-diagram"><svg data-test="diagram"></svg></div>');
    expect(html).toContain("<pre><code>not a diagram</code></pre>");
    expect(themes).toEqual(["dark", "dark"]);
    // Prices stay text (the editor's own detection).
    expect(html).toContain("It costs $5 and $10.");
    expect(html).not.toContain("data-math");
    expect(html).not.toContain("data-mermaid");

    // Follow the system: both drawings, wrapped for the stylesheet.
    const both = await buildPageHtml(
      page("Q", "```mermaid\ngraph TD; A-->B\n```"),
      source({}, [root], { diagram: async (_code, theme) => ({ svg: `<svg data-theme="${theme}"></svg>` }) }).value,
      { theme: "system", links: "text" },
    );
    expect(both).toContain('<div class="export-diagram"><div class="diagram-light"><svg data-theme="light"></svg></div><div class="diagram-dark"><svg data-theme="dark"></svg></div></div>');
  });

  it("G2 print: light, text links, the light diagram only, and an @page rule for the paper", async () => {
    const other = page("Other", "x");
    const root = page("Plan", "See [[Other]].\n\n```mermaid\ngraph TD; A-->B\n```");
    const themes: string[] = [];
    const html = await buildPageHtml(
      root,
      source({}, [root, other], {
        diagram: async (_code, theme) => {
          themes.push(theme);
          return { svg: `<svg data-theme="${theme}"></svg>` };
        },
      }).value,
      { theme: "system", links: "files", print: { pageSize: "Letter", margins: "narrow" } },
    );
    expect(html).toContain('data-theme="light"');
    expect(html).toContain("@page { size: Letter; margin: 10mm; }");
    expect(html).toContain('<span class="wiki-link">Other</span>');
    expect(html).not.toContain("Other.html");
    expect(themes).toEqual(["light"]);
    expect(pageRule({ pageSize: "A4", margins: "normal" })).toBe("@page { size: A4; margin: 18mm; }");
  });

  it("links: plain text by default, or relative links to sibling .html files", async () => {
    const other = page("Work/Other", "x");
    const root = page("Notes/Plan", "See [[Other|the other]], [[Other#Goals]] and [[Nowhere]]");
    const text = await buildPageHtml(root, source({}, [root, other]).value, options);
    expect(text).toContain('<span class="wiki-link">the other</span>');
    expect(text).toContain('<span class="wiki-link is-unresolved">Nowhere</span>');
    expect(text).not.toContain(".html\"");
    const files = await buildPageHtml(root, source({}, [root, other]).value, { theme: "light", links: "files" });
    expect(files).toContain('<a class="wiki-link" href="Other.html">the other</a>');
    expect(files).toContain('href="Other.html#Goals"');
    expect(files).toContain('<span class="wiki-link is-unresolved">Nowhere</span>');
  });

  it("inlines page previews (with a loop guard), shows boards by name, snapshots database views", async () => {
    const inner = page("Inner", "## Goals\nShip it\n\n## Later\nNot this\n\n![[Plan]]");
    const root = page("Plan", "![[Inner#Goals]]\n\n![[Inner]]\n\n![[Map.canvas]]\n\n![[Work/Tasks.base#Board]]");
    const rows = Array.from({ length: MAX_BASE_ROWS + 3 }, (_, index) => ({ id: `Work/T${index}`, kind: "page", title: `T${index}`, updated: "", values: { "note.done": index === 0, "note.status": "Todo" } }));
    const result = { view: "Board", type: "table", columns: [{ id: "file.name", type: "file", editable: false }, { id: "note.status", type: "text", editable: true }, { id: "note.done", type: "checkbox", editable: true }], rows, total: rows.length, warnings: [] } as unknown as BaseViewResult;
    let askedView: string | undefined;
    const { value } = source({}, [root, inner], {
      runBase: async (_id, view) => {
        askedView = view;
        return { result, label: (id) => id.replace(/^note\./, "") };
      },
    });
    const html = await buildPageHtml(root, value, options);
    expect(html).toContain('<div class="export-embed-title">Inner › Goals</div>');
    expect(html).toContain("Ship it");
    expect(html.indexOf("Not this")).toBeGreaterThan(html.indexOf("Inner</div>"));
    expect(html).toContain('export.loopPage(Plan)');
    expect(html).toContain('<div class="export-board">export.board: Map</div>');
    expect(askedView).toBe("Board");
    expect(html).toContain("<th>status</th>");
    expect(html).toContain('<td class="is-check">☑</td>');
    expect(html.match(/<tr>/g)!.length).toBe(MAX_BASE_ROWS + 1);
    expect(html).toContain('export.moreRows(3)');
  });

  it("colour spans become colours, safely; other HTML in a page stays text", async () => {
    const root = page("P", '<span style="color: var(--color-red);">red</span> and <span style="background-color: rgba(var(--color-blue-rgb), 0.2);">blue</span> and <span style="color: url(x)">bad</span> <img src=x onerror=alert(1)>');
    const html = await buildPageHtml(root, source({}, [root]).value, options);
    expect(html).toContain('<span class="md-color" style="color: var(--color-red)">red</span>');
    expect(html).toContain('<span class="md-bg-color" style="background-color: rgba(var(--color-blue-rgb), 0.2)">blue</span>');
    expect(html).toContain("&lt;span style=&quot;color: url(x)&quot;&gt;bad");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("the page frame: icon, cover image, background tint, properties", async () => {
    const root = page("P", "Body", {
      icon: "🚀",
      fileLinks: {},
      properties: [
        { key: "cover", type: "text", value: "[[cover.png]]", editable: true },
        { key: "background", type: "text", value: "green", editable: true },
        { key: "status", type: "text", value: "Doing", editable: true },
        { key: "done", type: "checkbox", value: true, editable: true },
      ],
    } as Partial<Page>);
    const html = await buildPageHtml(root, source({ "att/cover.png": "CCCC" }, [root]).value, options);
    expect(html).toContain('<div class="export-cover"><img src="data:image/png;base64,CCCC"');
    expect(html).toContain('class="export has-tint" style="--page-tint-rgb: var(--color-green-rgb)"');
    expect(html).toContain('<span class="export-icon">🚀</span>');
    expect(html).toContain("<tr><th>status</th><td>Doing</td></tr>");
    expect(html).toContain("<tr><th>done</th><td>☑</td></tr>");
    expect(html).not.toContain("<th>cover</th>");
  });

  it("helpers: sibling links by downloaded file name, safe file names, unescaping", () => {
    expect(siblingHref("Other")).toBe("Other.html");
    expect(siblingHref("Deep note")).toBe("Deep%20note.html");
    expect(siblingHref("Q1: plan?")).toBe("Q1%20plan.html");
    expect(siblingHref("Café #2")).toBe("Caf%C3%A9%20%232.html");
    expect(exportFileName('Q1: plan / "draft"')).toBe("Q1 plan draft.html");
    expect(exportFileName("")).toBe("Page.html");
    expect(unescapeHtml("&lt;a&gt; &amp;amp; &quot;")).toBe('<a> &amp; "');
  });
});
