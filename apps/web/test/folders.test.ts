import { describe, expect, it } from "vitest";
import { folderSummary } from "../src/lib/folders.js";

describe("folder overview summary (D33)", () => {
  it("counts items and the other files inside", () => {
    expect(folderSummary(4, 2)).toBe("Folder · 4 items · 2 other files");
    expect(folderSummary(1, 1)).toBe("Folder · 1 item · 1 other file");
    expect(folderSummary(3)).toBe("Folder · 3 items");
  });

  it("a folder holding only files doesn't read as empty; an empty one says so", () => {
    expect(folderSummary(0, 1)).toBe("Folder · 1 other file");
    expect(folderSummary(0, 0)).toBe("Folder · 0 items");
  });
});
