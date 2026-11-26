import { describe, expect, it } from "vitest";
import { parseBase, updateBaseSource, withSelectSettings } from "../src/bases/index.js";

/**
 * #bg7c9bzk (#faqr8pj9's #21): Obsidian 1.14.4 writes a .base's top-level keys in its own order (`filters`,
 * `formulas`, `properties`, then `views`) and rewrites a file just by opening it when `properties:` comes after
 * `views:`. So a key Gumply adds goes where Obsidian would put it; a file's existing order is never changed.
 */

const VIEWS_ONLY = "views:\n  - type: table\n    name: Table\n    order:\n      - file.name\n      - stage\n";

describe("a key Gumply adds to a .base goes in Obsidian's order (#bg7c9bzk)", () => {
  it("properties: (a Select) goes before views:, every other byte as it was", () => {
    const next = withSelectSettings(parseBase(VIEWS_ONLY), "stage", { kind: "select", options: [{ value: "Todo", color: "blue" }] });
    expect(updateBaseSource(VIEWS_ONLY, next)).toBe(
      "properties:\n  note.stage:\n    gumplyType: select\n    gumplyOptions:\n      - value: Todo\n        color: blue\n" + VIEWS_ONLY,
    );
  });

  it("formulas: goes after filters: and before properties: and views:", () => {
    const source = 'filters:\n  and:\n    - file.folder == "People"\nproperties:\n  note.role:\n    displayName: Role\n' + VIEWS_ONLY;
    const config = parseBase(source);
    const text = updateBaseSource(source, { ...config, formulas: { shout: 'role + "!"' } });
    expect(text).toBe('filters:\n  and:\n    - file.folder == "People"\nformulas:\n  shout: role + "!"\nproperties:\n  note.role:\n    displayName: Role\n' + VIEWS_ONLY);
  });

  it("a file already in another order keeps it (only a new key is placed)", () => {
    const source = VIEWS_ONLY + "properties:\n  note.stage:\n    displayName: Stage\n";
    const config = parseBase(source);
    const next = withSelectSettings(config, "stage", { kind: "select", options: [{ value: "Todo", color: "blue" }] });
    const text = updateBaseSource(source, next);
    expect(text.indexOf("views:")).toBeLessThan(text.indexOf("properties:"));
  });

  it("a comment above views: stays directly above it when properties: goes in before (@graph-dev)", () => {
    // Not on the file's first line (that would be the document's own comment): between two keys.
    const source = 'filters:\n  and:\n    - file.folder == "Books"\n# my views\n' + VIEWS_ONLY;
    const next = withSelectSettings(parseBase(source), "stage", { kind: "select", options: [{ value: "Todo", color: "blue" }] });
    const text = updateBaseSource(source, next);
    expect(text).toContain("# my views\nviews:\n");
    expect(text.indexOf("properties:")).toBeLessThan(text.indexOf("# my views"));
  });
});
