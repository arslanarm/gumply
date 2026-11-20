import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  it("announces the seeded welcome page once via header", async () => {
    const { app, store } = await createTestServer();
    expect(await store.seedDemoIfFirstRun()).toBe("Welcome");

    const first = await app.request("/api/pages");
    expect(first.status).toBe(200);
    expect(first.headers.get("x-gumply-new-vault")).toBe("Welcome");

    const second = await app.request("/api/pages");
    expect(second.headers.get("x-gumply-new-vault")).toBeNull();
  });

  it("creates a page, writes Markdown and reads it back", async () => {
    const { app, dir } = await createTestServer();
    const created = await createPage(app, { title: "My Page", content: "Hello **world**" });

    expect(created.id).toBe("My Page");
    expect(created.title).toBe("My Page");
    expect(created.content).toBe("Hello **world**");
    expect(created.parentId).toBeNull();
    expect(created.tags).toEqual([]);

    const file = await import("node:fs/promises").then((fs) =>
      fs.readFile(`${dir}/My Page.md`, "utf8"),
    );
    expect(file).toContain("title: My Page");
    expect(file).toContain("Hello **world**");

    const list = await getJson<Array<Record<string, unknown>>>(app, "/api/pages");
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty("content");

    const page = await getJson<Record<string, unknown>>(
      app,
      `/api/pages/${encodeURIComponent("My Page")}`,
    );
    expect(page.content).toBe("Hello **world**");
  });

  it("derives ids from titles and makes duplicates unique", async () => {
    const { app } = await createTestServer();
    const first = await createPage(app, { title: "Projects" });
    const second = await createPage(app, { title: "Projects" });
    expect(first.id).toBe("Projects");
    expect(second.id).toBe("Projects 2");
  });

  it("renames the file with the title, follows the new id and redirects the old one", async () => {
    const { app, dir } = await createTestServer();
    const created = await createPage(app, { title: "Old Name", content: "body" });

    const response = await jsonRequest(
      app,
      "PUT",
      `/api/pages/${encodeURIComponent(created.id)}`,
      { title: "New Name" },
    );
    expect(response.status).toBe(200);
    const updated = (await response.json()) as Record<string, unknown>;
    expect(updated.id).toBe("New Name");
    expect(updated.title).toBe("New Name");

    const fs = await import("node:fs/promises");
    await expect(fs.stat(`${dir}/Old Name.md`)).rejects.toThrow();
    await expect(fs.stat(`${dir}/New Name.md`)).resolves.toBeTruthy();

    const page = await getJson<Record<string, unknown>>(
      app,
      `/api/pages/${encodeURIComponent(created.id)}`,
    );
    expect(page.title).toBe("New Name");
    expect(page.id).toBe("New Name");

    // Unknown ids still 404; the redirect is only for ids this session renamed.
    expect((await app.request("/api/pages/never-existed")).status).toBe(404);
  });

  it("updates content, tags and icon", async () => {
    const { app } = await createTestServer();
    await createPage(app, { title: "Notes" });

    const response = await jsonRequest(app, "PUT", `/api/pages/${encodeURIComponent("Notes")}`, {
      content: "Body #inline",
      tags: ["work"],
      icon: "🚀",
    });
    expect(response.status).toBe(200);
    const updated = (await response.json()) as Record<string, unknown>;
    expect(updated.tags).toEqual(expect.arrayContaining(["work", "inline"]));
    expect(updated.icon).toBe("🚀");

    const cleared = await jsonRequest(app, "PUT", `/api/pages/${encodeURIComponent("Notes")}`, {
      icon: null,
    });
    expect(((await cleared.json()) as Record<string, unknown>).icon).toBeUndefined();

    const bad = await jsonRequest(app, "PUT", `/api/pages/${encodeURIComponent("Notes")}`, {
      title: "   ",
    });
    expect(bad.status).toBe(400);
  });

  it("returns 409 for a stale conditional update and accepts force", async () => {
    const { app, dir } = await createTestServer();
    const created = await createPage(app, { title: "Conflict", content: "original" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeFile(`${dir}/${created.id}.md`, "external body", "utf8");

    const stale = await jsonRequest(app, "PUT", `/api/pages/${encodeURIComponent(created.id)}`, {
      content: "mine",
      expectedUpdated: created.updated,
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "This page changed on disk." });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const forced = await jsonRequest(app, "PUT", `/api/pages/${encodeURIComponent(created.id)}`, {
      content: "mine",
      force: true,
    });
    expect(forced.status).toBe(200);
    expect(((await forced.json()) as Record<string, unknown>).content).toBe("mine");
    warnSpy.mockRestore();
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
    const parent = await createPage(app, { title: "Projects" });
    const child = await createPage(app, { title: "Gumply", parentId: parent.id });

    expect(child.id).toBe("Projects/Gumply");
    expect(child.parentId).toBe("Projects");

    const fs = await import("node:fs/promises");
    await expect(fs.stat(`${dir}/Projects/Gumply.md`)).resolves.toBeTruthy();

    const list = await getJson<Array<Record<string, unknown>>>(app, "/api/pages");
    expect(list.map((page) => page.id).sort()).toEqual(["Projects", "Projects/Gumply"]);
    expect(list.find((page) => page.id === "Projects")?.childCount).toBe(1);
    expect(list.find((page) => page.id === "Projects/Gumply")?.childCount).toBe(0);

    const page = await getJson<Record<string, unknown>>(
      app,
      `/api/pages/${encodeURIComponent("Projects/Gumply")}`,
    );
    expect(page.title).toBe("Gumply");
  });

  it("moves deleted children into .trash and restores them", async () => {
    const { app, dir } = await createTestServer();
    const a = await createPage(app, { title: "A", content: "root" });
    const b = await createPage(app, { title: "B", parentId: a.id });
    await createPage(app, { title: "C", parentId: b.id });

    const response = await jsonRequest(
      app,
      "DELETE",
      `/api/pages/${encodeURIComponent(a.id)}`,
    );
    expect(response.status).toBe(200);
    const result = (await response.json()) as { trashId: string; deleted: string[] };
    expect(typeof result.trashId).toBe("string");
    expect(result.deleted).toEqual(["A", "A/B", "A/B/C"]);

    expect(await getJson<unknown[]>(app, "/api/pages")).toEqual([]);

    const fs = await import("node:fs/promises");
    await expect(fs.stat(`${dir}/A.md`)).rejects.toThrow();
    await expect(fs.stat(`${dir}/A`)).rejects.toThrow();
    await expect(fs.stat(`${dir}/.trash/${result.trashId}/A.md`)).resolves.toBeTruthy();
    await expect(fs.stat(`${dir}/.trash/${result.trashId}/A/B.md`)).resolves.toBeTruthy();

    const restored = await jsonRequest(
      app,
      "POST",
      `/api/trash/${encodeURIComponent(result.trashId)}/restore`,
    );
    expect(restored.status).toBe(200);
    const metas = (await restored.json()) as Array<Record<string, unknown>>;
    expect(metas.map((meta) => meta.id).sort()).toEqual(["A", "A/B", "A/B/C"]);
    expect(metas.find((meta) => meta.id === "A")?.childCount).toBe(1);

    expect((await getJson<Record<string, unknown>>(app, "/api/pages/A")).content).toBe("root");
    expect(
      (await getJson<Record<string, unknown>>(app, `/api/pages/${encodeURIComponent("A/B/C")}`)).id,
    ).toBe("A/B/C");
    await expect(fs.stat(`${dir}/.trash/${result.trashId}`)).rejects.toThrow();

    // The trash entry is consumed.
    expect(
      (await jsonRequest(app, "POST", `/api/trash/${encodeURIComponent(result.trashId)}/restore`))
        .status,
    ).toBe(404);
  });

  it("keeps .trash out of the page tree and refuses to restore over a live page", async () => {
    const { app } = await createTestServer();
    const a = await createPage(app, { title: "A" });
    await createPage(app, { title: "Keep" });

    const deleted = (await (
      await jsonRequest(app, "DELETE", `/api/pages/${encodeURIComponent(a.id)}`)
    ).json()) as { trashId: string };

    // Re-create the same title, then undo: the original path is taken → 409.
    await createPage(app, { title: "A" });
    const list = await getJson<Array<Record<string, unknown>>>(app, "/api/pages");
    expect(list.map((page) => page.id).sort()).toEqual(["A", "Keep"]);

    const restore = await jsonRequest(
      app,
      "POST",
      `/api/trash/${encodeURIComponent(deleted.trashId)}/restore`,
    );
    expect(restore.status).toBe(409);
    expect(await restore.json()).toEqual({ error: "A page already exists at A" });
  });

  it("restores a nested subtree under its original parent", async () => {
    const { app } = await createTestServer();
    const a = await createPage(app, { title: "A" });
    const b = await createPage(app, { title: "B", parentId: a.id });
    await createPage(app, { title: "C", parentId: b.id });

    const result = (await (
      await jsonRequest(app, "DELETE", `/api/pages/${encodeURIComponent(b.id)}`)
    ).json()) as { trashId: string; deleted: string[] };
    expect(result.deleted).toEqual(["A/B", "A/B/C"]);

    const listAfterDelete = await getJson<Array<Record<string, unknown>>>(app, "/api/pages");
    expect(listAfterDelete.map((page) => page.id)).toEqual(["A"]);

    const restored = await jsonRequest(
      app,
      "POST",
      `/api/trash/${encodeURIComponent(result.trashId)}/restore`,
    );
    expect(restored.status).toBe(200);

    const bPage = await getJson<Record<string, unknown>>(
      app,
      `/api/pages/${encodeURIComponent("A/B")}`,
    );
    expect(bPage.parentId).toBe("A");
    expect(bPage.childCount).toBe(1);
  });

  it("rejects invalid trash ids", async () => {
    const { app } = await createTestServer();
    const response = await app.request(
      `/api/trash/${encodeURIComponent("../../etc/passwd")}/restore`,
      { method: "POST" },
    );
    expect(response.status).toBe(400);
    expect((await jsonRequest(app, "POST", "/api/trash/nope/restore")).status).toBe(404);
  });

  it("moves a page and its children, then back to the root", async () => {
    const { app, dir } = await createTestServer();
    const a = await createPage(app, { title: "A" });
    await createPage(app, { title: "Child", parentId: a.id });
    const c = await createPage(app, { title: "C" });

    const moved = await jsonRequest(
      app,
      "POST",
      `/api/pages/${encodeURIComponent(a.id)}/move`,
      { parentId: c.id },
    );
    expect(moved.status).toBe(200);
    const movedPage = (await moved.json()) as Record<string, unknown>;
    expect(movedPage.id).toBe("C/A");
    expect(movedPage.parentId).toBe("C");

    const child = await getJson<Record<string, unknown>>(
      app,
      `/api/pages/${encodeURIComponent("C/A/Child")}`,
    );
    expect(child.parentId).toBe("C/A");

    const afterMove = await getJson<Array<Record<string, unknown>>>(app, "/api/pages");
    expect(afterMove.find((page) => page.id === "C")?.childCount).toBe(1);
    expect(afterMove.find((page) => page.id === "C/A")?.childCount).toBe(1);

    const fs = await import("node:fs/promises");
    await expect(fs.stat(`${dir}/C/A.md`)).resolves.toBeTruthy();
    await expect(fs.stat(`${dir}/C/A/Child.md`)).resolves.toBeTruthy();
    await expect(fs.stat(`${dir}/A.md`)).rejects.toThrow();

    const back = await jsonRequest(
      app,
      "POST",
      `/api/pages/${encodeURIComponent("C/A")}/move`,
      { parentId: null },
    );
    expect(((await back.json()) as Record<string, unknown>).id).toBe("A");
    expect(
      (await getJson<Record<string, unknown>>(app, `/api/pages/${encodeURIComponent("A/Child")}`)).id,
    ).toBe("A/Child");
  });

  it("rejects conflicting, self-child and unknown moves", async () => {
    const { app } = await createTestServer();
    const a = await createPage(app, { title: "A" });
    await createPage(app, { title: "Child", parentId: a.id });
    const d = await createPage(app, { title: "D" });
    await createPage(app, { title: "A", parentId: d.id });

    const aPath = `/api/pages/${encodeURIComponent(a.id)}`;
    expect((await jsonRequest(app, "POST", `${aPath}/move`, { parentId: d.id })).status).toBe(409);
    expect(
      (await jsonRequest(app, "POST", `${aPath}/move`, { parentId: "A/Child" })).status,
    ).toBe(400);
    expect((await jsonRequest(app, "POST", `${aPath}/move`, { parentId: "nope" })).status).toBe(404);
    expect((await jsonRequest(app, "POST", `${aPath}/move`, {})).status).toBe(400);
  });
});
