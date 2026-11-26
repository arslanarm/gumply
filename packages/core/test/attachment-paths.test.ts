import { describe, expect, it } from "vitest";
import {
  attachmentHref,
  looksLikeAttachmentHref,
  markdownPageLinks,
  relinkPageFile,
  relinkAttachments,
  resolveAttachmentHref,
} from "../src/attachment-paths.js";
import { parseEmbeds } from "../src/embeds.js";

describe("attachmentHref (D23 write)", () => {
  it("is relative to the note's folder", () => {
    expect(attachmentHref("Welcome", "attachments/pic.png")).toBe("attachments/pic.png");
    expect(attachmentHref("Projects/Plan", "attachments/pic.png")).toBe("../attachments/pic.png");
    expect(attachmentHref("A/B/C", "attachments/pic.png")).toBe("../../attachments/pic.png");
    expect(attachmentHref("attachments-notes/x", "attachments/p.png")).toBe("../attachments/p.png");
  });

  it("percent-encodes what a link destination can't hold", () => {
    expect(attachmentHref("Q1 plan/Notes", "attachments/my photo (1).png")).toBe(
      "../attachments/my%20photo%20%281%29.png",
    );
    expect(attachmentHref("N", "attachments/100%.pdf")).toBe("attachments/100%25.pdf");
    expect(attachmentHref("N", "attachments/café.png")).toBe("attachments/café.png");
  });
});

describe("resolveAttachmentHref (D23 read)", () => {
  it("accepts note-relative, vault-root and encoded links", () => {
    expect(resolveAttachmentHref("Projects/Plan", "../attachments/pic.png")).toBe("attachments/pic.png");
    expect(resolveAttachmentHref("Projects/Plan", "attachments/pic.png")).toBe("attachments/pic.png");
    expect(resolveAttachmentHref("Welcome", "attachments/my%20photo.png")).toBe("attachments/my photo.png");
    expect(resolveAttachmentHref("A/B", "./img.png")).toBe("A/img.png");
    expect(resolveAttachmentHref("A/B", "/attachments/x.png")).toBe("attachments/x.png");
    expect(resolveAttachmentHref("A/B", "<../attachments/a b.png>")).toBe("attachments/a b.png");
  });

  it("uses `exists` for the nested `attachments/…` case", () => {
    const files = new Set(["Projects/attachments/local.png", "attachments/root.png"]);
    const exists = (path: string) => files.has(path);
    expect(resolveAttachmentHref("Projects/Plan", "attachments/local.png", exists)).toBe(
      "Projects/attachments/local.png",
    );
    expect(resolveAttachmentHref("Projects/Plan", "attachments/root.png", exists)).toBe("attachments/root.png");
  });

  it("rejects external links and paths outside the vault", () => {
    expect(resolveAttachmentHref("A", "https://x.y/p.png")).toBeNull();
    expect(resolveAttachmentHref("A", "//cdn.x/p.png")).toBeNull();
    expect(resolveAttachmentHref("A", "../../etc/passwd")).toBeNull();
  });

  it("recognises attachment hrefs in any accepted form", () => {
    expect(looksLikeAttachmentHref("attachments/x.pdf")).toBe(true);
    expect(looksLikeAttachmentHref("../../attachments/x.pdf")).toBe(true);
    expect(looksLikeAttachmentHref("./attachments/x.pdf")).toBe(true);
    expect(looksLikeAttachmentHref("docs/x.pdf")).toBe(false);
  });

  it("parseEmbeds finds note-relative file links", () => {
    expect(parseEmbeds("[brief.pdf](../attachments/brief.pdf)").map((e) => e.path)).toEqual([
      "../attachments/brief.pdf",
    ]);
  });
});

