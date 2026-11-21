import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupVaults, createPage, createTestServer, encodeId, getJson, jsonRequest } from "./helpers";

/** #5fv7c25w: a save keeps the file's own ending; `content` never carries it. */

afterEach(cleanupVaults);

const FILES: Record<string, string> = {
  Lf: "A\n\nB\n",
  Crlf: "A\r\n\r\nB\r\n",
  None: "A\n\nB",
  Fm: "---\ntitle: Fm\n---\n\nA\n\nB\n",
  FmNone: "---\ntitle: FmNone\n---\n\nA\n\nB",
  Blank: "A\n\nB\n\n\n",
};

describe("the final newline (#5fv7c25w)", () => {
  it("an unrelated edit keeps each file's own ending (LF, CRLF, none) byte-for-byte", async () => {
    const { app, dir, store } = await createTestServer();
    for (const [name, text] of Object.entries(FILES)) await writeFile(join(dir, `${name}.md`), text);
    await store.rescan();
    for (const [name, text] of Object.entries(FILES)) {
      const page = await getJson<{ content: string; updated: string }>(app, `/api/pages/${encodeId(name)}`);
      const response = await jsonRequest(app, "PUT", `/api/pages/${encodeId(name)}`, {
        content: page.content.replace("B", "B edited"),
        expectedUpdated: page.updated,
      });
      expect(response.status).toBe(200);
      const after = await readFile(join(dir, `${name}.md`), "utf8");
      const body = after.replace(/^---[\s\S]*?---\r?\n\r?\n/, "");
      const expected = text.replace(/^---[\s\S]*?---\n\n/, "").replace("B", "B edited");
      // D21: extra trailing blank lines go; the last line ending stays as it was.
      expect(body, name).toBe(name === "Blank" ? "A\n\nB edited\n" : expected);
    }
  });

  it("`content` is the same with and without frontmatter, and before and after a save", async () => {
    const { app, dir, store } = await createTestServer();
    for (const [name, text] of Object.entries(FILES)) await writeFile(join(dir, `${name}.md`), text);
    await store.rescan();
    for (const name of Object.keys(FILES)) {
      const page = await getJson<{ content: string; updated: string }>(app, `/api/pages/${encodeId(name)}`);
      expect(page.content, name).toBe("A\n\nB");
      const saved = await jsonRequest(app, "PUT", `/api/pages/${encodeId(name)}`, { content: page.content, expectedUpdated: page.updated });
      expect(((await saved.json()) as { content: string }).content, name).toBe("A\n\nB");
    }
  });

  it("a new page ends with a single newline", async () => {
    const { app, dir } = await createTestServer();
    await createPage(app, { title: "Fresh", content: "Hello" });
    expect(await readFile(join(dir, "Fresh.md"), "utf8")).toMatch(/\n\nHello\n$/);
  });
});
