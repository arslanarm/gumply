/**
 * `[[` autocomplete wiring (spec/ux §8). The React menu lives in LinkMenu;
 * this extension only computes suggestions and performs the insert.
 */
import { linkTargetFor, pageBlockIds, pageHeadings, resolveWikilink, type PageMeta } from "@gumply/core";
import { api } from "../../api/client.js";
import { t } from "../../i18n/index.js";
import type { EditorState } from "@tiptap/pm/state";
import { isBoard } from "../../lib/boards.js";
import { isBase } from "../../lib/bases.js";
import { boardEmbedAttrs } from "../board-embed/node.js";
import { hrefForAttachment } from "../../lib/attachment-links.js";
import { Extension } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion, {
  type SuggestionKeyDownProps,
  type SuggestionProps,
} from "@tiptap/suggestion";
import { buildFileSuggestions, buildLinkSuggestions, isImageFile, type LinkSuggestion } from "../../lib/wikilinks.js";
import { linkableFiles } from "../../lib/linkable-files.js";
import { fileNameWithoutExtension } from "../../lib/files.js";
import { insertImageAttachment } from "../attachments/insert.js";
import { getWikiLinkEnvironment } from "./link-store.js";
import { replaceWithFileEmbed } from "./node.js";

const wikiLinkPluginKey = new PluginKey("wikiLinkSuggestion");

/**
 * `![[` (D30, #5dpxwac4): the `[[` just typed is an embed. The menu lists
 * pages and boards; picking one embeds it (a page preview or a live board).
 * `![[Page#` lists the page's headings and block ids.
 */
function embedStart(state: EditorState, from: number): boolean {
  return from > 0 && state.doc.textBetween(from - 1, from) === "!";
}

/**
 * `/Page preview` (#5dpxwac4) starts `![[` and asks for the outline step:
 * picking a page then lists "Whole page", its headings and its blocks.
 */
let pickPartAfterPage = false;

/**
 * "Embed existing board…" / "Embed existing database…" start `![[` and ask
 * for that kind only (@opus-hunter's P3, #sg36ng2d): plain `![[` lists pages,
 * boards and bases alike. Cleared when the menu closes.
 */
let embedKindOnly: "whiteboard" | "base" | null = null;

export function requestEmbedPicker(kind: "whiteboard" | "base"): void {
  embedKindOnly = kind;
}

export function requestPagePreviewPicker(): void {
  pickPartAfterPage = true;
}

/**
 * `![[Page#…` suggestions: the whole page (outline step), its headings, then
 * its block ids. For a plain `[[Page#…` link (#5r8k77fe, `link: true`) the
 * same rows without "Whole page" (Obsidian has none; `]]` links the page) and
 * without base views; `page` is the open note itself for `[[#…`.
 */
async function partSuggestions(query: string, options: { link?: boolean; page?: PageMeta } = {}): Promise<LinkSuggestion[]> {
  const env = getWikiLinkEnvironment();
  const hash = query.indexOf("#");
  const page = options.page ?? resolveWikilink(query.slice(0, hash).trim(), env.pages, env.pageId);
  if (!page || isBoard(page)) return [];
  const needle = query.slice(hash + 1).trim().toLowerCase();
  if (isBase(page) && options.link) return [];
  if (isBase(page)) {
    // `![[Tasks.base#` lists the base's views (D34).
    try {
      const { config } = await api.getBase(page.id);
      return config.views
        .filter((view) => !needle || view.name.toLowerCase().includes(needle))
        .map<LinkSuggestion>((view) => ({ kind: "page", key: `${page.id}#${view.name}`, label: view.name, title: page.title, pageId: page.id, part: view.name }));
    } catch {
      return [];
    }
  }
  let content = "";
  try {
    content = (await api.getPage(page.id)).content;
  } catch {
    return [];
  }
  const headings = pageHeadings(content).map<LinkSuggestion>((heading) => ({
    kind: "page",
    key: `${page.id}#${heading.line}`,
    label: heading.text,
    title: page.title,
    pageId: page.id,
    part: heading.text,
    level: heading.level,
  }));
  const blocks = pageBlockIds(content).map<LinkSuggestion>((block) => ({
    kind: "page",
    key: `${page.id}#^${block.id}`,
    label: block.text || `^${block.id}`,
    title: page.title,
    pageId: page.id,
    part: `^${block.id}`,
  }));
  const matches = [...headings, ...blocks].filter((item) => !needle || item.label.toLowerCase().includes(needle.replace(/^\^/, ""))).slice(0, 30);
  if (options.link) return matches;
  const whole: LinkSuggestion = { kind: "page", key: `${page.id}#`, label: t("pageEmbed.wholePage"), title: page.title, pageId: page.id, part: "", icon: page.icon };
  return needle ? matches : [whole, ...matches];
}

