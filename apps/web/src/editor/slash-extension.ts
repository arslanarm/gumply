/**
 * TipTap extension wiring the `/` trigger to the React menu. The renderer
 * delegates to a ref so the component can re-render without recreating the
 * editor instance.
 */
import { Extension } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion, {
  type SuggestionKeyDownProps,
  type SuggestionProps,
} from "@tiptap/suggestion";
import { filterSlashItems, SLASH_ITEMS, type SlashItem } from "./slash-items.js";

const slashPluginKey = new PluginKey("slashMenuSuggestion");

export interface SlashHandlers {
  onStart: (props: SuggestionProps<SlashItem>) => void;
  onUpdate: (props: SuggestionProps<SlashItem>) => void;
  onKeyDown: (props: SuggestionKeyDownProps) => boolean;
  onExit: () => void;
}

export function createSlashExtension(handlers: { current: SlashHandlers }) {
  return Extension.create({
    name: "slashMenu",

    addProseMirrorPlugins() {
      return [
        Suggestion<SlashItem>({
          editor: this.editor,
          pluginKey: slashPluginKey,
          char: "/",
          startOfLine: false,
          allowSpaces: false,
          items: ({ query }) => filterSlashItems(SLASH_ITEMS, query),
          command: ({ editor, range, props }) => {
            props.run(editor, range);
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
