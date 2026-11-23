# Accessibility

Gumply is meant to work with the keyboard alone, with a screen reader, and at large text sizes.

## Use it from the keyboard

- **Search and commands:** `Ctrl/Cmd+K` opens pages and runs commands (today's note, templates, history, export, conflicts, language).
- **Shortcuts:** `?` lists them all. See [Settings and keyboard shortcuts](settings-and-shortcuts.md).
- **Sidebar:** move between rows with `Tab`, open a row with `Enter`, rename it with `F2`, and open its menu with `Shift+F10` or the menu key. In the menu, the arrow keys move between items.
- **Pages:** everything in the editor has a key: blocks with `/`, links with `[[`, moving blocks with `Ctrl/Cmd+Shift+↑/↓`.
- **Boards:** `Tab` goes from object to object, `Enter` edits, arrows move, and a tool's key plus `Enter` adds an object. See [Boards](boards.md#use-a-board-from-the-keyboard).
- **Dialogs** keep the keyboard inside them while open, start on their first control, close with `Esc`, and put focus back where it was.

## Screen readers

- Buttons are named by what they do; tooltips aren't read into the name.
- The `/`, `[[` and `:` emoji menus, and a board card's `[[` suggestions, announce the option you're on as you move through them.
- On a board, selecting, moving, adding and deleting objects is announced.
- Version history marks added and removed lines with **+** and **−**, not by colour alone, and a board's changes come with a list of the cards.

We test with automated checks and the keyboard. If something doesn't work with your screen reader, please [tell us](troubleshooting.md#report-a-problem).

## Seeing it clearly

- Text meets a 4.5:1 contrast ratio in the light and dark themes.
- The app works at 200% zoom (`Ctrl/Cmd` + `+`): toolbars and menus stay usable.
- Gumply follows your system's **reduce motion** setting.
