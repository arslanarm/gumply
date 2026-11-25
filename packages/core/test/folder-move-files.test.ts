import { describe, expect, it } from "vitest";
import { rewriteWikilinkFolder } from "../src/links";

/**
 * #baxuimsi: a folder move rewrites `[[Folder/…]]` page links (D33), but skipped embeds and links to
 * FILES in it (`![[Files/a.png]]`, `[[Files/doc.pdf]]`): after the move they pointed at the old folder.
 * Every other byte stays as written (D37), the table form's `\|` included.
 */
describe("rewriteWikilinkFolder: files in the moved folder (#baxuimsi)", () => {
  it("rewrites image embeds, file links and their width, alias and subpath forms", () => {
    const text = "![[Files/a.png]] and ![[Files/a.png|300]] and [[Files/doc.pdf]] and [[Files/doc.pdf|My doc]] and ![[files/Sub/b.jpg#x]].\n";
    const out = rewriteWikilinkFolder(text, "Files", "Media");
    expect(out.content).toBe("![[Media/a.png]] and ![[Media/a.png|300]] and [[Media/doc.pdf]] and [[Media/doc.pdf|My doc]] and ![[Media/Sub/b.jpg#x]].\n");
    expect(out.count).toBe(5);
  });

  it("keeps a table cell's \\| byte for byte", () => {
    const text = String.raw`| ![[Files/a.png\|40]] | [[Files/doc.pdf\|Doc]] |` + "\n";
    const out = rewriteWikilinkFolder(text, "Files", "Archive/Files");
    expect(out.content).toBe(String.raw`| ![[Archive/Files/a.png\|40]] | [[Archive/Files/doc.pdf\|Doc]] |` + "\n");
    expect(out.count).toBe(2);
  });

  it("leaves files outside the folder, a folder that only starts the same, and code alone", () => {
    const text = "![[a.png]] ![[FilesOld/a.png]] ![[Other/Files/a.png]] `![[Files/a.png]]`\n\n```\n![[Files/a.png]]\n```\n";
    const out = rewriteWikilinkFolder(text, "Files", "Media");
    expect(out.content).toBe(text);
    expect(out.count).toBe(0);
  });

  it("a moved SUBfolder rewrites only links under it, never its parent's own files", () => {
    const text = "![[Files/a.png]] ![[Files/Sub/b.png]] [[Files/Sub/c.pdf|c]] ![[Files/Subway/d.png]]\n";
    const out = rewriteWikilinkFolder(text, "Files/Sub", "Archive/Sub");
    expect(out.content).toBe("![[Files/a.png]] ![[Archive/Sub/b.png]] [[Archive/Sub/c.pdf|c]] ![[Files/Subway/d.png]]\n");
    expect(out.count).toBe(2);
  });

  it("pages and files in one note, both moved", () => {
    const out = rewriteWikilinkFolder("[[Files/Notes]] with ![[Files/a.png]]\n", "Files", "Media");
    expect(out.content).toBe("[[Media/Notes]] with ![[Media/a.png]]\n");
  });
});
