import { describe, expect, it } from "vitest";
import { conflictCopyOf, possibleCopyOf, sharedRatio } from "../src/sync-conflicts";

/** spec/sync-conflicts §1.1, §3, §11 (D43). */

describe("conflictCopyOf: certain copies, by name", () => {
  const recognised: Array<[string, ReturnType<typeof conflictCopyOf>]> = [
    ["Note.sync-conflict-20261122-143005-ABCDEFG.md", { tool: "syncthing", originalName: "Note.md", device: "ABCDEFG", at: "2026-11-22T14:30:05" }],
    ["Board.sync-conflict-20261122-143005-A2C4E6G.canvas", { tool: "syncthing", originalName: "Board.canvas", device: "A2C4E6G", at: "2026-11-22T14:30:05" }],
    ["Tasks.sync-conflict-20261122-143005-ABCDEFG.base", { tool: "syncthing", originalName: "Tasks.base", device: "ABCDEFG", at: "2026-11-22T14:30:05" }],
    ["photo.sync-conflict-20261122-143005-ABCDEFG.png", { tool: "syncthing", originalName: "photo.png", device: "ABCDEFG", at: "2026-11-22T14:30:05" }],
    ["archive.tar.sync-conflict-20261122-143005-ABCDEFG.gz", { tool: "syncthing", originalName: "archive.tar.gz", device: "ABCDEFG", at: "2026-11-22T14:30:05" }],
    ["README.sync-conflict-20261122-143005-ABCDEFG", { tool: "syncthing", originalName: "README", device: "ABCDEFG", at: "2026-11-22T14:30:05" }],
    ["Note (conflicted copy 2026-11-22 143005).md", { tool: "nextcloud", originalName: "Note.md", at: "2026-11-22T14:30:05" }],
    ["Note (conflicted copy ann 2026-11-22 143005).md", { tool: "nextcloud", originalName: "Note.md", device: "ann", at: "2026-11-22T14:30:05" }],
    ["Note_conflict-20261122-143005.md", { tool: "nextcloud", originalName: "Note.md", at: "2026-11-22T14:30:05" }],
    ["Meeting notes (Conflicted copy MyMacBook2 202611221430).md", { tool: "obsidian", originalName: "Meeting notes.md", device: "MyMacBook2", at: "2026-11-22T14:30" }],
    ["Note (Ann's conflicted copy 2026-11-22).md", { tool: "dropbox", originalName: "Note.md", device: "Ann", at: "2026-11-22" }],
    ["Note (LAPTOP-7X's conflicted copy 2026-11-22).md", { tool: "dropbox", originalName: "Note.md", device: "LAPTOP-7X", at: "2026-11-22" }],
    ["Note (DESKTOP-XXXXX's Conflicted copy 2026-02-21).md", { tool: "dropbox", originalName: "Note.md", device: "DESKTOP-XXXXX", at: "2026-02-21" }],
    ["Note (Ann Lee’s conflicted copy 2026-11-22).md", { tool: "dropbox", originalName: "Note.md", device: "Ann Lee", at: "2026-11-22" }],
    ["Заметка (Аня's conflicted copy 2026-11-22).md", { tool: "dropbox", originalName: "Заметка.md", device: "Аня", at: "2026-11-22" }],
    ["Note (Ann's conflicted copy 2026-11-22) (1).md", { tool: "dropbox", originalName: "Note.md", device: "Ann", at: "2026-11-22" }],
    ["Q1 plan (v2) (Ann's conflicted copy 2026-11-22).md", { tool: "dropbox", originalName: "Q1 plan (v2).md", device: "Ann", at: "2026-11-22" }],
  ];
  for (const [name, expected] of recognised) {
    it(name, () => expect(conflictCopyOf(name)).toEqual(expected));
  }

  const notCopies = [
    "Note 2.md",
    "Meeting (1).md",
    "Report-Final.md",
    "My conflicted copy notes.md",
    "x.sync-conflict.md",
    "Note.sync-conflict-2026-1122-ABCDEFG.md",
    "Note.sync-conflict-20261122-143005-abcdefg.md",
    "Note.sync-conflict-20261122-143005-ABCDEF.md",
    ".Note.sync-conflict-20261122-143005-ABCDEFG.md",
    ".syncthing.Note.md.tmp",
    "Note (conflicted copy).md",
    "(Ann's conflicted copy 2026-11-22).md",
    "Note.md",
  ];
  for (const name of notCopies) {
    it(`not: ${name}`, () => expect(conflictCopyOf(name)).toBeNull());
  }
});

