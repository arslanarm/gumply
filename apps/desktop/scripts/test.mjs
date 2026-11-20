// Run the desktop smoke tests (Playwright `_electron`) fully isolated from
// the user's session (team rule, wiki platform-issues P11):
// - Linux: a virtual X display (xvfb-run), WAYLAND_DISPLAY removed, so no
//   window can appear on the real desktop;
// - a private D-Bus with **no service directories**, so nothing (a file
//   manager for "reveal in folder", a portal, a keyring) can be auto-started
//   in the user's session;
// - the spec gives every Electron launch a scratch HOME and XDG_* dirs.
// Usage: npm run desktop:test   (builds first)
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const env = { ...process.env };
delete env.WAYLAND_DISPLAY;
delete env.DBUS_SESSION_BUS_ADDRESS;

const scratch = mkdtempSync(join(tmpdir(), "gumply-desktop-test-"));
let bus = null;

/** A session bus of our own that can't start any service. */
async function startPrivateBus() {
  const config = join(scratch, "session.conf");
  writeFileSync(
    config,
    `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:dir=${scratch}</listen>
  <auth>EXTERNAL</auth>
  <!-- No <servicedir>/<standard_session_servicedirs>: nothing can be activated. -->
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
`,
  );
  bus = spawn("dbus-daemon", [`--config-file=${config}`, "--nofork", "--print-address=1"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const address = await new Promise((resolve, reject) => {
    const lines = createInterface({ input: bus.stdout });
    lines.once("line", (line) => resolve(line.trim()));
    bus.once("error", reject);
    bus.once("exit", (code) => reject(new Error(`dbus-daemon exited (${code})`)));
  });
  return address;
}

let status = 1;
try {
  const linux = process.platform === "linux";
  const hasXvfb = linux && spawnSync("which", ["xvfb-run"]).status === 0;
  const hasBus = linux && spawnSync("which", ["dbus-daemon"]).status === 0;
  if (hasBus) env.GUMPLY_TEST_DBUS = await startPrivateBus();
  // The spec refuses to open windows on Linux unless both are in place.
  if (hasXvfb && hasBus) env.GUMPLY_DESKTOP_HEADLESS = "1";
  const playwright = ["npx", "playwright", "test", "--config", "apps/desktop/e2e/playwright.config.ts", ...process.argv.slice(2)];
  const command = hasXvfb ? ["xvfb-run", "-a", "-s", "-screen 0 1920x1080x24", ...playwright] : playwright;
  status = spawnSync(command[0], command.slice(1), { cwd: repo, env, stdio: "inherit" }).status ?? 1;
} finally {
  // Stop exactly the bus we started, then remove its scratch dir.
  if (bus && bus.exitCode === null) bus.kill();
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(status);
