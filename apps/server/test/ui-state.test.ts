import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { applyUiStateChange, normaliseUiState, type UiState, type UiStateStore } from "../src/ui-state";
import { cleanupVaults, createTestServer, jsonRequest } from "./helpers";

afterEach(cleanupVaults);

function memoryStore(initial: UiState = {}): UiStateStore & { state: UiState } {
  const store = {
    state: initial,
    get: () => store.state,
    update: (change: Parameters<UiStateStore["update"]>[0]) => (store.state = applyUiStateChange(store.state, change)),
  };
  return store;
}

describe("GET/PUT /api/ui/state (#c7fzzxk8)", () => {
  it("doesn't exist in the browser app", async () => {
    const { app } = await createTestServer();
    expect((await app.request("/api/ui/state")).status).toBe(404);
    expect((await jsonRequest(app, "PUT", "/api/ui/state", { set: { "gumply:theme": "dark" } })).status).toBe(404);
  });

  it("serves and updates the desktop app's preferences", async () => {
    const { store, dir } = await createTestServer();
    const ui = memoryStore({ "gumply:theme": "dark" });
    const app = createApp({ vaultPath: dir, store, uiState: ui });
    expect(await (await app.request("/api/ui/state")).json()).toEqual({ "gumply:theme": "dark" });
    const response = await jsonRequest(app, "PUT", "/api/ui/state", {
      set: { "gumply:sidebar": "closed", "gumply:board-view:Trip.canvas": '{"x":1,"y":2,"zoom":1}' },
      remove: ["gumply:theme"],
    });
    expect(response.status).toBe(200);
    expect(ui.state).toEqual({ "gumply:sidebar": "closed", "gumply:board-view:Trip.canvas": '{"x":1,"y":2,"zoom":1}' });
  });

  it("accepts only gumply:* keys with string values of a sane size", async () => {
    const { store, dir } = await createTestServer();
    const ui = memoryStore();
    const app = createApp({ vaultPath: dir, store, uiState: ui });
    for (const body of [
      { set: { theme: "dark" } },
      { set: { "gumply:": "x" } },
      { set: { "gumply:x\n": "x" } },
      { set: { "gumply:theme": 1 } },
      { set: { "gumply:big": "x".repeat(64 * 1024 + 1) } },
      { remove: ["other"] },
      { set: [] },
      [],
      "nope",
    ]) {
      expect((await jsonRequest(app, "PUT", "/api/ui/state", body)).status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
    expect(ui.state).toEqual({});
  });

  it("stays under the size cap by dropping the entries written longest ago", () => {
    let state: UiState = {};
    for (let index = 0; index < 10; index += 1) {
      state = applyUiStateChange(state, { set: { [`gumply:board-view:${index}`]: "x".repeat(100) } }, 600);
    }
    // Each entry is ~119 characters: the newest five fit in 600.
    expect(Object.keys(state)).toEqual(["gumply:board-view:5", "gumply:board-view:6", "gumply:board-view:7", "gumply:board-view:8", "gumply:board-view:9"]);
    // Rewriting a key makes it the newest.
    state = applyUiStateChange(state, { set: { "gumply:board-view:6": "y" } }, 600);
    expect(Object.keys(state).at(-1)).toBe("gumply:board-view:6");
  });

  it("a damaged settings file gives an empty or cleaned state", () => {
    expect(normaliseUiState(null)).toEqual({});
    expect(normaliseUiState([1, 2])).toEqual({});
    expect(normaliseUiState({ "gumply:theme": "dark", other: "x", "gumply:n": 3 })).toEqual({ "gumply:theme": "dark" });
  });
});
