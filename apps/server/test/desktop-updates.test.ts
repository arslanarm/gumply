import type { DesktopUpdatesState, UpdateMode } from "@gumply/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import type { DesktopUpdates } from "../src/desktop-updates";
import { cleanupVaults, createTestServer, jsonRequest } from "./helpers";

/** spec/auto-update §9 (#a7qepp99): the desktop app's update routes. */

afterEach(cleanupVaults);

function fakeUpdates(kind: DesktopUpdatesState["kind"] = "nsis") {
  const state: DesktopUpdatesState = {
    kind,
    mode: kind === "nsis" ? "auto" : "notify",
    modes: kind === "nsis" ? ["auto", "notify", "off"] : ["notify", "off"],
    status: "idle",
    currentVersion: "0.9.0",
    version: null,
    releaseUrl: null,
    lastChecked: null,
    error: null,
  };
  const updates = {
    state,
    get: () => ({ ...state }),
    check: vi.fn(async () => {
      state.status = "up-to-date";
      state.lastChecked = "2026-11-23T10:00:00.000Z";
      return { ...state };
    }),
    setMode: vi.fn((mode: UpdateMode) => {
      state.mode = mode;
      return { ...state };
    }),
    restart: vi.fn(),
  };
  return updates satisfies DesktopUpdates;
}

describe("/api/desktop/updates", () => {
  it("doesn't exist in the browser app", async () => {
    const { app } = await createTestServer();
    expect((await app.request("/api/desktop/updates")).status).toBe(404);
    expect((await jsonRequest(app, "POST", "/api/desktop/updates/check", {})).status).toBe(404);
  });

  it("reports, checks and changes the mode", async () => {
    const { store, dir } = await createTestServer();
    const updates = fakeUpdates();
    const app = createApp({ vaultPath: dir, store, updates });
    expect(await (await app.request("/api/desktop/updates")).json()).toMatchObject({ kind: "nsis", mode: "auto", status: "idle" });
    const checked = await jsonRequest(app, "POST", "/api/desktop/updates/check", {});
    expect(await checked.json()).toMatchObject({ status: "up-to-date", lastChecked: "2026-11-23T10:00:00.000Z" });
    const changed = await jsonRequest(app, "PUT", "/api/desktop/updates/settings", { mode: "off" });
    expect(changed.status).toBe(200);
    expect(updates.setMode).toHaveBeenCalledWith("off");
  });

  it("refuses a mode that isn't a mode, or isn't offered here (no automatic install on macOS/.deb)", async () => {
    const { store, dir } = await createTestServer();
    const updates = fakeUpdates("mac");
    const app = createApp({ vaultPath: dir, store, updates });
    expect((await jsonRequest(app, "PUT", "/api/desktop/updates/settings", { mode: "sometimes" })).status).toBe(400);
    expect((await jsonRequest(app, "PUT", "/api/desktop/updates/settings", { mode: "auto" })).status).toBe(400);
    expect(updates.setMode).not.toHaveBeenCalled();
  });

  it("restart answers first, then asks the app to quit", async () => {
    vi.useFakeTimers();
    try {
      const { store, dir } = await createTestServer();
      const updates = fakeUpdates();
      const app = createApp({ vaultPath: dir, store, updates });
      const response = await jsonRequest(app, "POST", "/api/desktop/updates/restart", {});
      expect(response.status).toBe(202);
      expect(updates.restart).not.toHaveBeenCalled();
      vi.advanceTimersByTime(100);
      expect(updates.restart).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
