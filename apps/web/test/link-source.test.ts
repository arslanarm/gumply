import MarkdownIt from "markdown-it";
import { describe, expect, it } from "vitest";
import { isAllowedLinkUri, isVaultHref, vaultLinkTarget } from "../src/editor/link.js";
import { LINK_SOURCE_ATTR, rawMarkdownPlugin } from "../src/editor/raw-markdown/markdown-plugin.js";
import { markdownFileLinkPath, wikilinkMarkdownPlugin } from "../src/editor/wikilink/markdown-plugin.js";

/** #he3ed9uz (D37): Markdown links to vault files keep their exact source. */

const md = new MarkdownIt({ html: false });
rawMarkdownPlugin(md);
wikilinkMarkdownPlugin(md);

const decode = (value: string) =>
  value.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** The recorded source of each link in rendered HTML. */
const sources = (markdown: string) =>
  [...md.render(markdown).matchAll(new RegExp(`${LINK_SOURCE_ATTR}="([^"]*)"`, "g"))].map((m) => JSON.parse(decode(m[1]!)));

describe("link sources (#he3ed9uz)", () => {
  it("records href, title, label and the tail as written", () => {
    expect(sources('[doc](Files/report.pdf "The report")')).toEqual([
      { href: "Files/report.pdf", title: "The report", label: "doc", tail: '(Files/report.pdf "The report")' },
    ]);
    expect(sources("[spaced](<Files/a b.docx>)")[0]).toMatchObject({ href: "Files/a%20b.docx", tail: "(<Files/a b.docx>)" });
    expect(sources("[**bold** label](Files/notes%20%232.pdf)")[0]).toMatchObject({
      label: "**bold** label",
      tail: "(Files/notes%20%232.pdf)",
    });
  });

  it("reference links record their reference form; the definition stays as a raw block", () => {
    const text = "Ref [doc][r1], [r1][] and [r1].\n\n[r1]: Files/report.pdf\n";
    expect(sources(text).map((source) => source.tail)).toEqual(["[r1]", "[]", ""]);
    expect(md.render(text)).toContain('data-raw-md="[r1]: Files/report.pdf" data-raw-kind="reference"');
    // Inside a quote: the source without the quote markers (the writer adds them).
    expect(md.render('> [q]: Files/a.pdf "T"\n\n[x][q]')).toContain('data-raw-md="[q]: Files/a.pdf &quot;T&quot;"');
  });

  it("an href the link mark refuses stays raw source, not text (`//host`, unknown schemes, empty)", () => {
    for (const source of ["[proto](//evil.example/x)", "[o](obsidian://open?vault=x)", "[none]()"]) {
      const html = md.render(`A ${source} b`);
      expect(html).toContain(`data-raw-md-inline="${source.replace(/&/g, "&amp;")}" data-raw-kind="inert"`);
      expect(html).not.toContain("<a ");
    }
  });

  it("an empty label is an inert raw atom (there is no text to carry the link)", () => {
    expect(md.render("A [](Files/report.pdf) b")).toContain('data-raw-md-inline="[](Files/report.pdf)" data-raw-kind="inert"');
  });

  it("an attachments/ link keeps its label source on the file card", () => {
    expect(md.render("Attach [att](attachments/a.pdf) link.")).toContain('data-md-source="[att](attachments/a.pdf)"');
    expect(markdownFileLinkPath("[att](../attachments/a.pdf)")).toBe("../attachments/a.pdf");
    expect(markdownFileLinkPath("[att](attachments/a.pdf) and more")).toBeNull();
  });
});

