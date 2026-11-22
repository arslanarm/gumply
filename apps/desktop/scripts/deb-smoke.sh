#!/usr/bin/env bash
# #s96835xj: install the Linux .deb for real and check it runs **sandboxed** on
# a stock Ubuntu 23.10+ setting, then purge it. CI only (GitHub Actions, where
# the job has sudo); never on the swarm server (no sudo, by design).
#
# Why: on Ubuntu 23.10+ unprivileged user namespaces are restricted by
# AppArmor. The .deb's postinst installs a profile for /opt/Gumply/gumply that
# allows them, so Chromium's namespace sandbox works without --no-sandbox
# (#4ckqijua). An unpacked .deb or an AppImage can't show that; only a real
# install can.
#
# Usage: apps/desktop/scripts/deb-smoke.sh <release dir>
# Writes a table to $GITHUB_STEP_SUMMARY (or stdout) and the app's logs to
# $DEB_SMOKE_LOGS (default: a temp dir). Exits 1 if any check fails.
set -uo pipefail

RELEASE=${1:?usage: deb-smoke.sh <release dir>}
DEB=
for candidate in "$RELEASE"/Gumply-*-amd64.deb; do [ -f "$candidate" ] && DEB=$candidate && break; done
[ -n "$DEB" ] || { echo "no Gumply-*-amd64.deb in $RELEASE" >&2; exit 2; }
DEB=$(realpath "$DEB")
WORK=$(mktemp -d)
LOGS=${DEB_SMOKE_LOGS:-$WORK/logs}
mkdir -p "$LOGS" "$WORK/home/.config" "$WORK/run" "$WORK/vault"
chmod 700 "$WORK/run"
printf 'Hello from the .deb smoke test.\n' > "$WORK/vault/Welcome.md"
PORT=${DEB_SMOKE_PORT:-11120}
APP=/opt/Gumply/gumply
PROFILE=/etc/apparmor.d/gumply

ROWS=$WORK/rows.md
: > "$ROWS"
FAILS=0
row() { # status what detail
  printf '| %s | %s | %s |\n' "$1" "$2" "${3:-}" >> "$ROWS"
  printf '%-4s %s  %s\n' "$1" "$2" "${3:-}"
  [ "$1" = ok ] || FAILS=$((FAILS + 1))
}
check() { # what detail command...
  local what=$1 detail=$2
  shift 2
  if "$@"; then row ok "$what" "$detail"; else row FAIL "$what" "$detail"; fi
}

# A scratch session for the app: no real HOME, no Wayland, the job's own bus.
session_env() {
  env -u WAYLAND_DISPLAY -u DISPLAY \
    HOME="$WORK/home" XDG_CONFIG_HOME="$WORK/home/.config" XDG_RUNTIME_DIR="$WORK/run" \
    GUMPLY_DESKTOP_VAULT="$WORK/vault" GUMPLY_DESKTOP_PORT="$PORT" GUMPLY_DESKTOP_USER_DATA="$WORK/user-data" \
    "$@"
}
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"deb-smoke","version":"1"}}}'
mcp_initialize() { # binary -> stdout of the server (one initialize, then stdin closes after 8 s)
  { printf '%s\n' "$INIT"; sleep 8; } | session_env timeout 40 "$1" --mcp --ozone-platform=headless --vault "$WORK/vault"
}

# 1. A stock Ubuntu 23.10+ desktop: user namespaces restricted by AppArmor.
#    The runner may ship this as 0, which would make every check below pass
#    without the profile, so set it and record what it was.
before=$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo "absent")
sudo sysctl -qw kernel.apparmor_restrict_unprivileged_userns=1
now=$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo "absent")
check "user namespaces restricted, as on stock Ubuntu 23.10+" "apparmor_restrict_unprivileged_userns: $before → $now" test "$now" = 1
check "AppArmor enabled" "" aa-enabled -q
check "unprivileged 'unshare -Ur true' is refused (AppRun's probe)" "" bash -c '! unshare -Ur true 2>/dev/null'

# 2. Install for real.
# shellcheck disable=SC2024 # the log is the job user's, not root's
if sudo DEBIAN_FRONTEND=noninteractive apt-get install -y "$DEB" > "$LOGS/apt-install.log" 2>&1; then
  row ok "apt-get install" "$(basename "$DEB")"
else
  row FAIL "apt-get install" "see apt-install.log"
fi
check "AppArmor profile installed" "$PROFILE" test -f "$PROFILE"
check "profile names /opt/Gumply/gumply and allows userns" "" \
  bash -c "grep -q '\"/opt/Gumply/gumply\"' '$PROFILE' && grep -q 'userns,' '$PROFILE'"
