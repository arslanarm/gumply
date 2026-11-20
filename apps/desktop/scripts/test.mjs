// Run the desktop smoke tests (Playwright `_electron`). On Linux they run on a
// virtual X display (xvfb-run) so no window opens on your desktop.
// Usage: npm run desktop:test   (builds first)
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const env = { ...process.env };
delete env.WAYLAND_DISPLAY;
const playwright = ["npx", "playwright", "test", "--config", "apps/desktop/e2e/playwright.config.ts", ...process.argv.slice(2)];
const hasXvfb = process.platform === "linux" && spawnSync("which", ["xvfb-run"]).status === 0;
// The spec refuses to open windows on Linux unless it runs on the virtual display.
if (hasXvfb) env.GUMPLY_DESKTOP_HEADLESS = "1";
const command = hasXvfb ? ["xvfb-run", "-a", "-s", "-screen 0 1920x1080x24", ...playwright] : playwright;
const result = spawnSync(command[0], command.slice(1), { cwd: repo, env, stdio: "inherit" });
process.exit(result.status ?? 1);
