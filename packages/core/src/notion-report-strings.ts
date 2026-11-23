/**
 * The words of `Import report.md` (#n86gnptg) in each language the app
 * ships. The in-app report (B4) uses the web app's t() keys; this file is
 * the written report, rendered on the server in the language the import was
 * started in. English is the default and the fallback.
 */
import type { PropertyType } from "./properties.js";

export type NotionReportLanguage = "en" | "ru";
export const NOTION_REPORT_LANGUAGES: readonly NotionReportLanguage[] = ["en", "ru"];

/** Why an entry or row was left out; `reason` stays English for the API. */
export type NotionSkipCode =
  | "nul"
  | "absolute"
  | "outside"
  | "symlink"
  | "tooLarge"
  | "zipBomb"
  | "sizeMismatch"
  | "rowWithoutPage"
  | "typesNotRecorded";

export type NotionSkipParams = Record<string, string | number>;

export interface NotionReportStrings {
  title: string;
  importedInto: (folder: string) => string;
  importedTitle: string;
  pages: (n: number) => string;
  databases: (databases: number, rows: number) => string;
  attachments: (n: number) => string;
  /** Byte-identical files in the export, stored once (#inwiay4m). */
  sharedCopy: (n: number, names: string, file: string) => string;
  convertedTitle: string;
  links: (links: number, mentions: number) => string;
  databaseEmbeds: (embeds: number, links: number) => string;
  relations: (n: number) => string;
  attachmentLinks: (n: number) => string;
  callouts: (n: number) => string;
  databasesTitle: string;
  tableView: string;
  boardView: (key: string) => string;
  boardSkipped: (key: string, groups: number, max: number) => string;
  properties: (list: string) => string;
  noProperties: string;
  renamedTitle: string;
  keptTypesTitle: string;
  keptType: (key: string, type: string, found: string) => string;
  notRowsTitle: string;
  notRow: (page: string, database: string) => string;
  lostTitle: string;
  lost: string;
  outsideTitle: string;
  missingTitle: string;
  skippedTitle: string;
  types: Record<PropertyType, string>;
  skip: Record<NotionSkipCode, (params: NotionSkipParams) => string>;
}

const en1 = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const EN: NotionReportStrings = {
  title: "# Notion import",
  importedInto: (folder) => `Imported into \`${folder}\`.`,
  importedTitle: "## Imported",
  pages: (n) => en1(n, "page", "pages"),
  databases: (databases, rows) => `${en1(databases, "database", "databases")} with ${en1(rows, "row", "rows")}`,
  attachments: (n) => en1(n, "attachment", "attachments"),
  sharedCopy: (n, names, file) => `${n} identical files share one copy (\`${file}\`): ${names}`,
  convertedTitle: "## Converted",
  links: (links, mentions) => `${en1(links, "link", "links")} and ${en1(mentions, "mention", "mentions")} to wiki links`,
  databaseEmbeds: (embeds, links) => `${en1(embeds, "database", "databases")} embedded as live views, ${en1(links, "database link", "database links")}`,
  relations: (n) => `${en1(n, "relation", "relations")} to wiki links`,
  attachmentLinks: (n) => `${en1(n, "link", "links")} to attachments`,
  callouts: (n) => `${en1(n, "callout", "callouts")} (their icons are not in the export)`,
  databasesTitle: "## Databases",
  tableView: "a table view in Notion's column order",
  boardView: (key) => `, and a board grouped by ${key} (Notion's exported view leaves that column out, so it was probably a board)`,
  boardSkipped: (key, groups, max) => `; no board for ${key}: it has ${groups} values (more than ${max})`,
  properties: (list) => `Properties: ${list}.`,
  noProperties: "Properties: none.",
  renamedTitle: "## Renamed properties",
  keptTypesTitle: "## Property types kept from your vault",
  keptType: (key, type, found) => `${key}: ${type} (the import found ${found})`,
  notRowsTitle: "## Sub-pages of database rows",
  notRow: (page, database) => `${page}: imported as a page, not as a row of ${database}`,
  lostTitle: "## Not in a Notion export",
  lost: "Database views: filters, sorts and layouts (Gumply made a table, and a board where the export points to one), formula and rollup settings (their values arrive as text), option colours, text colours, toggles, comments, synced blocks, permissions, people, files in file properties (their names arrive as text), and embeds of other apps.",
  outsideTitle: "## Links to pages that weren't exported",
  missingTitle: "## Links to files missing from the export",
  skippedTitle: "## Skipped",
  types: { text: "text", multitext: "list", number: "number", checkbox: "checkbox", date: "date", datetime: "date and time", tags: "tags", aliases: "aliases" },
  skip: {
    nul: () => "a NUL character in the name",
    absolute: () => "an absolute path",
    outside: () => "a path that leaves the export",
    symlink: () => "a symbolic link",
    tooLarge: ({ limit }) => `larger than ${limit}`,
    zipBomb: () => "compressed suspiciously well (a possible zip bomb)",
    sizeMismatch: () => "its size doesn't match the zip's header",
    rowWithoutPage: ({ title }) => `the row "${title}" has no page in the export`,
    typesNotRecorded: ({ error }) => `property types not recorded: ${error}`,
  },
};

