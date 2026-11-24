import { describe, expect, it } from "vitest";
import { parseRenames } from "../src/api/client.js";

/** spec/api v1.35 (#xgnvipyd): `X-Gumply-Renaming`, the renames still rewriting their links. */
describe("parseRenames", () => {
  it("reads the percent-encoded JSON list, in any script", () => {
    const list = [{ fromTitle: "Заметки", fromId: "Projects/Заметки", to: "Projects/Записи" }];
    expect(parseRenames(encodeURIComponent(JSON.stringify(list)))).toEqual(list);
  });

  it("no header, malformed JSON, a non-list or bad items: no renames", () => {
    expect(parseRenames(null)).toEqual([]);
    expect(parseRenames("%7Bnot json")).toEqual([]);
    expect(parseRenames(encodeURIComponent('{"fromTitle":"A"}'))).toEqual([]);
    expect(parseRenames(encodeURIComponent('[{"fromTitle":1,"fromId":"A","to":"B"},{"fromTitle":"C","fromId":"C","to":"D"}]'))).toEqual([
      { fromTitle: "C", fromId: "C", to: "D" },
    ]);
  });
});
