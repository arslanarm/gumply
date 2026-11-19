import { afterEach, describe, expect, it } from "vitest";
import { cleanupVaults, createPage, createTestServer, getJson, jsonRequest } from "./helpers";

afterEach(cleanupVaults);

describe("GET /api/health", () => {
  it("reports the app, version and vault path", async () => {
    const { app, dir } = await createTestServer();
    const response = await app.request("/api/health");
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.name).toBe("Gumply");
    expect(body.vaultPath).toBe(dir);
    expect(typeof body.version).toBe("string");
  });

  it("returns JSON 404s", async () => {
    const { app } = await createTestServer();
    const response = await app.request("/api/nope");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
  });
});

describe("pages CRUD", () => {
  it("creates a page, writes Markdown and reads it back", async () => {
    const { app, dir } = await createTestServer();
    const created = await createPage(app, { title: "My Page", content: "Hello **world**" });

    expect(created.id).toBe("my-page");
    expect(created.title).toBe("My Page");
    expect(created.content).toBe("Hello **world**");
    expect(created.parentId).toBeNull();
    expect(created.tags).toEqual([]);

    const file = await import("node:fs/promises").then((fs) =>
      fs.readFile(`${dir}/my-page.md`, "utf8"),
    );
    expect(file).toContain("title: My Page");
    expect(file).toContain("Hello **world**");

    const list = await getJson<Array<Record<string, unknown>>>(app, "/api/pages");
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty("content");

    const page = await getJson<Record<string, unknown>>(app, "/api/pages/my-page");
    expect(page.content).toBe("Hello **world**");
  });

  it("derives ids from titles and makes duplicates unique", async () => {
    const { app } = await createTestServer();
    const first = await createPage(app, { title: "Projects" });
    const second = await createPage(app, { title: "Projects" });
    expect(first.id).toBe("projects");
    expect(second.id).toBe("projects-2");
  });

  it("keeps the id stable when the title changes", async () => {
    const { app } = await createTestServer();
    await createPage(app, { title: "Old Name", content: "body" });

    const response = await jsonRequest(app, "PUT", "/api/pages/old-name", { title: "New Name" });
    expect(response.status).toBe(200);
    const updated = (await response.json()) as Record<string, unknown>;
    expect(updated.id).toBe("old-name");
    expect(updated.title).toBe("New Name");

    const page = await getJson<Record<string, unknown>>(app, "/api/pages/old-name");
    expect(page.title).toBe("New Name");
  });

  it("updates content, tags and icon", async () => {
    const { app } = await createTestServer();
    await createPage(app, { title: "Notes" });

    const response = await jsonRequest(app, "PUT", "/api/pages/notes", {
      content: "Body #inline",
      tags: ["work"],
      icon: "🚀",
    });
    expect(response.status).toBe(200);
    const updated = (await response.json()) as Record<string, unknown>;
    expect(updated.tags).toEqual(expect.arrayContaining(["work", "inline"]));
    expect(updated.icon).toBe("🚀");

    const cleared = await jsonRequest(app, "PUT", "/api/pages/notes", { icon: null });
    expect(((await cleared.json()) as Record<string, unknown>).icon).toBeUndefined();

    const bad = await jsonRequest(app, "PUT", "/api/pages/notes", { title: "   " });
    expect(bad.status).toBe(400);
  });

  it("rejects bad input with 400 and unknown pages with 404", async () => {
    const { app } = await createTestServer();

    expect((await jsonRequest(app, "POST", "/api/pages", {})).status).toBe(400);
    expect((await jsonRequest(app, "POST", "/api/pages", { title: "X", parentId: "nope" })).status).toBe(404);
    expect((await jsonRequest(app, "POST", "/api/pages", { title: "X", parentId: "../evil" })).status).toBe(400);
    expect((await app.request("/api/pages/missing")).status).toBe(404);
    expect((await jsonRequest(app, "PUT", "/api/pages/missing", { content: "x" })).status).toBe(404);
    expect((await jsonRequest(app, "DELETE", "/api/pages/missing")).status).toBe(404);
  });

  it("refuses path traversal in page ids", async () => {
    const { app } = await createTestServer();
    const response = await app.request(`/api/pages/${encodeURIComponent("../../etc/passwd")}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid page id" });
  });
});

describe("nested pages", () => {
  it("nests pages as folders and lists them flat with parentId", async () => {
    const { app, dir } = await createTestServer();
    await createPage(app, { title: "Projects" });
    const child = await createPage(app, { title: "Gumply", parentId: "projects" });

    expect(child.id).toBe("projects/gumply");
    expect(child.parentId).toBe("projects");

    const fs = await import("node:fs/promises");
    await expect(fs.stat(`${dir}/projects/gumply.md`)).resolves.toBeTruthy();

    const list = await getJson<Array<Record<string, unknown>>>(app, "/api/pages");
    expect(list.map((page) => page.id).sort()).toEqual(["projects", "projects/gumply"]);

    const page = await getJson<Record<string, unknown>>(
      app,
      `/api/pages/${encodeURIComponent("projects/gumply")}`,
    );
    expect(page.title).toBe("Gumply");
  });

  it("deletes children with their parent", async () => {
    const { app, dir } = await createTestServer();
    await createPage(app, { title: "A" });
    await createPage(app, { title: "B", parentId: "a" });
    await createPage(app, { title: "C", parentId: "a/b" });

    const response = await jsonRequest(app, "DELETE", "/api/pages/a");
    expect(response.status).toBe(204);

    expect(await getJson<unknown[]>(app, "/api/pages")).toEqual([]);
    const fs = await import("node:fs/promises");
    await expect(fs.stat(`${dir}/a.md`)).rejects.toThrow();
    await expect(fs.stat(`${dir}/a`)).rejects.toThrow();
  });

  it("moves a page and its children, then back to the root", async () => {
    const { app, dir } = await createTestServer();
    await createPage(app, { title: "A" });
    await createPage(app, { title: "Child", parentId: "a" });
    await createPage(app, { title: "C" });

    const moved = await jsonRequest(app, "POST", "/api/pages/a/move", { parentId: "c" });
    expect(moved.status).toBe(200);
    const movedPage = (await moved.json()) as Record<string, unknown>;
    expect(movedPage.id).toBe("c/a");
    expect(movedPage.parentId).toBe("c");

    const child = await getJson<Record<string, unknown>>(
      app,
      `/api/pages/${encodeURIComponent("c/a/child")}`,
    );
    expect(child.parentId).toBe("c/a");

    const fs = await import("node:fs/promises");
    await expect(fs.stat(`${dir}/c/a.md`)).resolves.toBeTruthy();
    await expect(fs.stat(`${dir}/c/a/child.md`)).resolves.toBeTruthy();
    await expect(fs.stat(`${dir}/a.md`)).rejects.toThrow();

    const back = await jsonRequest(app, "POST", `/api/pages/${encodeURIComponent("c/a")}/move`, {
      parentId: null,
    });
    expect(((await back.json()) as Record<string, unknown>).id).toBe("a");
    expect(
      (await getJson<Record<string, unknown>>(app, `/api/pages/${encodeURIComponent("a/child")}`)).id,
    ).toBe("a/child");
  });

  it("rejects conflicting, self-child and unknown moves", async () => {
    const { app } = await createTestServer();
    await createPage(app, { title: "A" });
    await createPage(app, { title: "Child", parentId: "a" });
    await createPage(app, { title: "D" });
    await createPage(app, { title: "A", parentId: "d" });

    expect((await jsonRequest(app, "POST", "/api/pages/a/move", { parentId: "d" })).status).toBe(409);
    expect((await jsonRequest(app, "POST", "/api/pages/a/move", { parentId: "a/child" })).status).toBe(400);
    expect((await jsonRequest(app, "POST", "/api/pages/a/move", { parentId: "nope" })).status).toBe(404);
    expect((await jsonRequest(app, "POST", "/api/pages/a/move", {})).status).toBe(400);
  });
});
