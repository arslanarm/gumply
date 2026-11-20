import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VaultStore } from "../src/vault-store";
import { cleanupVaults, createPage, createTestServer, getJson } from "./helpers";

afterEach(cleanupVaults);

function pngForm(name: string, bytes = [0x89, 0x50, 0x4e, 0x47]): FormData {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(bytes)], name, { type: "image/png" }));
  return form;
}

describe("attachments API", () => {
  it("uploads a file, serves it with caching headers and lists it", async () => {
    const { app, dir } = await createTestServer();
    const response = await app.request("/api/attachments", { method: "POST", body: pngForm("photo.png") });
    expect(response.status).toBe(201);
    const attachment = (await response.json()) as Record<string, unknown>;
    expect(attachment).toEqual({
      path: "attachments/photo.png",
      name: "photo.png",
      size: 4,
      mime: "image/png",
    });
    expect(await readFile(join(dir, "attachments", "photo.png"))).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );

    const served = await app.request("/api/files/attachments/photo.png");
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(served.headers.get("content-length")).toBe("4");
    expect(served.headers.get("cache-control")).toContain("immutable");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    );

    const list = await app.request("/api/attachments");
    expect(await list.json()).toEqual([attachment]);
  });

  it("deduplicates names instead of overwriting", async () => {
    const { app, dir } = await createTestServer();
    const first = (await (
      await app.request("/api/attachments", { method: "POST", body: pngForm("photo.png", [1]) })
    ).json()) as Record<string, unknown>;
    const second = (await (
      await app.request("/api/attachments", { method: "POST", body: pngForm("photo.png", [2]) })
    ).json()) as Record<string, unknown>;

    expect(first["name"]).toBe("photo.png");
    expect(second["name"]).toBe("photo-1.png");
    expect(await readFile(join(dir, "attachments", "photo.png"))).toEqual(Buffer.from([1]));
    expect(await readFile(join(dir, "attachments", "photo-1.png"))).toEqual(Buffer.from([2]));
  });

  it("sanitises path-like and unsafe names", async () => {
    const { app, dir } = await createTestServer();
    const response = await app.request("/api/attachments", {
      method: "POST",
      body: pngForm("../../etc/my photo?.png"),
    });
    expect(response.status).toBe(201);
    const attachment = (await response.json()) as Record<string, unknown>;
    expect(attachment["name"]).toBe("my-photo.png");
    expect(attachment["path"]).toBe("attachments/my-photo.png");
    expect(await readFile(join(dir, "attachments", "my-photo.png"))).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
  });

  it("rejects empty files and files over 25 MB", async () => {
    const { app } = await createTestServer();
    const empty = await app.request("/api/attachments", { method: "POST", body: pngForm("empty.png", []) });
    expect(empty.status).toBe(400);

    const tooLarge = new FormData();
    tooLarge.set(
      "file",
      new File([new Uint8Array(25 * 1024 * 1024 + 1)], "big.bin", { type: "application/octet-stream" }),
    );
    const response = await app.request("/api/attachments", { method: "POST", body: tooLarge });
    expect(response.status).toBe(413);
  });

  it("requires a multipart file field", async () => {
    const { app } = await createTestServer();
    const response = await app.request("/api/attachments", { method: "POST" });
    expect(response.status).toBe(400);
  });

  it("serves vault Markdown read-only but refuses traversal and hidden directories", async () => {
    const { app, dir } = await createTestServer();
    await createPage(app, { title: "Doc", content: "hello" });
    const markdown = await app.request("/api/files/doc.md");
    expect(markdown.status).toBe(200);
    expect(markdown.headers.get("content-type")).toContain("text/markdown");
    expect(markdown.headers.get("cache-control")).toBe("no-cache");
    expect(await markdown.text()).toContain("hello");

    await writeFile(join(dir, "secret.txt"), "outside", "utf8");
    await mkdir(join(dir, ".trash", "t1"), { recursive: true });
    await writeFile(join(dir, ".trash", "t1", "secret.txt"), "trashed", "utf8");
    await mkdir(join(dir, ".gumply"), { recursive: true });
    await writeFile(join(dir, ".gumply", "state.json"), "{}", "utf8");

    for (const path of [
      encodeURIComponent("../secret.txt"),
      encodeURIComponent(".trash/t1/secret.txt"),
      encodeURIComponent(".gumply/state.json"),
      encodeURIComponent("attachments/../secret.txt"),
      "missing.png",
    ]) {
      const response = await app.request(`/api/files/${path}`);
      expect(response.status, path).toBe(404);
    }
  });

  it("never indexes attachments as pages", async () => {
    const { dir } = await createTestServer();
    await mkdir(join(dir, "attachments"), { recursive: true });
    await writeFile(join(dir, "attachments", "notes.md"), "# not a page", "utf8");

    const store = new VaultStore(dir);
    await store.init();
    expect(store.list()).toEqual([]);
    expect(store.search("not a page")).toEqual([]);
  });

  it("does not create graph ghost nodes for attachment links", async () => {
    const { app } = await createTestServer();
    await createPage(app, {
      title: "Source",
      content: "See [[Target]], [[manual.pdf]] and ![[photo.png]].",
    });
    await createPage(app, { title: "Target" });

    const graph = await getJson<{
      links: Array<{ source: string; target: string }>;
      unresolved: Array<{ source: string; targetTitle: string }>;
    }>(app, "/api/graph");
    expect(graph.links).toEqual([{ source: "source", target: "target" }]);
    expect(graph.unresolved).toEqual([]);
  });
});