describe("relinkAttachments (D23 move)", () => {
  const body = [
    "![pic](attachments/pic.png) and [brief.pdf](attachments/brief%20v2.pdf \"Brief\")",
    "![[obsidian.png]] [site](https://x.y/a.png) [[Page]] [doc](docs/readme.md)",
    "`![code](attachments/pic.png)`",
  ].join("\n\n");

  it("rewrites only attachment links when the folder changes", () => {
    expect(relinkAttachments(body, "Welcome", "Projects/Welcome")).toBe(
      [
        "![pic](../attachments/pic.png) and [brief.pdf](../attachments/brief%20v2.pdf \"Brief\")",
        "![[obsidian.png]] [site](https://x.y/a.png) [[Page]] [doc](docs/readme.md)",
        "`![code](attachments/pic.png)`",
      ].join("\n\n"),
    );
  });

  it("moves back up, and is a no-op within the same folder", () => {
    const nested = "![p](../../attachments/p.png)";
    expect(relinkAttachments(nested, "A/B/Note", "Note")).toBe("![p](attachments/p.png)");
    expect(relinkAttachments(nested, "A/B/Note", "A/B/Renamed")).toBe(nested);
  });
});

describe("relinkAttachments keepValidAtDestination", () => {
  const files = new Set(["attachments/pic.png", "attachments/doc.pdf"]);
  const exists = (path: string) => files.has(path);

  it("keeps links that already resolve from the new folder", () => {
    // Moved from the root into Projects/ by another tool, which fixed one link.
    const md = "![a](../attachments/pic.png) [b](attachments/doc.pdf)";
    expect(
      relinkAttachments(md, "Note", "Projects/Note", exists, { keepValidAtDestination: true }),
    ).toBe("![a](../attachments/pic.png) [b](../attachments/doc.pdf)");
  });

  it("without the option rewrites from the old location as before", () => {
    const md = "![a](attachments/pic.png)";
    expect(relinkAttachments(md, "Note", "Projects/Note", exists)).toBe(
      "![a](../attachments/pic.png)",
    );
  });
});

describe("names with # or ? round-trip (#btgun63k)", () => {
  it("a link written for `a#b.png` or `why?.png` resolves back to the same file", () => {
    for (const path of ["Files/a#b.png", "Files/why?.png", "Files/my file [1].png", "Files/pipe|x.png"]) {
      const href = attachmentHref("Notes/Day", path);
      expect(resolveAttachmentHref("Notes/Day", href), href).toBe(path);
    }
    expect(attachmentHref("Notes/Day", "Files/a#b.png")).toBe("../Files/a%23b.png");
    // #eg65ktng: `|` is encoded, so the link is safe inside a table cell.
    expect(attachmentHref("Notes/Day", "Files/pipe|x.png")).toBe("../Files/pipe%7Cx.png");
  });
});

describe("markdownPageLinks (#idmfvvkg: Markdown links to pages, Obsidian parity)", () => {
  const pages = new Set(["Home", "Projects", "Projects/Plan", "Projects/Q1 notes", "Archive/Old plan", "Plan"]);
  const isPage = (id: string) => pages.has(id);

  it("resolves note-relative first, then from the vault root (D23)", () => {
    // From Projects/Plan's folder ("Projects"): `Q1 notes.md` is next to it.
    expect(markdownPageLinks("Projects/Plan", "[q](Q1%20notes.md)", isPage)).toEqual(["Projects/Q1 notes"]);
    // `Plan.md` next to Projects/Q1 notes is Projects/Plan, not the root Plan.
    expect(markdownPageLinks("Projects/Q1 notes", "[p](Plan.md)", isPage)).toEqual(["Projects/Plan"]);
    // Not next to the note: from the vault root.
    expect(markdownPageLinks("Projects/Plan", "[h](Home.md)", isPage)).toEqual(["Home"]);
    expect(markdownPageLinks("Home", "[o](Archive/Old%20plan.md)", isPage)).toEqual(["Archive/Old plan"]);
  });

  it("reads every href form: ./, ../, <…>, %-escapes, a #heading or ?query, an image-style link, a title", () => {
    const body = [
      "[a](./Q1%20notes.md)",
      "[b](../Archive/Old%20plan.md#Goals)",
      "[c](<Q1 notes.md>)",
      "![d](../Home.md)",
      '[e](../Plan.md?x=1 "A title")',
    ].join("\n");
    expect(markdownPageLinks("Projects/Plan", body, isPage)).toEqual(["Projects/Q1 notes", "Archive/Old plan", "Projects/Q1 notes", "Home", "Plan"]);
  });

  it("skips URLs, attachments, missing pages, other files, code, and paths out of the vault", () => {
    const body = [
      "[w](https://example.com/Home.md)",
      "[m](mailto:someone@example.com)",
      "![i](attachments/pic.png)",
      "[gone](Missing.md)",
      "[pdf](Projects.pdf)",
      "`[c](Home.md)`",
      "```\n[f](Home.md)\n```",
      "[out](../../Home.md)",
      "[[Home]]",
    ].join("\n");
    expect(markdownPageLinks("Projects/Plan", body, isPage)).toEqual([]);
  });
});

