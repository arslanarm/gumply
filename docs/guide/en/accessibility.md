# Accessibility

Gumply is meant to work with the keyboard alone, with a screen reader, and at large text sizes.

## Use it from the keyboard

- **Search and commands:** `Ctrl/Cmd+K` opens pages and runs commands (today's note, templates, history, export, conflicts, language). A page opened from it gets the cursor straight away, where you left it.
- **Shortcuts:** `?` lists them all. See [Settings and keyboard shortcuts](settings-and-shortcuts.md).
- **Sidebar:** the page list is a single `Tab` stop. Inside it, `↑`/`↓` move between rows, `→` opens a row's sub-pages (or goes into them) and `←` closes them (or goes up to the parent), `Home`/`End` jump to the first and last row, and typing the first letters of a title jumps to it. `Enter` opens a row, `F2` renames it, and `Shift+F10` or the menu key opens its menu, which also has **New sub-page** (**New page inside** for a folder). In the menu, the arrow keys move between items.
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
