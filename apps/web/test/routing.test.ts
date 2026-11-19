import { describe, expect, it } from "vitest";
import { pageHash, pageIdFromHash } from "../src/lib/routing.js";

describe("pageHash", () => {
  it("keeps root and nested ids readable", () => {
    expect(pageHash("gumply")).toBe("#/gumply");
    expect(pageHash("projects/gumply")).toBe("#/projects/gumply");
  });

  it("encodes segments without breaking the separator", () => {
    expect(pageHash("my page")).toBe("#/my%20page");
    expect(pageHash("proj ects/gump ly")).toBe("#/proj%20ects/gump%20ly");
  });
});

describe("pageIdFromHash", () => {
  it("round-trips ids", () => {
    for (const id of ["gumply", "projects/gumply", "notes/2026/ideas"]) {
      expect(pageIdFromHash(pageHash(id))).toBe(id);
    }
  });

  it("returns null when no page is open", () => {
    expect(pageIdFromHash("")).toBeNull();
    expect(pageIdFromHash("#/")).toBeNull();
    expect(pageIdFromHash("#")).toBeNull();
  });

  it("rejects unsafe or malformed ids", () => {
    expect(pageIdFromHash("#/../secret")).toBeNull();
    expect(pageIdFromHash("#/a/../b")).toBeNull();
    expect(pageIdFromHash("#/a//b")).toBeNull();
    expect(pageIdFromHash("#/%E0%A4%A")).toBeNull();
  });
});