describe("relative link URIs (#he3ed9uz)", () => {
  // TipTap 2.27's default check, verbatim (its `\-` collapses in the template literal).
  const tiptapDefault = (url: string) =>
    !url ||
    new RegExp(`^(?:(?:http|https|ftp|ftps|mailto|tel|callto|sms|cid|xmpp):|[^a-z]|[a-z0-9+.\-]+(?:[^a-z+.\-:]|$))`, "i").test(
      url.replace(/[\u0000-\u0020\u00A0\u1680\u180E\u2000-\u2029\u205F\u3000]/g, ""),
    );

  it("TipTap's own check refuses folder paths (the bug)", () => {
    expect(tiptapDefault("Files/report.pdf")).toBe(false);
    expect(tiptapDefault("../Files/report.pdf")).toBe(true);
  });

  it("accepts relative vault paths with folders", () => {
    for (const url of ["Files/report.pdf", "FILES/REPORT.PDF", "Folder/Page.md", "Files/notes%20%232.pdf", "a/b#page=2"]) {
      expect(isAllowedLinkUri(url, tiptapDefault)).toBe(true);
    }
  });

  it("still refuses scripts and unknown schemes, also with whitespace tricks", () => {
    for (const url of ["javascript:alert(1)", "JaVaScRiPt:x", "java\nscript:x", " vbscript:x", "data:text/html,x"]) {
      expect(isAllowedLinkUri(url, tiptapDefault)).toBe(false);
    }
  });
});

describe("vault links stay in the vault (#he3ed9uz review)", () => {
  const tiptapDefault = (url: string) =>
    !url ||
    new RegExp(`^(?:(?:http|https|ftp|ftps|mailto|tel|callto|sms|cid|xmpp):|[^a-z]|[a-z0-9+.\\-]+(?:[^a-z+.\\-:]|$))`, "i").test(
      url.replace(/[\u0000-\u0020\u00A0\u1680\u180E\u2000-\u2029\u205F\u3000]/g, ""),
    );
  const APP = "http://127.0.0.1:5000/#/Notes/Here";
  const hrefs = (markdown: string) => [...md.render(markdown).matchAll(/<a href="([^"]*)"/g)].map((m) => decode(m[1]!));

  it("protocol-relative hrefs (`//host`, `/\\host`, `\\\\host`) never become live links", () => {
    for (const url of ["//evil.example/x", " //evil.example/x", "/\\evil.example/x", "\\\\evil.example/x", "\t//evil.example"]) {
      expect(isAllowedLinkUri(url, tiptapDefault)).toBe(false);
      expect(isVaultHref(url)).toBe(false);
    }
  });

  it("obfuscated schemes are refused, or end up as a harmless same-origin path", () => {
    const sources = [
      "[a](java&#x09;script:alert(1))",
      "[a](java&#9;script:alert(1))",
      "[a](JaVaScRiPt:alert(1))",
      "[a]( javascript:alert(1))",
      "[a](<\u0001javascript:alert(1)>)",
      "[a](data:text/html,x)",
      "[a](vbscript:msgbox)",
      "[a](//evil.example/x)",
      "[a](<//evil.example/x>)",
    ];
    for (const source of sources) {
      for (const href of hrefs(source)) {
        if (!isAllowedLinkUri(href, tiptapDefault)) continue;
        const url = new URL(href, APP);
        expect(`${source} → ${url.protocol}//${url.host}`).toBe(`${source} → http://127.0.0.1:5000`);
      }
    }
    for (const url of ["javascript:alert(1)", "JaVaScRiPt:x", "java\tscript:x", "java\nscript:x", " \u0001javascript:x", "data:text/html,x", "vbscript:x"]) {
      expect(isAllowedLinkUri(url, tiptapDefault)).toBe(false);
    }
  });

  it("a click on Folder/Page.md opens the note in the app; other vault paths open the file", () => {
    const env = { pageId: "Notes/Here", pages: [{ id: "Folder/Page" }, { id: "Notes/Near" }, { id: "Other" }] as never[] };
    expect(vaultLinkTarget("Folder/Page.md", env)).toEqual({ page: "Folder/Page", heading: "" });
    expect(vaultLinkTarget("Folder/Page.md#Big%20Idea", env)).toEqual({ page: "Folder/Page", heading: "Big Idea" });
    expect(vaultLinkTarget("Near.md", env)).toEqual({ page: "Notes/Near", heading: "" });
    expect(vaultLinkTarget("../Other.md", env)).toEqual({ page: "Other", heading: "" });
    expect(vaultLinkTarget("Files/a%20b.pdf", env)).toEqual({ file: "Notes/Files/a b.pdf" });
    expect(vaultLinkTarget("https://example.com/a.md", env)).toBeNull();
    expect(vaultLinkTarget("//evil.example/Page.md", env)).toBeNull();
    expect(vaultLinkTarget("#heading", env)).toBeNull();
  });
});