/**
 * Plain `[[…#` (#5r8k77fe): the headings and block ids of the page named
 * before `#` (from the open note, D40), or of the open note itself for
 * `[[#`; null when the text before `#` names no page (the caller then offers
 * Create for that name).
 */
function linkPartSuggestions(query: string): Promise<LinkSuggestion[]> | null {
  const env = getWikiLinkEnvironment();
  const hash = query.indexOf("#");
  if (hash === -1) return null;
  const name = query.slice(0, hash).trim();
  if (name.length === 0) {
    const self = env.pages.find((item) => item.id === env.pageId);
    // Rows for the open note carry an empty title: they're written as text (`[[#Heading]]`).
    return self ? partSuggestions(query, { link: true, page: self }).then((rows) => rows.map((row) => ({ ...row, title: "" }))) : Promise.resolve([]);
  }
  return resolveWikilink(name, env.pages, env.pageId) ? partSuggestions(query, { link: true }) : null;
}

/** #2zugp8qc: the open suggestion's range now, when it's the one `given` was made for (same start); else `given`. */
function liveRange(state: EditorState, given: { from: number; to: number }): { from: number; to: number } {
  const live = wikiLinkPluginKey.getState(state) as { active?: boolean; range?: { from: number; to: number } } | undefined;
  return live?.active && live.range && live.range.from === given.from && live.range.to >= given.to ? { from: given.from, to: live.range.to } : given;
}

/** The suggestion these props were made for is still the open one. */
function isCurrent(props: SuggestionProps<LinkSuggestion>): boolean {
  const state = wikiLinkPluginKey.getState(props.editor.state) as
    | { active: boolean; range: { from: number }; query: string | null }
    | undefined;
  return !!state?.active && state.range.from === props.range.from && state.query === props.query;
}

export interface LinkMenuHandlers {
  onStart: (props: SuggestionProps<LinkSuggestion>) => void;
  onUpdate: (props: SuggestionProps<LinkSuggestion>) => void;
  onKeyDown: (props: SuggestionKeyDownProps) => boolean;
  onExit: () => void;
}