check "profile loaded" "aa-status" bash -c "sudo aa-status 2>/dev/null | grep -qw gumply"
row ok "chrome-sandbox mode (recorded)" "$(stat -c '%a %U' /opt/Gumply/chrome-sandbox 2>/dev/null || echo missing)"

# 3. The GUI, sandboxed: no --no-sandbox anywhere, renderers in their own user namespace.
session_env xvfb-run -a dbus-run-session -- "$APP" --ozone-platform=x11 > "$LOGS/gui.log" 2>&1 &
GUI=$!
up=no
for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$PORT/api/health" > "$WORK/health.json"; then up=yes; break; fi
  sleep 1
done
check "GUI starts (/api/health)" "$(head -c 120 "$WORK/health.json" 2>/dev/null)" test "$up" = yes
# One line of space-separated PIDs (they're spliced into the bash -c checks below).
pids=$(pgrep -f "^$APP( |$)" | tr '\n' ' ' || true)
check "no gumply process has --no-sandbox" "$(wc -w <<< "$pids") processes" \
  bash -c "[ -n '${pids// /}' ] || exit 1; for p in $pids; do tr '\0' ' ' < /proc/\$p/cmdline | grep -q -- '--no-sandbox' && exit 1; done; exit 0"
renderer=$(for p in $pids; do tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null | grep -q -- '--type=renderer' && echo "$p" && break; done)
main=$(for p in $pids; do tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null | grep -q -- '--type=' || { echo "$p"; break; }; done)
check "a renderer runs in its own user namespace (the sandbox is on)" \
  "renderer $(readlink "/proc/$renderer/ns/user" 2>/dev/null) vs main $(readlink "/proc/$main/ns/user" 2>/dev/null)" \
  bash -c "[ -n '$renderer' ] && [ -n '$main' ] && [ \"\$(readlink /proc/$renderer/ns/user)\" != \"\$(readlink /proc/$main/ns/user)\" ]"
check "no sandbox abort in the log" "" bash -c "! grep -qE 'FATAL|SUID sandbox helper' '$LOGS/gui.log'"
for p in $pids; do kill "$p" 2>/dev/null; done
kill "$GUI" 2>/dev/null
wait "$GUI" 2>/dev/null

# 4. The AI apps (MCP) snippet, sandboxed and with no display.
mcp_initialize "$APP" > "$WORK/mcp.out" 2> "$LOGS/mcp.err"
check "--mcp answers initialize (sandboxed, no display)" "$(grep -o '"serverInfo":{[^}]*}' "$WORK/mcp.out")" \
  grep -q '"serverInfo":{"name":"gumply"' "$WORK/mcp.out"
check "--mcp: no sandbox abort" "" bash -c "! grep -qE 'FATAL|SUID sandbox helper' '$LOGS/mcp.err'"

# 5. Negative control: the same app outside /opt/Gumply has no profile and must
#    abort. This proves the profile (not the runner) makes 3 and 4 work.
cp -a /opt/Gumply "$WORK/copy"
mcp_initialize "$WORK/copy/gumply" > "$WORK/copy.out" 2> "$LOGS/copy.err"
check "control: a copy outside /opt/Gumply aborts on the sandbox" "" \
  bash -c "grep -qE 'setuid_sandbox_host|SUID sandbox helper' '$LOGS/copy.err' && ! grep -q serverInfo '$WORK/copy.out'"
rm -rf "$WORK/copy"

# 6. Purge: the profile file is removed and unloaded.
# shellcheck disable=SC2024 # the log is the job user's, not root's
if sudo DEBIAN_FRONTEND=noninteractive apt-get purge -y gumply > "$LOGS/apt-purge.log" 2>&1; then
  row ok "apt-get purge gumply" ""
else
  row FAIL "apt-get purge gumply" "see apt-purge.log"
fi
check "purge removes $PROFILE" "" test ! -e "$PROFILE"
check "purge unloads the profile" "" bash -c "! sudo aa-status 2>/dev/null | grep -qw gumply"

{
  echo "### Linux .deb: real install, sandboxed (#s96835xj)"
  echo
  echo "| | Check | Detail |"
  echo "|---|---|---|"
  cat "$ROWS"
  echo
} >> "${GITHUB_STEP_SUMMARY:-/dev/stdout}"
rm -rf "${WORK:?}/home" "${WORK:?}/run" "${WORK:?}/vault" "${WORK:?}/user-data"
[ "$FAILS" -eq 0 ] || { echo "$FAILS check(s) failed; logs in $LOGS" >&2; exit 1; }
echo "all checks passed"
