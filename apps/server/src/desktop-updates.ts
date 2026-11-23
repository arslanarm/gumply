/**
 * `/api/desktop/updates` (spec/auto-update §9, D42): the desktop app's
 * Settings → Updates and update notice. Mounted only when the desktop app
 * passes its update controller; the browser build and development runs
 * answer 404. Behind the same local-only guard as every `/api` route.
 *
 * - `GET /api/desktop/updates`: the state.
 * - `POST /api/desktop/updates/check`: check now (also when updates are off:
 *   it's the user asking); answers with the state after the check.
 * - `PUT /api/desktop/updates/settings` `{ mode }`: automatic / notify / off.
 * - `POST /api/desktop/updates/restart`: "Restart now": the app quits through
 *   its normal path (save flush first), installs, and starts again.
 */
import { isUpdateMode, type DesktopUpdatesState, type UpdateMode } from "@gumply/core";
import { Hono } from "hono";
import { badRequest } from "./errors.js";

/** What the desktop app hands the server (its update controller, adapted). */
export interface DesktopUpdates {
  get(): DesktopUpdatesState;
  check(): Promise<DesktopUpdatesState>;
  setMode(mode: UpdateMode): DesktopUpdatesState;
  /** Called after the response is sent. */
  restart(): void;
}

export function desktopUpdatesRoutes(updates: DesktopUpdates): Hono {
  const routes = new Hono();
  routes.get("/", (c) => c.json(updates.get()));
  routes.post("/check", async (c) => c.json(await updates.check()));
  routes.put("/settings", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw badRequest("Expected JSON");
    }
    const mode = (body as { mode?: unknown } | null)?.mode;
    if (!isUpdateMode(mode)) throw badRequest("mode must be auto, notify or off");
    if (!updates.get().modes.includes(mode)) throw badRequest(`mode ${mode} isn't offered for this install`);
    return c.json(updates.setMode(mode));
  });
  routes.post("/restart", (c) => {
    // After the response: the quit closes this server.
    setTimeout(() => updates.restart(), 50);
    return c.json({ ok: true }, 202);
  });
  return routes;
}
