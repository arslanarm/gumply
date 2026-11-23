import { describe, expect, it } from "vitest";
import { pageLeaveTracker } from "../src/lib/page-leave";

describe("leaving a page ends its editing session (D41, #fr5baurg)", () => {
  it("opening a page never ends a session, however often the effect runs (StrictMode mounts it twice)", () => {
    const left: string[] = [];
    const track = pageLeaveTracker((id) => left.push(id));
    track("Board.canvas");
    track("Board.canvas");
    track("Board.canvas");
    expect(left).toEqual([]);
  });

  it("switching pages ends the session of the page that was left, once", () => {
    const left: string[] = [];
    const track = pageLeaveTracker((id) => left.push(id));
    track("A");
    track("B");
    track("B");
    track(null); // the graph or the Trash
    track("A");
    expect(left).toEqual(["A", "B"]);
  });
});