describe("conflictCopyOf: a cloud drive's `(копия с компьютера X)` copies (#f5n87bfd)", () => {
  // Seen in a real vault (a cloud drive's Russian desktop client, very likely Yandex Disk; its public docs
  // only show `document (2).docx`). The further copies of one conflict get ` (n)`.
  const recognised: Array<[string, ReturnType<typeof conflictCopyOf>]> = [
    ["План сада (копия с компьютера LAPTOP-RU).md", { tool: "cloud", originalName: "План сада.md", device: "LAPTOP-RU" }],
    ["Note (копия с компьютера LAPTOP-RU) (2).md", { tool: "cloud", originalName: "Note.md", device: "LAPTOP-RU" }],
    ["Note (копия с компьютера LAPTOP-RU) (4).md", { tool: "cloud", originalName: "Note.md", device: "LAPTOP-RU" }],
    ["Map (копия с компьютера DESKTOP-7Q2).canvas", { tool: "cloud", originalName: "Map.canvas", device: "DESKTOP-7Q2" }],
    ["Tasks (копия с компьютера Мой ноутбук).base", { tool: "cloud", originalName: "Tasks.base", device: "Мой ноутбук" }],
    ["photo (копия с компьютера PC).png", { tool: "cloud", originalName: "photo.png", device: "PC" }],
  ];
  for (const [name, expected] of recognised) {
    it(name, () => expect(conflictCopyOf(name)).toEqual(expected));
  }
  it("is a certain copy, so never also a possible one", () => {
    expect(possibleCopyOf("Note (копия с компьютера LAPTOP-RU) (2).md")).toBeNull();
  });
  for (const name of ["(копия с компьютера X).md", "Note копия с компьютера X.md", "Note (копия с компьютера ).md", "Note (копия).md"]) {
    it(`not: ${name}`, () => expect(conflictCopyOf(name)).toBeNull());
  }
});

describe("possibleCopyOf: names that might be iCloud / Google Drive / OneDrive copies", () => {
  it("recognises the three forms, before the extension", () => {
    expect(possibleCopyOf("Note 2.md")).toEqual({ form: "number", originalName: "Note.md" });
    expect(possibleCopyOf("Note 12.md")).toEqual({ form: "number", originalName: "Note.md" });
    expect(possibleCopyOf("Note (1).md")).toEqual({ form: "paren", originalName: "Note.md" });
    expect(possibleCopyOf("Note-LAPTOP.md")).toEqual({ form: "device", originalName: "Note.md" });
    expect(possibleCopyOf("Board 2.canvas")).toEqual({ form: "number", originalName: "Board.canvas" });
  });

  it("never a certain copy, a dot-name, a ` 1` or ` 0`, or a name with nothing before the suffix", () => {
    expect(possibleCopyOf("Note.sync-conflict-20261122-143005-ABCDEFG.md")).toBeNull();
    expect(possibleCopyOf(".Note 2.md")).toBeNull();
    expect(possibleCopyOf("Note 1.md")).toBeNull();
    expect(possibleCopyOf("Note 0.md")).toBeNull();
    expect(possibleCopyOf("Note.md")).toBeNull();
    expect(possibleCopyOf("-PC.md")).toBeNull();
  });
});

describe("sharedRatio", () => {
  it("counts shared non-blank lines over the larger side", () => {
    expect(sharedRatio(["a", "b", "c", "", "d", "e"], ["a", "b", "c", "x", "y"])).toBeCloseTo(3 / 5);
    expect(sharedRatio(["a", "a"], ["a"])).toBeCloseTo(1 / 2);
    expect(sharedRatio([], [])).toBe(0);
    expect(sharedRatio(["a"], ["a"])).toBe(1);
  });

  it("the 60% boundary", () => {
    const original = ["1", "2", "3", "4", "5"];
    expect(sharedRatio(original, ["1", "2", "3", "x", "y"])).toBeCloseTo(0.6);
    expect(sharedRatio(original, ["1", "2", "x", "y", "z"])).toBeCloseTo(0.4);
  });
});
