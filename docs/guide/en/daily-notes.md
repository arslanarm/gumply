# Daily notes

A daily note is one page per day, for a journal, a log or a to-do list.

## Open today's note

- **Today** in the sidebar;
- `Ctrl/Cmd+Shift+D`;
- search (`Ctrl/Cmd+K`) → **Open today's note**.

If today's note doesn't exist yet, Gumply creates it. The arrows next to its title open the previous and the next daily note.

## Where they go and what's in them

Gumply uses the settings of Obsidian's Daily notes plugin, so a vault you also open in Obsidian gets the same notes in the same place:

- **folder:** the vault's top level, unless a folder is set;
- **name:** the date, as `YYYY-MM-DD` (e.g. `2026-11-23`) unless another format is set;
- **template:** a new daily note starts from the template set there, if any, with `{{date}}`, `{{time}}` and `{{title}}` filled in.

To change them, open the vault in Obsidian and change the Daily notes settings, or edit `.obsidian/daily-notes.json`.

## Good to know

- A daily note is an ordinary page: link to it (`[[2026-11-23]]`), tag it, give it properties.
- Daily notes have [version history](version-history.md) like any page.
