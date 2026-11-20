import { describe, expect, it } from "vitest";
import {
  attachmentHref,
  looksLikeAttachmentHref,
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
