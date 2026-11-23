import { describe, expect, it } from "vitest";
import {
  embedWidth,
  embedWithWidth,
  joinAltWidth,
  markdownWithWidth,
  nearestStep,
  splitAltWidth,
  steppedWidth,
} from "../src/editor/attachments/image-width";

/** #e9bd64bb (D46): a block image's width in Obsidian's `|N` syntax. */
describe("Markdown image alt: caption|width", () => {
  it("splits and joins a width, and keeps a caption without one as is", () => {
    expect(splitAltWidth("Cat|300")).toEqual({ text: "Cat", width: 300, size: "300" });
    expect(splitAltWidth("|250")).toEqual({ text: "", width: 250, size: "250" });
    expect(splitAltWidth("Cat|300x200")).toEqual({ text: "Cat", width: 300, size: "300x200" });
    expect(splitAltWidth("Cat")).toEqual({ text: "Cat", width: null, size: null });
    expect(splitAltWidth("A | B")).toEqual({ text: "A | B", width: null, size: null });
    expect(splitAltWidth("Cat|0").width).toBeNull();
    expect(joinAltWidth("Cat", 300)).toBe("Cat|300");
    expect(joinAltWidth("Cat", null)).toBe("Cat");
  });

  it("rewrites only the size in the text as written, and removing it gives the original back", () => {
    const written = "![Cat](<my pic.png> \"A title\")";
    const sized = markdownWithWidth(written, 300);
    expect(sized).toBe("![Cat|300](<my pic.png> \"A title\")");
    expect(markdownWithWidth(sized!, 410.4)).toBe("![Cat|410](<my pic.png> \"A title\")");
    expect(markdownWithWidth(sized!, null)).toBe(written);
    expect(markdownWithWidth("![Cat|300x200](a.png)", 120)).toBe("![Cat|120](a.png)");
    // An escaped pipe is part of the caption.
    expect(markdownWithWidth("![A\\|300](a.png)", 50)).toBe("![A\\|300|50](a.png)");
    expect(markdownWithWidth("not an image", 10)).toBeNull();
  });
});

describe("Obsidian embed: ![[x.png|width]]", () => {
  it("reads the width, including WxH", () => {
    expect(embedWidth("![[photo.png|300]]")).toBe(300);
    expect(embedWidth("![[photo.png|300x200]]")).toBe(300);
    expect(embedWidth("![[photo.png]]")).toBeNull();
    expect(embedWidth("![[photo.png|0]]")).toBeNull();
  });

  it("sets, replaces and removes it; a non-size `|text` stays", () => {
    expect(embedWithWidth("![[photo.png]]", 300)).toBe("![[photo.png|300]]");
    expect(embedWithWidth("![[photo.png|300x200]]", 150)).toBe("![[photo.png|150]]");
    expect(embedWithWidth("![[photo.png|300]]", null)).toBe("![[photo.png]]");
    expect(embedWithWidth("![[Folder/photo.png|alt text]]", 200)).toBe("![[Folder/photo.png|alt text|200]]");
  });
});

describe("resize steps: 25 / 50 / 75 / 100% of the column", () => {
  it("snaps to the nearest share", () => {
    expect(nearestStep(330, 800)).toBe(0.5);
    expect(nearestStep(100, 800)).toBe(0.25);
    expect(nearestStep(790, 800)).toBe(1);
  });

  it("steps up and down; 100% writes no size", () => {
    expect(steppedWidth(null, 800, -1)).toBe(600);
    expect(steppedWidth(600, 800, -1)).toBe(400);
    expect(steppedWidth(400, 800, -1)).toBe(200);
    expect(steppedWidth(200, 800, -1)).toBe(200);
    expect(steppedWidth(200, 800, 1)).toBe(400);
    expect(steppedWidth(600, 800, 1)).toBeNull();
    expect(steppedWidth(null, 800, 1)).toBeNull();
    // Between steps: to the next one in that direction.
    expect(steppedWidth(300, 800, 1)).toBe(400);
    expect(steppedWidth(300, 800, -1)).toBe(200);
  });
});