export function createWikiLinkExtension(handlers: { current: LinkMenuHandlers }) {
  return Extension.create({
    name: "wikiLinkMenu",

    addProseMirrorPlugins() {
      return [
        Suggestion<LinkSuggestion>({
          editor: this.editor,
          pluginKey: wikiLinkPluginKey,
          char: "[[",
          startOfLine: false,
          allowSpaces: true,
          // `![[` embeds a board (D30).
          allowedPrefixes: [" ", "!"],
          allow: ({ state, range }) => {
            const $from = state.doc.resolve(range.from);
            if ($from.parent.type.name === "codeBlock") return false;
            if ($from.marks().some((mark) => mark.type.spec.code)) return false;
            // A completed `[[Title]]` is converted by the wikiLink input rule.
            // Keeping the menu open would leave a suggestion decoration and
            // offer Create with the brackets in the title (walkthrough #2).
            return !state.doc.textBetween(range.from, range.to).includes("]]");
          },
          items: ({ query, editor }) => {
            const env = getWikiLinkEnvironment();
            const active = wikiLinkPluginKey.getState(editor.state) as { range?: { from: number } } | undefined;
            if (active?.range && embedStart(editor.state, active.range.from)) {
              // `![[Page#` lists the page's parts; when the text before `#`
              // names no page, it's part of a file name (`a#b.png`): search
              // files for the whole query (#eg65ktng).
              const hash = query.indexOf("#");
              if (hash !== -1 && resolveWikilink(query.slice(0, hash).trim(), env.pages, env.pageId)) return partSuggestions(query);
              // No "Create" row: a new board is `/whiteboard` → New board here.
              // The open page can't preview itself.
              const embeddable = env.pages.filter(
                (page) =>
                  page.id !== env.pageId &&
                  (embedKindOnly === null ||
                    (embedKindOnly === "base" ? isBase(page) : isBoard(page))),
              );
              const pageRows = buildLinkSuggestions(embeddable, query).filter((item) => item.kind === "page");
              // #4usgpjh8: files anywhere in the vault too (not for the
              // `/whiteboard` or `/database` pickers).
              if (embedKindOnly !== null || pickPartAfterPage) return pageRows;
              return [...pageRows, ...buildFileSuggestions(linkableFiles(env.pageId), query)];
            }
            return linkPartSuggestions(query) ?? buildLinkSuggestions(env.pages, query, env.attachments);
          },
          command: ({ editor, range: given, props }) => {
            // #2zugp8qc: TipTap passes the range of the last suggestion answer it rendered. A letter typed after it,
            // whose answer is still loading (a `[[Page#…` heading fetch on a loaded machine), is in the open
            // suggestion but not in that range, and would be left outside the link ("i[[Target#Risks]]"). The
            // suggestion as it is now: the same start, its current end.
            const range = liveRange(editor.state, given);
            if (embedStart(editor.state, range.from) && props.kind === "file" && props.file) {
              const from = range.from - 1;
              // #btgun63k: a wikilink can't hold `[ ] | # ^`. Such a file gets a
              // Markdown image or file link instead, written by the same D23
              // note-relative writer as the `[[` menu's attachment rows.
              const parent = editor.state.doc.resolve(from).parent;
              const alone =
                parent.type.name === "paragraph" &&
                parent.textContent === editor.state.doc.textBetween(from, range.to) &&
                editor.state.doc.resolve(from).depth > 0;
              // #btgun63k: a wikilink can't hold `[ ] | # ^`. Such a file gets a
              // Markdown image or file link instead, written by the same D23
              // note-relative writer as the `[[` menu's attachment rows, and
              // placed like the `![[…]]` it stands for: alone on its line an
              // image replaces the paragraph (no empty one left behind, #eg65ktng).
              if (/[[\]|#^]/.test(props.file.link)) {
                const file = props.file;
                const href = hrefForAttachment(file.path);
                editor
                  .chain()
                  .focus()
                  .command(({ tr, state }) => {
                    const { schema } = state;
                    if (isImageFile(file)) {
                      const attrs = { src: href, alt: fileNameWithoutExtension(file.name) };
                      if (alone && schema.nodes.image) {
                        const $from = tr.doc.resolve(from);
                        tr.replaceWith($from.before(), $from.after(), schema.nodes.image.create(attrs));
                        return true;
                      }
                      if (!schema.nodes.inlineImage) return false;
                      tr.replaceWith(from, range.to, schema.nodes.inlineImage.create(attrs));
                      return true;
                    }
                    if (!schema.nodes.fileAttachment) return false;
                    tr.replaceWith(from, range.to, schema.nodes.fileAttachment.create({ path: href, name: file.name, size: 0 }));
                    return true;
                  })
                  .run();
                return;
              }
              // #4usgpjh8: exactly what typing `![[<link>]]` makes (#95x2fjh6),
              // with the link Obsidian would write from this note.
              const typed = `![[${props.file.link}]]`;
              editor
                .chain()
                .focus()
                .command(({ tr, state }) => replaceWithFileEmbed(tr, state.schema, { from, to: range.to }, typed, alone))
                .run();
              return;
            }
            if (embedStart(editor.state, range.from) && props.kind === "page") {
              const env = getWikiLinkEnvironment();
              const board = env.pages.find((item) => item.id === props.pageId);
              if (board && isBoard(board)) {
                editor
                  .chain()
                  .focus()
                  .deleteRange({ from: range.from - 1, to: range.to })
                  .insertContent({ type: "boardEmbed", attrs: boardEmbedAttrs(board, env.pages) })
                  .run();
                return;
              }
              if (board && isBase(board)) {
                // A database view, live (D34); `#View` picks one of its views.
                editor
                  .chain()
                  .focus()
                  .deleteRange({ from: range.from - 1, to: range.to })
                  .insertContent({
                    type: "baseEmbed",
                    attrs: { target: linkTargetFor(board, env.pages).target, view: props.part ?? "", raw: "" },
                  })
                  .run();
                return;
              }
              if (board && pickPartAfterPage && props.part === undefined) {
                // The outline step: keep the menu open on `![[Page#`.
                editor.chain().focus().deleteRange(range).insertContent(`[[${linkTargetFor(board, env.pages).target}#`).run();
                return;
              }
              if (board) {
                pickPartAfterPage = false;
                // A page preview (#5dpxwac4), of the whole page or one part.
                editor
                  .chain()
                  .focus()
                  .deleteRange({ from: range.from - 1, to: range.to })
                  .insertContent({
                    type: "pageEmbed",
                    attrs: { target: linkTargetFor(board, env.pages).target, part: props.part ?? "", alias: "", raw: "" },
                  })
                  .run();
                return;
              }
            }
            if (props.kind === "attachment" && props.attachment) {
              const attachment = props.attachment;
              if (attachment.mime.startsWith("image/")) {
                editor.chain().focus().deleteRange(range).run();
                insertImageAttachment(editor, attachment, editor.state.selection.from);
              } else {
                editor
                  .chain()
                  .focus()
                  .deleteRange(range)
                  .insertContent({
                    type: "fileAttachment",
                    attrs: {
                      path: hrefForAttachment(attachment.path),
                      name: attachment.name,
                      size: attachment.size,
                      mime: attachment.mime,
                    },
                  })
                  .run();
              }
              return;
            }

            // Duplicate titles, or a title that differs from the file name
            // (`Ideas: Q3?` → `Ideas Q3.md`), become `[[file name|Title]]` so
            // the link resolves in Obsidian (by file name) too (#mp8eadhk).
            const env = getWikiLinkEnvironment();
            // `[[#Heading` in the open note (#5r8k77fe): written as the text
            // `[[#Heading]]`, as typing it would (the link node needs a page).
            if (props.kind === "page" && props.part !== undefined && props.title === "") {
              editor.chain().focus().deleteRange(range).insertContent(`[[#${props.part}]]`).run();
              return;
            }
            const page = props.kind === "page" ? env.pages.find((item) => item.id === props.pageId) : undefined;
            const link = page ? linkTargetFor(page, env.pages) : { target: props.title, alias: "" };
            // `[[Page#Heading` (#5r8k77fe): the chosen heading or `^block` is the link's part.
            const attrs = { targetTitle: link.target, alias: link.alias, heading: props.part ?? "" };

            editor.chain().focus().deleteRange(range).insertContent({ type: "wikiLink", attrs }).run();

            if (props.kind === "create") getWikiLinkEnvironment().createLink(props.title);
          },
          // TipTap awaits `items` before onStart/onUpdate. `[[Page#…` fetches
          // the page's headings, so a late answer could reopen the menu after
          // `]]` already closed it (#cafeydb8): only show it for a suggestion
          // that is still active with the same query.
          render: () => ({
            onStart: (props) => {
              if (isCurrent(props)) handlers.current.onStart(props);
            },
            onUpdate: (props) => {
              if (isCurrent(props)) handlers.current.onUpdate(props);
            },
            onKeyDown: (props) => handlers.current.onKeyDown(props),
            onExit: () => {
              embedKindOnly = null;
              handlers.current.onExit();
            },
          }),
        }),
      ];
    },
  });
}
