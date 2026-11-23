# Contributing to Gumply

Thanks for your interest. Gumply is MIT-licensed (see [LICENSE](LICENSE)); by contributing you agree your contribution is released under the same licence.

## Issues are welcome

Bug reports and ideas go to [GitHub issues](https://github.com/arslanarm/gumply/issues). Please say what you did, what you expected and what happened, with your system and Gumply's version (**Help → About Gumply** in the desktop app). Issues are public: don't attach notes you wouldn't want others to read.

## Build and test

Use the Node version in `.nvmrc` (24 LTS; 22 is also tested).

```bash
npm install
npm run dev          # web app on http://localhost:5173, API on :8787, vault in ./vault
npm run typecheck    # every workspace; must be clean
npm test             # unit tests (Vitest)
npm run test:e2e     # end-to-end tests (Playwright) against a throwaway vault
npm run build        # core, server and web
```

`GUMPLY_VAULT=/path/to/notes` points the app at another folder. **Use a copy of your notes, or a throwaway folder, while developing.** The desktop app lives in `apps/desktop` (Electron); see the README's "Desktop app" section.

CI runs the type check, unit tests and build on Node 22 and 24, and the full end-to-end suite, on every push to `main` and on release tags. A change should keep all of them green.

## The one rule about files

**A save never changes bytes the user didn't touch.** Gumply works on people's own Markdown, canvas and Bases files, often shared with Obsidian or a sync tool. A change that rewrites lines, frontmatter keys, list markers, escapes or blank lines the user didn't edit is a release blocker, however small. If your change writes files, add a test that compares the bytes before and after.

What Gumply reads and writes in a vault, and what it promises never to touch, is described in [docs/file-format.md](docs/file-format.md). A change to that format needs a decision and a new version of that page first.

## Languages

The interface is in English and Russian, and every string goes through the translations in `apps/web/src/i18n/`. To add a language, see [docs/translating.md](docs/translating.md).

## Pull requests

Keep a pull request to one change, with tests, and describe what a user will notice. Changes are reviewed and merged by the maintainers.
