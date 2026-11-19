import { describe, expect, it } from "vitest";
import { taskCheckboxLabel } from "../src/lib/task.js";

describe("taskCheckboxLabel", () => {
  it("names the to-do and the action", () => {
    expect(taskCheckboxLabel("Buy milk", false)).toBe("Mark “Buy milk” as done");
    expect(taskCheckboxLabel("Buy milk", true)).toBe("Mark “Buy milk” as not done");
  });

  it("trims the item text", () => {
    expect(taskCheckboxLabel("  call the bank  ", false)).toBe("Mark “call the bank” as done");
  });

  it("still describes the action for an empty to-do", () => {
    expect(taskCheckboxLabel("", false)).toBe("Mark to-do as done");
    expect(taskCheckboxLabel("   ", true)).toBe("Mark to-do as not done");
  });
});
