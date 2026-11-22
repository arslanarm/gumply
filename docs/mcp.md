# Connect an AI app (MCP)

Gumply can let AI apps such as **Claude Code** and **Claude Desktop** search, read and (if you allow it) add to the notes in a vault, through the [Model Context Protocol](https://modelcontextprotocol.io). The AI app starts Gumply's MCP server on your computer and talks to it over stdin/stdout: there is no network port, and nothing leaves your machine except what the AI app itself sends to its model.

## Set it up

1. In Gumply, open **Settings → AI apps (MCP)…**.
2. Leave **Let AI apps use this vault** on, and choose what they may do (below).
3. Copy the snippet for your app. It already holds the full path to Gumply and to this vault.
   - **Claude Code:** paste the `claude mcp add …` line into a terminal. It's added for your user, so it works in every project. Check it with `claude mcp list` (it should say *Connected*).
   - **Claude Desktop:** add the block to `claude_desktop_config.json` (merge it into `"mcpServers"` if the file already has some), then **quit Claude Desktop completely** and open it again.
     - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
     - Windows: `%APPDATA%\Claude\claude_desktop_config.json`
     - Linux: `~/.config/Claude/claude_desktop_config.json`
4. Ask the AI app something about your notes ("What did I write about the Q3 plan?").

Each vault is its own entry (`gumply-<folder name>`): repeat the steps in each vault you want to share.

### What the snippet runs

AI apps start MCP servers **without your terminal's PATH or login shell**, so the snippets always use full paths:

| How you run Gumply | Command in the snippet |
|---|---|
| Linux AppImage | the `.AppImage` file itself, with `--mcp --ozone-platform=headless` (copy the snippet again if you move or rename the file) |
| Linux `.deb` | `/opt/Gumply/gumply --mcp --ozone-platform=headless` |
| Windows | `…\Programs\Gumply\Gumply.exe --mcp` |
| macOS | `/Applications/Gumply.app/Contents/MacOS/Gumply --mcp` (move Gumply to Applications first; a copy run from the disk image goes away) |
| Browser version, from source | the full path of `node` and of `apps/mcp/dist/gumply.mjs`, with `mcp` (build it once with `npm run build -w @gumply/mcp`) |

The desktop app in MCP mode opens no window and doesn't stop you from opening Gumply normally at the same time. On Linux, `--ozone-platform=headless` lets it start without a display (over SSH, on a headless machine). `gumply mcp --vault <folder>` works too (from the npm package, or `/usr/bin/gumply` from the `.deb`; add `--ozone-platform=headless` there if no display is available).

## What AI apps may do

| Setting | The AI app can |
|---|---|
| **Read only** (default) | search, read pages and boards, list pages and tags, follow links and backlinks |
| **Read and add** | also create pages, add text to the end of a page or a section, and add cards to boards. It never changes or removes what's already written. |
| **Read and edit** | also change and rename pages and move them to the Trash |

- **Every change can be undone.** Before each change Gumply keeps the previous version in `.gumply/history/`, pages go to the Trash (never deleted for good), and **Recent activity** in Settings lists every change with the app that made it.
- **Allowing more** (for example Read only → Read and add) takes effect when the AI app restarts its connection: in Claude Code start a new session, or run `/mcp` and reconnect; quit and reopen Claude Desktop.
- **Allowing less** or turning it off takes effect at once.
- **A note can't change the setting.** It's stored in the vault's `.gumply/mcp.json`, which AI apps can't read or write.
- **Why "Read and add" is the safer choice:** an AI app reads your notes, and a note can contain text written to trick it (a web clip, a shared document). With *Read and edit*, a fooled AI could change or trash pages one at a time: all of it can be undone, but keep *Read and add* unless you need more.

## Troubleshooting

| You see | What to do |
|---|---|
| `claude mcp list` says *Failed to connect*, or Claude Desktop shows the server as failed | Copy the snippet again from Settings (the path to Gumply or the vault changed). On Linux, an AppImage that was moved or renamed is the usual cause. |
| `spawn gumply ENOENT` / `command not found: gumply` | The snippet uses the bare `gumply` command, which the AI app can't find on its PATH. In the browser version, build the server (`npm run build -w @gumply/mcp`) and reopen Settings: the snippet then uses full paths. |
| `MCP is turned off for this vault` | Turn **Let AI apps use this vault** back on in Settings, then restart the AI app's connection. |
| `WRITES_DISABLED: Writing is turned off for this vault` | The vault is set to *Read only* (or writing was lowered). Choose *Read and add* or *Read and edit*, then restart the AI app's connection. |
| The AI app only offers reading tools | Same as above: the tools an AI app sees follow the setting when it connected. |
| `CONFLICT: … changed since it was read` | You (or another app) changed the page after the AI read it. Nothing was overwritten; the AI app should read it again. |
| `RATE_LIMITED` | More than 30 changes a minute (or 1,000 a day). Wait a moment. |
| Linux: `Missing X server or $DISPLAY` / `Failed to connect to Wayland display` | Copy the snippet again from Settings: it includes `--ozone-platform=headless`, so no display is needed. |
| Linux AppImage: nothing happens, or a FUSE error | The AppImage needs FUSE 2 (`libfuse2` on Ubuntu/Debian). Or install the `.deb`. |

Gumply's MCP server writes its own messages to stderr: Claude Code shows them with `claude --debug`, Claude Desktop in its MCP logs (`~/Library/Logs/Claude/` on macOS, `%APPDATA%\Claude\logs\` on Windows).

The full design (tools, limits, history layout) is in the project wiki's `spec/mcp`.
