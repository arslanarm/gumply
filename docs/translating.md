# Translating Gumply

Gumply's interface is available in English and Russian. Adding a language takes one file
and no code beyond one line. This guide shows how.

## Where the words live

- `apps/web/src/i18n/en.json`: every message in the web app and the desktop app's menus
  and dialogs (the `desktop` section), grouped by area: `sidebar`, `board`, `slash`,
  `graph` and so on. English is the source and the fallback.
- `apps/web/src/i18n/ru.json`: the Russian translation, with exactly the same keys.

The files use the [i18next JSON v4](https://www.i18next.com/misc/json-format) format, so
translation tools such as Weblate, Crowdin and Lokalise can read and write them.

## Add a language

1. Copy `en.json` to `<code>.json`, using the language's two-letter code (`de.json`,
   `es.json`, `uk.json`…).
2. Translate every value. Keep the keys as they are.
3. Add the language to `LANGUAGES` in `apps/web/src/i18n/index.ts`, with its name written
   in itself (`{ code: "de", name: "Deutsch" }`), and its loader to `LOADERS`
   (`de: () => import("./de.json")`). Also add it in `apps/desktop/src/i18n.ts`
   (one `import`, and the `MESSAGES` entry), so the desktop menus can use it.
4. Run `npm test`. The key check (`apps/web/test/i18n.test.ts`) fails if a key is missing
   or extra, if a plural form your language needs is missing, if a `{{placeholder}}` was
   changed, or if a message was left in English.
5. Look at it: open Settings (the 文A button in the top bar) and pick the language.

## The rules of the format

- **Placeholders:** `{{name}}` is filled in by the app. Keep every placeholder of the
  English text; you may move it within the sentence.
- **Plurals:** a key with a count has one variant per plural category of the language, as
  `Intl.PluralRules` names them (`_one`, `_few`, `_many`, `_other` for Russian;
  `_one`, `_other` for English and German). The test lists the ones your language needs:

  ```json
  "pages_one": "{{count}} страница",
  "pages_few": "{{count}} страницы",
  "pages_many": "{{count}} страниц",
  "pages_other": "{{count}} страницы"
  ```

- **Split sentences:** a few messages are cut around a code sample, for example
  `graph.emptyHintBefore` + `[[` + `graph.emptyHintAfter`. Translate the two halves so
  they read as one sentence, including the spaces at their ends.
- **Search words:** `slash.*.keywords` and `search.templateWords`/`languageWords` are extra
  words, in your language, that find a command. They're comma- or space-separated and may
  be empty. English words always work too.
- **Menu access keys:** in the desktop menu labels (`desktop.menu.file`…), `&` marks the
  letter used with Alt. Keep one `&` in each top-level menu name.
- **Names:** "Gumply" stays as is (`app.name`). Markdown, PNG, SVG, HTML and keyboard
  keys (Enter, Esc, Shift) aren't translated.

## What is never translated

Gumply's files are plain Markdown and JSON Canvas, shared with Obsidian, so the interface
language never changes their format:

- frontmatter keys, `.canvas` keys, callout types (`> [!note]`) and link syntax stay as
  they are;
- **existing** files are never renamed or rewritten when you switch language.

What **is** created in the interface language is new content, which is yours once made:
the default title of a new page ("Без названия") or board, and so its file name (D20); a
new frame's name; and the text of a board made from a template.

## Known gaps

- The demo vault created on the very first start is in English. The server creates it
  before the interface language is known.
- Emoji search uses the emoji's English names.
- Messages that come from the server, such as some error details, are in English.
- Code-block language names are proper names and aren't translated, except "Plain text".
