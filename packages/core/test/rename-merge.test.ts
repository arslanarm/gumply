import { describe, expect, it } from "vitest";
import { mergeRenameLinks } from "../src/rename-merge.js";

/** N10 (#5pgmziyc): the rename's link changes, applied to a forced save only where the user didn't touch. */
describe("mergeRenameLinks", () => {
  const base = "Intro.\nSee [[Hub]] for more.\nNotes.\n";
  const theirs = "Intro.\nSee [[Hub 2]] for more.\nNotes.\n";

  it("typing on another line: the user's text and the rename's link", () => {
    const ours = "Intro, edited.\nSee [[Hub]] for more.\nNotes.\nA new line.\n";
    expect(mergeRenameLinks(base, theirs, ours)).toEqual({ content: "Intro, edited.\nSee [[Hub 2]] for more.\nNotes.\nA new line.\n", applied: 1 });
  });

  it("a [[Hub]] the user typed (a new line) is kept: it isn't the rename's", () => {
    const ours = "Intro.\nSee [[Hub]] for more.\nNotes.\nAbout the new one: [[Hub]].\n";
    expect(mergeRenameLinks(base, theirs, ours).content).toBe("Intro.\nSee [[Hub 2]] for more.\nNotes.\nAbout the new one: [[Hub]].\n");
  });

  it("the link line itself edited: the user's line wins", () => {
    const ours = "Intro.\nSee [[Hub]] for much more.\nNotes.\n";
    expect(mergeRenameLinks(base, theirs, ours)).toEqual({ content: ours, applied: 0 });
  });

  it("lines moved around: matched by text", () => {
    const ours = "Notes.\nSee [[Hub]] for more.\nIntro.\n";
    expect(mergeRenameLinks(base, theirs, ours).content).toBe("Notes.\nSee [[Hub 2]] for more.\nIntro.\n");
  });

  it("a repeated line: by order when the counts agree, untouched when they don't", () => {
    const b = "[[Hub]]\nx\n[[Hub]]\n";
    const t = "[[Hub 2]]\nx\n[[Hub 2]]\n";
    expect(mergeRenameLinks(b, t, "[[Hub]]\ny\n[[Hub]]\n").content).toBe("[[Hub 2]]\ny\n[[Hub 2]]\n");
    // The user added a third copy: which ones were the rename's is ambiguous, so none is changed.
    const three = "[[Hub]]\n[[Hub]]\nx\n[[Hub]]\n";
    expect(mergeRenameLinks(b, t, three)).toEqual({ content: three, applied: 0 });
  });

  it("not a rename's change (the line count differs), or nothing changed: ours as sent", () => {
    expect(mergeRenameLinks(base, "Other\ntext", "Mine.").content).toBe("Mine.");
    expect(mergeRenameLinks(base, base, "Mine.\n").content).toBe("Mine.\n");
  });

  it("CRLF lines and a missing final newline keep their bytes", () => {
    const b = "A\r\nSee [[Hub]].\r\nB";
    const t = "A\r\nSee [[Hub 2]].\r\nB";
    expect(mergeRenameLinks(b, t, "A edited\r\nSee [[Hub]].\r\nB").content).toBe("A edited\r\nSee [[Hub 2]].\r\nB");
  });
});
