import { describe, expect, it } from "vitest";
import { hasWikilink, splitWikilinks } from "../src/components/PropertyLinks.js";

describe("[[links]] in property values (#vc4hivrr)", () => {
  it("cuts a value at its links: target, heading and label", () => {
    expect(splitWikilinks("[[Project A]]")).toEqual([{ kind: "link", target: "Project A", heading: "", label: "Project A" }]);
    expect(splitWikilinks("See [[Plan#Goals|the goals]] and [[cover-a.png]].")).toEqual([
      { kind: "text", text: "See " },
      { kind: "link", target: "Plan", heading: "Goals", label: "the goals" },
      { kind: "text", text: " and " },
      { kind: "link", target: "cover-a.png", heading: "", label: "cover-a.png" },
      { kind: "text", text: "." },
    ]);
  });

  it("leaves text that isn't a link alone, as the editor does", () => {
    expect(splitWikilinks("plain")).toEqual([{ kind: "text", text: "plain" }]);
    expect(splitWikilinks("[[]] and [[ ]]")).toEqual([{ kind: "text", text: "[[]] and [[ ]]" }]);
    expect(splitWikilinks("[[a\nb]]")).toEqual([{ kind: "text", text: "[[a\nb]]" }]);
    expect(splitWikilinks("[[open")).toEqual([{ kind: "text", text: "[[open" }]);
    // A stray bracket before a real link: the link is still found.
    expect(splitWikilinks("[[[Page]]")).toEqual([
      { kind: "text", text: "[" },
      { kind: "link", target: "Page", heading: "", label: "Page" },
    ]);
    expect(hasWikilink("no links [here]")).toBe(false);
    expect(hasWikilink("a [[Link]]")).toBe(true);
  });
});
