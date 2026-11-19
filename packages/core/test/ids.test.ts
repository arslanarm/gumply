import { describe, expect, it } from "vitest";
import {
  childPageId,
  isValidPageId,
  pageFilePath,
  parentOf,
  pathToPageId,
  slugify,
  titleFromId,
  uniqueId,
} from "../src/index";

describe("slugify", () => {
  it("lowercases and dashes spaces and punctuation", () => {
    expect(slugify("Hello World!")).toBe("hello-world");
    expect(slugify("  Multi   Space  ")).toBe("multi-space");
    expect(slugify("a/b?c")).toBe("a-b-c");
  });

  it("strips diacritics but keeps non-Latin letters", () => {
    expect(slugify("Café Notes")).toBe("cafe-notes");
    expect(slugify("Проект Гумпли")).toBe("проект-гумпли");
  });

  it("never returns an empty id", () => {
    expect(slugify("???")).toBe("untitled");
    expect(slugify("")).toBe("untitled");
  });

  it("trims leading and trailing separators", () => {
    expect(slugify("--hello--")).toBe("hello");
    expect(slugify("___")).toBe("untitled");
  });
});

describe("titleFromId", () => {
  it("uses the last path segment and makes it readable", () => {
    expect(titleFromId("projects/gumply-notes")).toBe("Gumply notes");
    expect(titleFromId("my_page")).toBe("My page");
    expect(titleFromId("notes")).toBe("Notes");
  });

  it("falls back to Untitled", () => {
    expect(titleFromId("")).toBe("Untitled");
  });
});

describe("page ids", () => {
  it("accepts safe vault-relative ids", () => {
    expect(isValidPageId("notes")).toBe(true);
    expect(isValidPageId("projects/gumply")).toBe(true);
  });

  it("rejects unsafe ids", () => {
    expect(isValidPageId("")).toBe(false);
    expect(isValidPageId("/notes")).toBe(false);
    expect(isValidPageId("notes/")).toBe(false);
    expect(isValidPageId("a//b")).toBe(false);
    expect(isValidPageId("../secrets")).toBe(false);
    expect(isValidPageId("a/./b")).toBe(false);
    expect(isValidPageId("a\\b")).toBe(false);
  });

  it("builds child ids and walks parents", () => {
    expect(childPageId(null, "My Page")).toBe("my-page");
    expect(childPageId("projects", "Gumply")).toBe("projects/gumply");
    expect(parentOf("a/b/c")).toBe("a/b");
    expect(parentOf("a")).toBeNull();
  });

  it("picks the first free unique id", () => {
    expect(uniqueId("notes", [])).toBe("notes");
    expect(uniqueId("notes", ["notes"])).toBe("notes-2");
    expect(uniqueId("notes", ["notes", "notes-2"])).toBe("notes-3");
  });

  it("maps ids to file paths and back", () => {
    expect(pageFilePath("projects/gumply")).toBe("projects/gumply.md");
    expect(pathToPageId("projects/gumply.md")).toBe("projects/gumply");
    expect(pathToPageId("/projects/gumply.md")).toBe("projects/gumply");
  });
});
