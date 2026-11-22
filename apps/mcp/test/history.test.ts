/** Unit tests: history layout and retention, audit rotation, sections, rate limits. */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { audit, AUDIT_FILE } from "../src/audit.js";
import { ToolError } from "../src/errors.js";
import { pageKey, readIndex, saveVersion, stamp } from "../src/history.js";
import { RateLimiter } from "../src/limits.js";
import { appendMarkdown } from "../src/tools/write.js";

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "gumply-mcp-unit-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("history layout (D35, shared with 0.9)", () => {
  it("page keys are one reversible directory name", () => {
    expect(pageKey("Projects/Plan")).toBe("Projects%2FPlan");
    expect(pageKey("Map.canvas")).toBe("Map.canvas");
    expect(pageKey('50% "done": a|b?')).toBe("50%25 %22done%22%3A a%7Cb%3F");
    for (const id of ["Projects/Plan", "50% done/x", "a:b*c"]) expect(decodeURIComponent(pageKey(id))).toBe(id);
  });

  it("timestamps are UTC YYYYMMDDTHHMMSSmmmZ; a clash gets -2", async () => {
    const at = new Date(Date.UTC(2026, 10, 22, 9, 5, 7, 42));
    expect(stamp(at)).toBe("20261122T090507042Z");
    const root = temp();
    const one = await saveVersion(root, { id: "A/B", ext: "md", bytes: Buffer.from("one"), version: "v1", tool: "update_page", client: "c", now: at });
    const two = await saveVersion(root, { id: "A/B", ext: "md", bytes: Buffer.from("two"), version: "v2", tool: "update_page", client: "c", now: at });
    expect([one.file, two.file]).toEqual(["20261122T090507042Z.md", "20261122T090507042Z-2.md"]);
    const dir = join(root, ".gumply/history/A%2FB");
    expect(readFileSync(join(dir, two.file), "utf8")).toBe("two");
    expect(await readIndex(dir)).toEqual([
      expect.objectContaining({ file: one.file, id: "A/B", version: "v1", source: "mcp", bytes: 3, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }),
      expect.objectContaining({ file: two.file, version: "v2" }),
    ]);
  });

  it("keeps the newest 50 or 30 days, whichever keeps more, never the newest", async () => {
    const root = temp();
    const dir = join(root, ".gumply/history/P");
    const day = 86_400_000;
    const start = Date.UTC(2026, 0, 1);
    // 60 versions a day apart: the last 30 days hold 30, the newest 50 win.
    for (let n = 0; n < 60; n += 1) {
      await saveVersion(root, { id: "P", ext: "md", bytes: Buffer.from(`v${n}`), version: `v${n}`, tool: "t", client: "c", now: new Date(start + n * day) });
    }
    let index = await readIndex(dir);
    expect(index).toHaveLength(50);
    expect(index[0]!.version).toBe("v10");
    expect(readdirSync(dir).filter((name) => name.endsWith(".md"))).toHaveLength(50);
    // 60 more within one day: all within 30 days, so all are kept with the recent ones.
    const now = start + 70 * day;
    for (let n = 0; n < 60; n += 1) {
      await saveVersion(root, { id: "P", ext: "md", bytes: Buffer.from(`w${n}`), version: `w${n}`, tool: "t", client: "c", now: new Date(now + n * 1000) });
    }
    index = await readIndex(dir);
    expect(index.filter((entry) => entry.version.startsWith("w"))).toHaveLength(60);
    expect(index.some((entry) => entry.version === "v59")).toBe(true); // 11 days before: inside 30 days
    expect(index.some((entry) => entry.version === "v30")).toBe(false); // 40 days before, not among the newest 50
  });
});

describe("audit log", () => {
  it("writes exactly the six fields and rotates at the size limit, keeping three files", async () => {
    const root = temp();
    for (let n = 0; n < 12; n += 1) await audit(root, { tool: "create_page", id: `P${n}`, before: null, after: "v", client: "c" }, 200);
    const file = join(root, AUDIT_FILE);
    expect(existsSync(file)).toBe(true);
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(existsSync(`${file}.2`)).toBe(true);
    expect(existsSync(`${file}.3`)).toBe(false);
    const last = JSON.parse(readFileSync(file, "utf8").trim().split("\n").pop()!) as Record<string, unknown>;
    expect(Object.keys(last).sort()).toEqual(["after", "at", "before", "client", "id", "tool"]);
    expect(last.id).toBe("P11");
  });
});

describe("appendMarkdown", () => {
  const page = "# Title\n\nIntro.\n\n## A\n\nText A.\n\n### A.1\n\nDeep.\n\n## B\n\n- one\n";
  it("appends at the end, or at a section's end (deeper headings belong to it)", () => {
    expect(appendMarkdown(page, "New.")).toBe(`${page}\nNew.\n`);
    expect(appendMarkdown(page, "- two", "B")).toBe(`${page}- two\n`);
    expect(appendMarkdown(page, "More A.", "## A")).toBe(page.replace("Deep.\n\n## B", "Deep.\n\nMore A.\n\n## B"));
    expect(appendMarkdown("", "First.")).toBe("First.\n");
    expect(appendMarkdown("No newline", "x")).toBe("No newline\n\nx\n");
  });
  it("lists the headings when none matches", () => {
    try {
      appendMarkdown(page, "x", "Missing");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      expect((error as ToolError).extra.headings).toEqual(["Title", "A", "A.1", "B"]);
    }
  });
});

describe("RateLimiter", () => {
  it("30 a minute and 1,000 a day, with retryAfterMs", () => {
    let now = 0;
    const limiter = new RateLimiter(3, 5, () => now);
    for (let n = 0; n < 3; n += 1) limiter.take();
    expect(() => limiter.take()).toThrow(ToolError);
    try {
      limiter.take();
    } catch (error) {
      expect((error as ToolError).extra.retryAfterMs).toBe(60_000);
    }
    now = 61_000;
    limiter.take();
    limiter.take();
    now = 130_000;
    expect(() => limiter.take()).toThrow(/a day/);
  });
});

it("fixture text is synthetic (public repo)", () => {
  const fixture = join(import.meta.dirname, "fixtures/notes");
  const all = readdirSync(fixture, { recursive: true }).map(String);
  for (const name of all) {
    if (!/\.(md|canvas|json)$/.test(name)) continue;
    const text = readFileSync(join(fixture, name), "utf8");
    expect(text, name).not.toMatch(/\/home\/|\/Users\/|C:\\\\|@[a-z0-9-]+\.(com|ru|org)/i);
  }
  writeFileSync(join(temp(), "noop"), "");
});