describe("relinkPageFile (#idmfvvkg: a page rename or move rewrites Markdown links to it, each in its own form)", () => {
  const pages = new Set(["Home", "Projects/Q1 notes", "Archive/Old", "Plan"]);
  // The renamed page's old file is gone by now; the rewrite still recognises links to it.
  const isPage = (id: string) => pages.has(id);

  it("a rename in place swaps only the file name, keeping ./, ../, <…>, %20, the suffix and a title", () => {
    const from = "Projects/Plan.md";
    const to = "Projects/Road map.md";
    const body = [
      "[a](Plan.md)",
      "[b](./Plan.md#Goals)",
      "[c](<Plan.md>)",
      '[d](Plan.md "The plan")',
      "![e](Plan.md)",
      "[other](Q1%20notes.md)",
    ].join("\n");
    const out = relinkPageFile(body, "Projects/Q1 notes", from, to, isPage);
    expect(out.content).toBe(
      ["[a](Road%20map.md)", "[b](./Road%20map.md#Goals)", "[c](<Road map.md>)", '[d](Road%20map.md "The plan")', "![e](Road%20map.md)", "[other](Q1%20notes.md)"].join("\n"),
    );
    expect(out.count).toBe(5);
    expect(relinkPageFile("[x](../Projects/Plan.md)", "Archive/Old", from, to, isPage).content).toBe("[x](../Projects/Road%20map.md)");
    // Vault-root form from a nested note stays vault-root; absolute stays absolute.
    expect(relinkPageFile("[x](Projects/Plan.md)", "Archive/Old", from, to, isPage).content).toBe("[x](Projects/Road%20map.md)");
    expect(relinkPageFile("[x](/Projects/Plan.md)", "Archive/Old", from, to, isPage).content).toBe("[x](/Projects/Road%20map.md)");
  });

  it("a move rebuilds the path in the link's own form", () => {
    const from = "Projects/Plan.md";
    const to = "Archive/Plan.md";
    expect(relinkPageFile("[r](Plan.md#Goals)", "Projects/Q1 notes", from, to, isPage).content).toBe("[r](../Archive/Plan.md#Goals)");
    expect(relinkPageFile("[v](Projects/Plan.md)", "Home", from, to, isPage).content).toBe("[v](Archive/Plan.md)");
    expect(relinkPageFile("[a](/Projects/Plan.md)", "Home", from, to, isPage).content).toBe("[a](/Archive/Plan.md)");
  });

  it("leaves everything else byte for byte: other pages, a same-named root page, URLs, code, an escaped \\[", () => {
    const from = "Projects/Plan.md";
    const to = "Projects/Roadmap.md";
    const body = [
      "[root](../Plan.md)",
      "[web](https://example.com/Projects/Plan.md)",
      "`[c](Plan.md)`",
      "\\[not a link](Plan.md)",
      "[[Plan]]",
      "Plan.md in prose",
    ].join("\n");
    const out = relinkPageFile(body, "Projects/Q1 notes", from, to, isPage);
    expect(out).toEqual({ content: body, count: 0 });
  });
});

describe("MARKDOWN_LINK skips an escaped \\[ (#idmfvvkg, @polish-dev's note 2)", () => {
  it("markdownPageLinks ignores \\[x](Note.md), and relinkAttachments keeps its bytes", () => {
    expect(markdownPageLinks("Home", "\\[x](Home.md) and [y](Home.md)", () => true)).toEqual(["Home"]);
    // A note-relative link follows its note (#sj5a2trb); the escaped one is text and keeps its bytes.
    const body = "\\[a](pic.png) ![b](pic.png)";
    expect(relinkAttachments(body, "Home", "Notes/Day", (path) => path === "pic.png")).toBe("\\[a](pic.png) ![b](../pic.png)");
  });
});
