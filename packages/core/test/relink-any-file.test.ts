import { describe, expect, it } from "vitest";
import { relinkAttachments } from "../src/attachment-paths";

/**
 * #sj5a2trb: when a note moves deeper or shallower, D23 re-pointed only its links into `attachments/`;
 * a relative link to any other vault file (`![c](../Other/c.png)`) kept its old `../` count and broke.
 * Now every note-relative link to an EXISTING file is re-pointed from the note's new folder, keeping its
 * `<…>`, suffix and title. Vault-root paths (they don't depend on the note) and links to missing files
 * stay as written.
 */
const files = new Set(["Other/c.png", "Other/my c.png", "Other/Page.md", "Other/Фото.png", "A/B/c.png", "attachments/a.png"]);
const exists = (path: string) => files.has(path);

describe("relinkAttachments: any existing vault file (#sj5a2trb)", () => {
  it("one level deeper: ../ grows for images, links, <…> with a suffix, and a .md page", () => {
    const text = '![c](../Other/c.png) [doc](../Other/c.png "T") ![s](<../Other/my c.png#x>) [p](../Other/Page.md) ![a](../attachments/a.png)\n';
    expect(relinkAttachments(text, "Files/In", "Archive/Files/In", exists)).toBe(
      '![c](../../Other/c.png) [doc](../../Other/c.png "T") ![s](<../../Other/my c.png#x>) [p](../../Other/Page.md) ![a](../../attachments/a.png)\n',
    );
  });

  it("back out to the root: ../ shrinks", () => {
    expect(relinkAttachments("![c](../../Other/c.png)\n", "Deep/Er/P", "P", exists)).toBe("![c](Other/c.png)\n");
  });

  it("keeps the raw tail as written: an encoded name stays encoded, and ./ stays when the path doesn't climb (D37, review)", () => {
    const encoded = "%D0%A4%D0%BE%D1%82%D0%BE.png";
    expect(relinkAttachments(`![f](../Other/${encoded})\n`, "Files/In", "Archive/Files/In", exists)).toBe(`![f](../../Other/${encoded})\n`);
    expect(relinkAttachments("![c](./c.png)\n", "A/B/x", "A/x", exists)).toBe("![c](./B/c.png)\n");
  });

  it("leaves vault-root paths, missing files, external links and code alone", () => {
    const text = "![r](Other/c.png) ![g](../Gone/x.png) [w](https://example.com/c.png) `![c](../Other/c.png)`\n";
    expect(relinkAttachments(text, "Files/In", "Archive/Files/In", exists)).toBe(text);
  });
});
