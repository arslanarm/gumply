# Troubleshooting, and where your data lives

## Where your data lives

**Your notes are in your vault folder**, as plain files:

| In the vault | What it is |
|---|---|
| `*.md` | your pages; a page's sub-pages are in a folder with its name |
| `*.canvas` | your boards |
| `*.base` | your database views |
| `attachments/` | images and files you added |
| `.trash/` | pages you deleted, until you empty the Trash |
| `.gumply/history/` | [version history](version-history.md) |
| `.gumply/conflicts/` | backups made by **Keep mine**, so the other side of a conflict is never lost |
| `.gumply/types.json`, `graph.json` | property types (when there's no `.obsidian`) and graph settings |
| `.gumply/mcp.json`, `mcp-log.jsonl` | [AI apps](ai-apps.md) access, and what they did |
| `.obsidian/` | Obsidian's settings, which Gumply reads (and writes only a property type you change) |

**The desktop app's own settings** (your vaults list, window size, language and theme) are outside any vault:

- Linux: `~/.config/Gumply/gumply-desktop.json`
- Windows: `%APPDATA%\Gumply\gumply-desktop.json`
- macOS: `~/Library/Application Support/Gumply/gumply-desktop.json`

To back up your notes, back up the vault folder. To move to another computer, copy it.

## "This page changed on disk"

Another app (or another window of Gumply) changed the page while you had unsaved edits. Gumply never overwrites it without asking:

- **Reload** shows their version and drops your unsaved edits;
- **Keep mine** saves yours, and keeps theirs as a backup in `.gumply/conflicts/`.

Both sides are also in the page's [version history](version-history.md).

## A page I deleted

Look in **Trash** at the bottom of the sidebar. A page deleted in another app may have its last versions under **Trash → Earlier versions of deleted pages**.

## A conflicting copy appeared

Your sync tool kept both sides of an edit made on two devices. See [Sync with other apps](sync-with-other-apps.md).

## An AI app can't connect

See the troubleshooting section of [docs/mcp.md](../../mcp.md#troubleshooting). To see exactly what happens when an AI app starts Gumply, set `GUMPLY_MCP_TRACE=/path/to/trace.log` in the AI app's settings for Gumply; the file records each step.

## The app doesn't start

- **Linux AppImage:** it needs FUSE 3 (`fusermount`). On Ubuntu: `sudo apt install fuse3`. Settings → AI apps says so too if it's missing.
- **Windows and macOS:** the first start needs one confirmation, because the app isn't signed yet. See [Getting started](getting-started.md#install).

## Report a problem

Open an issue on [GitHub](https://github.com/arslanarm/gumply/issues). Say what you did, what you expected and what happened, with your system and Gumply's version (**Help → About Gumply**). Please don't attach notes you wouldn't want to be public: issues are public.
