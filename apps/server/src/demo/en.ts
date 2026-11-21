/** English demo vault copy (#93yv3ban). The fallback for every other language. */
import type { DemoCopy } from "./types.js";

export const en: DemoCopy = {
  welcome: "Welcome",
  folder: "Gumply demo",
  gettingStarted: "Getting started",
  graphView: "Graph view",
  board: "Project map",
  welcomeBody: ({ gettingStarted, graphView, boardLink }) =>
    [
      // No H1 here: the page title already heads the page.
      "Gumply is a quiet place for notes: simple blocks, no clutter.",
      "",
      "Your notes are plain Markdown files on your computer.",
      "",
      "## A tiny cheat sheet",
      "",
      "- Type `/` for commands.",
      "- Type `[[` to link a page.",
      "- Press Cmd/Ctrl+K to find anything.",
      "",
      `[[${gettingStarted}]] · [[${graphView}]]`,
      "",
      `Plan visually on a whiteboard: ${boardLink}`,
      "",
      "## Try it",
      "",
      "- [ ] Create your first page",
      "- [ ] Link two pages together",
      "",
    ].join("\n"),
  folderBody: "Small examples you can ignore or delete whenever you like.\n",
  gettingStartedBody: ({ welcome, gettingStarted }) =>
    [
      `# ${gettingStarted}`,
      "",
      "Create a page with **New page** in the sidebar. Hover a row to add a **New sub-page**.",
      "",
      "- `/` opens the block menu.",
      "- `[[` links to another page.",
      "- Everything saves automatically — there is no save button.",
      "",
      `Back to [[${welcome}]].`,
      "",
    ].join("\n"),
  graphViewBody: ({ welcome, gettingStarted, graphView }) =>
    [
      `# ${graphView}`,
      "",
      "The graph shows every page as a dot and every link as a line.",
      "",
      `Back to [[${welcome}]], or read [[${gettingStarted}]].`,
      "",
    ].join("\n"),
  boardFrame: "Start with these pages",
  boardSticky: "Start here: double-click to add a sticky",
  boardArrow: "read next",
};
