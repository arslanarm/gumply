import { describe, expect, it } from "vitest";
import { relinkFolderFiles } from "../src/attachment-paths";

/**
 * #x8awsxev: a folder move rewrote `[[Files/…]]` (#baxuimsi) but not Markdown links to files in it
 * (`![pic](Files/a.png)`, `[doc](Files/doc.pdf)`), D23's forms. Each link keeps its own style; every
 * other byte stays as written (D37).
 */
describe("relinkFolderFiles: Markdown links into a moved folder (#x8awsxev)", () => {
  it("from a note at the root: vault paths, a title, %20 and <…> forms", () => {
    const text = '![pic](Files/a.png "A title") [doc](Files/doc%20one.pdf) ![sp](<Files/my pic.png>) ![h](Files/a.png#x)\n';
    const out = relinkFolderFiles(text, "Out", "Out", "Files", "Media");
    expect(out.content).toBe('![pic](Media/a.png "A title") [doc](Media/doc%20one.pdf) ![sp](<Media/my pic.png>) ![h](Media/a.png#x)\n');
    expect(out.count).toBe(4);
  });

  it("from a nested note: note-relative and /absolute stay in their own form", () => {
    const text = "![r](../Files/a.png) ![abs](/Files/a.png)\n";
    const out = relinkFolderFiles(text, "Sub/Deep", "Sub/Deep", "Files", "Archive/Files");
    expect(out.content).toBe("![r](../Archive/Files/a.png) ![abs](/Archive/Files/a.png)\n");
  });

  it("a note inside the folder: its relative links into the folder stay valid, so unchanged", () => {
    const text = "![i](a.png) [d](Sub/doc.pdf)\n";
    const out = relinkFolderFiles(text, "Files/In", "Media/In", "Files", "Media");
    expect(out.content).toBe(text);
    expect(out.count).toBe(0);
  });

  it("leaves a look-alike folder, other folders, external links and code alone", () => {
    const text = "![k](FilesOld/a.png) ![o](Other/Files/a.png) [w](https://example.com/Files/a.png) `![c](Files/a.png)`\n\n```\n![c](Files/a.png)\n```\n";
    const out = relinkFolderFiles(text, "Out", "Out", "Files", "Media");
    expect(out.content).toBe(text);
    expect(out.count).toBe(0);
  });

  it("a moved SUBfolder rewrites only links under it", () => {
    const out = relinkFolderFiles("![a](Files/a.png) ![b](Files/Sub/b.png) ![c](Files/Subway/c.png)\n", "Out", "Out", "Files/Sub", "Archive/Sub");
    expect(out.content).toBe("![a](Files/a.png) ![b](Archive/Sub/b.png) ![c](Files/Subway/c.png)\n");
  });
});
