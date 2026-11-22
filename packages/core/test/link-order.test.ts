import { describe, expect, it } from "vitest";
import { linkSourceFolder, pickLinkTarget, preferredLinkPath, resolveLinkedFile } from "../src/index";

/** #35e42m7v: the one tie rule for page links and v1.17 file links (Obsidian 1.14.4, measured). */
describe("link-order (shared by resolveWikilink and link-files)", () => {
  it("the linking note's folder", () => {
    expect(linkSourceFolder("Projects/Sub/B")).toBe("projects/sub/");
    expect(linkSourceFolder("Projects/Plan.md")).toBe("projects/");
    expect(linkSourceFolder("Root")).toBe("");
    expect(linkSourceFolder(null)).toBe("");
  });

  it("under the folder at any depth, then shortest, then alphabetical (case-insensitive)", () => {
    const pick = (paths: string[], from: string | null) => pickLinkTarget(paths, (path) => path, from);
    expect(pick(["Other/Three.md", "Projects/Sub/Three.md"], "Projects/A.md")).toBe("Projects/Sub/Three.md");
    expect(pick(["Other/Three.md", "Projects/Sub/Three.md"], "Root.md")).toBe("Other/Three.md");
    expect(pick(["Other/Two.md", "Zeta/Deep/Two.md", "Alpha/Two.md"], "Projects/A.md")).toBe("Alpha/Two.md");
    expect(pick(["Zzzz/Five.md", "Aaaa/five.md"], null)).toBe("Aaaa/five.md");
    expect(pick([], null)).toBeNull();
    expect(preferredLinkPath("b/x", "A/x", "")).toBe(false);
  });

  it("file links follow the same table (v1.17)", () => {
    const files = ["Target.png", "Projects/Target.png", "Projects/Sub/Target.png", "Other/Three.png", "Projects/Sub/Three.png", "Other/Two.png", "Alpha/Two.png", "Zeta/Deep/Two.png"];
    expect(resolveLinkedFile("Target.png", "Projects/A.md", files)).toBe("Target.png");
    expect(resolveLinkedFile("Three.png", "Projects/A.md", files)).toBe("Projects/Sub/Three.png");
    expect(resolveLinkedFile("Three.png", "Root.md", files)).toBe("Other/Three.png");
    expect(resolveLinkedFile("Two.png", "Other/C.md", files)).toBe("Other/Two.png");
    expect(resolveLinkedFile("Two.png", "Zeta/Deep/D.md", files)).toBe("Zeta/Deep/Two.png");
    expect(resolveLinkedFile("Two.png", "Projects/A.md", files)).toBe("Alpha/Two.png");
  });
});
