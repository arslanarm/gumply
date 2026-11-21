import { afterEach, describe, expect, it } from "vitest";
import { createApp, type UiLanguageStore } from "../src/app";
import { cleanupVaults, createTestServer } from "./helpers";

afterEach(cleanupVaults);

function languageStore(initial: string | null = null): UiLanguageStore & { saved: Array<string | null> } {
  let value = initial;
  const saved: Array<string | null> = [];
  return {
    languages: ["en", "ru"],
    saved,
    get: () => value,
    set: (next) => {
      value = next;
      saved.push(next);
    },
  };
}

const put = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "PUT",
  headers: { "Content-Type": "application/json", Host: "127.0.0.1:41234", ...headers },
  body: JSON.stringify(body),
});

describe("interface language in the desktop app (#7h5utv23)", () => {
  it("doesn't exist in the browser: no route, nothing in /api/health", async () => {
    const { app } = await createTestServer();
    const response = await app.request("/api/ui/language", put({ language: "ru" }));
    expect(response.status).toBe(404);
    const health = (await (await app.request("/api/health")).json()) as Record<string, unknown>;
    expect("uiLanguage" in health).toBe(false);
  });

  it("reports and stores the language when the desktop app provides the setting", async () => {
    const { store, dir } = await createTestServer();
    const setting = languageStore("ru");
    const app = createApp({ vaultPath: dir, store, uiLanguage: setting, security: { webPorts: [], apiPort: 41234 } });

    const health = (await (await app.request("/api/health", { headers: { Host: "127.0.0.1:41234" } })).json()) as Record<string, unknown>;
    expect(health.uiLanguage).toBe("ru");

    const response = await app.request("/api/ui/language", put({ language: "en" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ uiLanguage: "en" });
    // "system" (or null) means follow the OS.
    expect((await app.request("/api/ui/language", put({ language: "system" }))).status).toBe(200);
    expect(setting.saved).toEqual(["en", null]);
  });

  it("accepts only languages the app ships", async () => {
    const { store, dir } = await createTestServer();
    const setting = languageStore();
    const app = createApp({ vaultPath: dir, store, uiLanguage: setting, security: { webPorts: [], apiPort: 41234 } });
    for (const language of ["de", "", "../../x", 42, { code: "ru" }, "RU"]) {
      const response = await app.request("/api/ui/language", put({ language }));
      expect(response.status, JSON.stringify(language)).toBe(400);
    }
    expect((await app.request("/api/ui/language", { ...put({}), body: "not json" })).status).toBe(400);
    expect(setting.saved).toEqual([]);
  });

  it("is behind the local-only guards (foreign Host, foreign Origin)", async () => {
    const { store, dir } = await createTestServer();
    const setting = languageStore();
    const app = createApp({ vaultPath: dir, store, uiLanguage: setting, security: { webPorts: [], apiPort: 41234 } });
    const rebinding = await app.request("/api/ui/language", put({ language: "ru" }, { Host: "evil.example:41234" }));
    expect(rebinding.status).toBe(403);
    const csrf = await app.request("/api/ui/language", put({ language: "ru" }, { Origin: "https://evil.example" }));
    expect(csrf.status).toBe(403);
    expect(setting.saved).toEqual([]);
  });
});
