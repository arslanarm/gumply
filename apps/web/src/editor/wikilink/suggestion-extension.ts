/**
 * `[[` autocomplete wiring (spec/ux §8). The React menu lives in LinkMenu;
 * this extension only computes suggestions and performs the insert.
 */
import { hrefForAttachment } from "../../lib/attachment-links.js";
import { Extension } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion, {
  type SuggestionKeyDownProps,
  type SuggestionProps,
} from "@tiptap/suggestion";
import { buildLinkSuggestions, type LinkSuggestion } from "../../lib/wikilinks.js";
import { insertImageAttachment } from "../attachments/insert.js";
import { getWikiLinkEnvironment } from "./link-store.js";

const wikiLinkPluginKey = new PluginKey("wikiLinkSuggestion");

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
          allow: ({ state, range }) => {
            const $from = state.doc.resolve(range.from);
            if ($from.parent.type.name === "codeBlock") return false;
            if ($from.marks().some((mark) => mark.type.spec.code)) return false;
            // A completed `[[Title]]` is converted by the wikiLink input rule.
            // Keeping the menu open would leave a suggestion decoration and
            // offer Create with the brackets in the title (walkthrough #2).
            return !state.doc.textBetween(range.from, range.to).includes("]]");
          },
          items: ({ query }) =>
            buildLinkSuggestions(
              getWikiLinkEnvironment().pages,
              query,
              getWikiLinkEnvironment().attachments,
            ),
          command: ({ editor, range, props }) => {
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

            // Duplicate titles are inserted as a path link with the title as
            // alias, so picking the second “Plan” resolves to that page.
            const isDuplicate = props.kind === "page" && props.pageId !== undefined && props.label !== props.title;
            const attrs = isDuplicate
              ? { targetTitle: props.pageId, alias: props.title, heading: "" }
              : { targetTitle: props.title, alias: "", heading: "" };

            editor.chain().focus().deleteRange(range).insertContent({ type: "wikiLink", attrs }).run();

            if (props.kind === "create") getWikiLinkEnvironment().createLink(props.title);
          },
          render: () => ({
            onStart: (props) => handlers.current.onStart(props),
            onUpdate: (props) => handlers.current.onUpdate(props),
            onKeyDown: (props) => handlers.current.onKeyDown(props),
            onExit: () => handlers.current.onExit(),
          }),
        }),
      ];
    },
  });
}
