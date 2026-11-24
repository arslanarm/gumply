import { describe, expect, it } from "vitest";
import {
  embedWidth,
  embedWithWidth,
  joinAltWidth,
  markdownWithWidth,
  nearestStep,
  splitAltWidth,
  steppedWidth,
  altParts,
  captionPatch,
  fullColumnWidth,
  imageCaptionOf,
  imageWidthOf,
  widthPatch,
} from "../src/editor/attachments/image-width";
import { rawKey } from "../src/editor/attachments/image-raw";

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

describe("widthPatch keeps the text as written only while it's current (D37)", () => {
  const written = "![Old](<my pic.png>)";
  const parsed = { src: "my pic.png", alt: "Old", title: null, markdownRaw: written, markdownRawKey: rawKey("my pic.png", "Old", null) };

  it("an untouched image: only the size changes in its text", () => {
    expect(widthPatch(parsed, 300)).toEqual({ alt: "Old|300", altLiteral: false, markdownRaw: "![Old|300](<my pic.png>)", markdownRawKey: rawKey("my pic.png", "Old|300", null) });
  });

  it("after a caption edit the old text is stale: a resize drops it, so the new caption is written", () => {
    // The caption was edited: alt moved on, the recorded text and its key didn't.
    const edited = { ...parsed, alt: "New" };
    expect(widthPatch(edited, 300)).toEqual({ alt: "New|300", altLiteral: false, markdownRaw: null, markdownRawKey: null });
  });

  it("a stale text isn't revived by a width that is then removed", () => {
    const edited = { ...parsed, alt: "New|300" };
    expect(widthPatch(edited, null)).toEqual({ alt: "New", altLiteral: false, markdownRaw: null, markdownRawKey: null });
  });
});

describe("keyboard steps from an image with no width start at its drawn width", () => {
  it("a 200 px picture in a 700 px column: Shift+← goes to 25%, not 75%", () => {
    expect(steppedWidth(200, 700, -1)).toBe(175);
    expect(steppedWidth(200, 700, 1)).toBe(350);
  });

  it("a picture as wide as the column is at 100%: Shift+→ stays (no size)", () => {
    expect(steppedWidth(700, 700, 1)).toBeNull();
  });
});

describe("an escaped pipe in the text as written is a caption, not a width (#3zpgenmw)", () => {
  const image = (raw: string, alt: string) => ({ src: "a.png", alt, title: null, markdownRaw: raw, markdownRawKey: rawKey("a.png", alt, null) });

  it("![A\\|300](a.png): no width, whichever way the alt was read", () => {
    // After #3zpgenmw the escape is kept ("A|300"); before it, it was lost ("A300"). Neither is a width.
    for (const alt of ["A|300", "A300"]) {
      const attrs = image("![A\\|300](a.png)", alt);
      expect(imageWidthOf(attrs)).toBeNull();
      expect(imageCaptionOf(attrs)).toBe(alt);
    }
  });

  it("an unescaped |N is a width; an escaped backslash before it doesn't escape the pipe", () => {
    expect(imageWidthOf(image("![A|300](a.png)", "A|300"))).toBe(300);
    expect(altParts(image("![A\\\\|300](a.png)", "A\\|300"))).toEqual({ text: "A\\", width: 300, size: "300" });
  });

  it("with no text as written (made in the editor), the alt decides", () => {
    expect(imageWidthOf({ src: "a.png", alt: "A|300" })).toBe(300);
  });

  it("resizing a caption with an escaped pipe keeps it a caption", () => {
    const attrs = image("![A\\|300](a.png)", "A|300");
    const patch = widthPatch(attrs, 200);
    expect(patch).toEqual({ alt: "A|300|200", altLiteral: false, markdownRaw: "![A\\|300|200](a.png)", markdownRawKey: rawKey("a.png", "A|300|200", null) });
    const resized = { ...attrs, ...patch };
    expect(imageWidthOf(resized)).toBe(200);
    expect(imageCaptionOf(resized)).toBe("A|300");
  });
});

describe("full width on a picture narrower than the column is the column in px (#e9bd64bb review)", () => {
  it("no size only when the picture is at least as wide as the column", () => {
    expect(fullColumnWidth(1600, 700)).toBeNull();
    expect(fullColumnWidth(700, 700)).toBeNull();
    expect(fullColumnWidth(200, 700)).toBe(700);
    // Not loaded yet: no size, as before.
    expect(fullColumnWidth(0, 700)).toBeNull();
  });

  it("a 200 px picture stepped up three times ends at the column, not back at 200 px", () => {
    expect(steppedWidth(200, 700, 1, 200)).toBe(350);
    expect(steppedWidth(350, 700, 1, 200)).toBe(525);
    expect(steppedWidth(525, 700, 1, 200)).toBe(700);
    // Once there, another step up stays (the limit), and a step down goes to 75%.
    expect(steppedWidth(700, 700, 1, 200)).toBe(700);
    expect(steppedWidth(700, 700, -1, 200)).toBe(525);
  });
});

describe("a caption the user types ending in |digits stays a caption (altLiteral)", () => {
  it("«B|300» with no size is marked literal: no width, the whole text is the caption", () => {
    const patch = captionPatch({ src: "a.png", alt: "A" }, "B|300");
    expect(patch).toEqual({ alt: "B|300", altLiteral: true });
    const attrs = { src: "a.png", ...patch };
    expect(imageWidthOf(attrs)).toBeNull();
    expect(imageCaptionOf(attrs)).toBe("B|300");
    expect(altParts(attrs)).toEqual({ text: "B|300", width: null, size: null });
  });

  it("with a size, the caption keeps it and needs no mark", () => {
    expect(captionPatch({ src: "a.png", alt: "A|200" }, "B|300")).toEqual({ alt: "B|300|200", altLiteral: false });
    expect(imageCaptionOf({ alt: "B|300|200" })).toBe("B|300");
  });

  it("a resize after it gives a real width and keeps the caption; removing the width marks it again", () => {
    const literal = { src: "a.png", ...captionPatch({ src: "a.png", alt: "" }, "B|300") };
    const sized = { ...literal, ...widthPatch(literal, 200) };
    expect(sized.altLiteral).toBe(false);
    expect(imageWidthOf(sized)).toBe(200);
    expect(imageCaptionOf(sized)).toBe("B|300");
    const back = { ...sized, ...widthPatch(sized, null) };
    expect(back).toMatchObject({ alt: "B|300", altLiteral: true });
    expect(imageWidthOf(back)).toBeNull();
  });

  it("an ordinary caption isn't marked", () => {
    expect(captionPatch({ alt: "" }, "A cat")).toEqual({ alt: "A cat", altLiteral: false });
    expect(captionPatch({ alt: "" }, "A | B")).toEqual({ alt: "A | B", altLiteral: false });
  });
});
