import { describe, expect, it } from "vitest";
import { ApiRequestError } from "../src/api/client.js";
import { errorMessage, SERVER_DOWN_MESSAGE } from "../src/lib/errors.js";

describe("errorMessage", () => {
  it("hides raw 5xx status text behind the server-down copy", () => {
    expect(errorMessage(new ApiRequestError(500, "Internal Server Error"))).toBe(
      SERVER_DOWN_MESSAGE,
    );
    expect(errorMessage(new ApiRequestError(502, "Bad Gateway"))).toBe(SERVER_DOWN_MESSAGE);
  });

  it("keeps client error messages that are meant for the user", () => {
    expect(errorMessage(new ApiRequestError(404, "Page not found"))).toBe("Page not found");
    expect(errorMessage(new ApiRequestError(409, "A page with that title already exists."))).toBe(
      "A page with that title already exists.",
    );
  });

  it("treats network failures as the server being down", () => {
    expect(errorMessage(new TypeError("Failed to fetch"))).toBe(SERVER_DOWN_MESSAGE);
    expect(errorMessage(new Error("network error"))).toBe(SERVER_DOWN_MESSAGE);
  });

  it("has a generic fallback for non-errors", () => {
    expect(errorMessage("boom")).toBe("Something went wrong.");
    expect(errorMessage(null)).toBe("Something went wrong.");
  });
});