/* Russian: "Label: N" lines, so numbers never need case agreement. */
const RU: NotionReportStrings = {
  title: "# Импорт из Notion",
  importedInto: (folder) => `Импортировано в \`${folder}\`.`,
  importedTitle: "## Импортировано",
  pages: (n) => `Страниц: ${n}`,
  databases: (databases, rows) => `Баз данных: ${databases}, строк в них: ${rows}`,
  attachments: (n) => `Вложений: ${n}`,
  sharedCopy: (n, names, file) => `Одинаковых файлов в одной копии (\`${file}\`): ${n} — ${names}`,
  convertedTitle: "## Преобразовано",
  links: (links, mentions) => `Ссылок: ${links} и упоминаний: ${mentions} — стали вики-ссылками`,
  databaseEmbeds: (embeds, links) => `Баз данных встроено живыми представлениями: ${embeds}, ссылок на базы: ${links}`,
  relations: (n) => `Связей, ставших вики-ссылками: ${n}`,
  attachmentLinks: (n) => `Ссылок на вложения: ${n}`,
  callouts: (n) => `Выносок: ${n} (их значков нет в экспорте)`,
  databasesTitle: "## Базы данных",
  tableView: "таблица со столбцами в порядке Notion",
  boardView: (key) => ` и доска по свойству ${key} (в экспортированном представлении Notion этого столбца нет, значит, скорее всего, это была доска)`,
  boardSkipped: (key, groups, max) => `; доски по свойству ${key} нет: значений у него ${groups} (больше ${max})`,
  properties: (list) => `Свойства: ${list}.`,
  noProperties: "Свойств нет.",
  renamedTitle: "## Переименованные свойства",
  keptTypesTitle: "## Типы свойств из вашего хранилища сохранены",
  keptType: (key, type, found) => `${key}: ${type} (импорт определил: ${found})`,
  notRowsTitle: "## Подстраницы строк баз данных",
  notRow: (page, database) => `${page}: импортирована как страница, а не как строка базы ${database}`,
  lostTitle: "## Чего нет в экспорте Notion",
  lost: "Представления баз: фильтры, сортировка и вид (Gumply создал таблицу, а где экспорт на это указывает, ещё и доску), настройки формул и сводок (их значения приходят текстом), цвета вариантов выбора, цвета текста, раскрывающиеся блоки, комментарии, синхронизированные блоки, доступ, люди, файлы в свойствах «Файлы» (приходят их имена, текстом) и встраивания других приложений.",
  outsideTitle: "## Ссылки на страницы, которые не экспортированы",
  missingTitle: "## Ссылки на файлы, которых нет в экспорте",
  skippedTitle: "## Пропущено",
  types: { text: "текст", multitext: "список", number: "число", checkbox: "флажок", date: "дата", datetime: "дата и время", tags: "теги", aliases: "псевдонимы" },
  skip: {
    nul: () => "в имени есть символ NUL",
    absolute: () => "абсолютный путь",
    outside: () => "путь ведёт за пределы экспорта",
    symlink: () => "символическая ссылка",
    tooLarge: ({ limit }) => `больше ${limit}`,
    zipBomb: () => "сжато подозрительно сильно (возможно, zip-бомба)",
    sizeMismatch: () => "размер не совпадает с заголовком zip",
    rowWithoutPage: ({ title }) => `у строки «${title}» нет страницы в экспорте`,
    typesNotRecorded: ({ error }) => `типы свойств не записаны: ${error}`,
  },
};

const STRINGS: Record<NotionReportLanguage, NotionReportStrings> = { en: EN, ru: RU };

/** A supported report language, else English. */
export function notionReportLanguage(value: unknown): NotionReportLanguage {
  return typeof value === "string" && (NOTION_REPORT_LANGUAGES as readonly string[]).includes(value) ? (value as NotionReportLanguage) : "en";
}

export function notionReportStrings(language: NotionReportLanguage = "en"): NotionReportStrings {
  return STRINGS[language] ?? EN;
}

/** A skipped entry's reason in `language` (English is what the API's `reason` holds). */
export function notionSkipReason(code: NotionSkipCode, params: NotionSkipParams = {}, language: NotionReportLanguage = "en"): string {
  return notionReportStrings(language).skip[code](params);
}
