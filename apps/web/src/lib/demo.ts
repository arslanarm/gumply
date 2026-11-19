/**
 * Demo vault seeded once on a truly empty first run (D10, spec/ux §2).
 * Contents are fixed so tests can rely on the copy.
 */
import { childPageId } from "@gumply/core";

export const WELCOME_TITLE = "Welcome";
export const DEMO_FOLDER_TITLE = "Gumply demo";
export const DEMO_SEEDED_KEY = "gumply:demo-seeded";
/** Tests/manual runs can set this to "1" to start on an empty vault. */
export const DEMO_DISABLED_KEY = "gumply:demo-disabled";
/** Automation skips seeding (so e2e keeps a predictable empty vault) unless forced. */
export const DEMO_FORCE_KEY = "gumply:demo-force";

export interface DemoPage {
  title: string;
  parentId: string | null;
  content: string;
  icon?: string;
}

export function buildDemoPages(): DemoPage[] {
  const folderId = childPageId(null, DEMO_FOLDER_TITLE);

  return [
    {
      title: WELCOME_TITLE,
      icon: "👋",
      parentId: null,
      content: [
        "# Welcome to Gumply",
        "",
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
        "[[Getting started]] · [[Graph view]]",
        "",
        "## Try it",
        "",
        "- [ ] Create your first page",
        "- [ ] Link two pages together",
        "",
      ].join("\n"),
    },
    {
      title: DEMO_FOLDER_TITLE,
      icon: "📁",
      parentId: null,
      content: "Small examples you can ignore or delete whenever you like.\n",
    },
    {
      title: "Getting started",
      icon: "📝",
      parentId: folderId,
      content: [
        "# Getting started",
        "",
        "Create a page with **New page** in the sidebar. Hover a row to add a **New sub-page**.",
        "",
        "- `/` opens the block menu.",
        "- `[[` links to another page.",
        "- Everything saves automatically — there is no save button.",
        "",
        "Back to [[Welcome]].",
        "",
      ].join("\n"),
    },
    {
      title: "Graph view",
      icon: "🕸️",
      parentId: folderId,
      content: [
        "# Graph view",
        "",
        "The graph shows every page as a dot and every link as a line.",
        "",
        "Back to [[Welcome]], or read [[Getting started]].",
        "",
      ].join("\n"),
    },
  ];
}
