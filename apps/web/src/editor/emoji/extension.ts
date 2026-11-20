/**
 * `:roc` → emoji suggestions in the editor (#6v8tyxfd), Notion-style.
 * Uses the shared emoji data/search/recent from `lib/emoji` (#dsc8skxj).
 * Emoji are inserted as plain Unicode characters (no shortcodes on disk).
 */
import { Extension, type Editor, type Range } from "@tiptap/core";
import type { ResolvedPos } from "@tiptap/pm/model";
import { PluginKey, type EditorState } from "@tiptap/pm/state";
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from "@tiptap/suggestion";
import { loadEmojiData, searchEmoji, type EmojiEntry } from "../../lib/emoji/data.js";
import { getRecentEmoji, pushRecentEmoji } from "../../lib/emoji/recent.js";
import { findEmojiQuery } from "./trigger.js";

export const EMOJI_SUGGESTION_LIMIT = 8;
const emojiPluginKey = new PluginKey("emojiSuggestion");

export interface EmojiHandlers {
  onStart: (props: SuggestionProps<EmojiEntry>) => void;
  onUpdate: (props: SuggestionProps<EmojiEntry>) => void;
  onKeyDown: (props: SuggestionKeyDownProps) => boolean;
  onExit: () => void;
}

/**
 * Emoji people reach for most (Slack/Notion-style defaults). Among matches
 * they come before rare ones, so `:part` offers 🎉 before 〽️.
 */
export const COMMON_EMOJI = [
  "👍", "❤️", "😂", "🎉", "🔥", "✅", "🚀", "😊", "🙏", "👀", "💯", "😍", "🤔", "👏",
  "😅", "✨", "⭐", "💡", "⚠️", "❌", "📌", "📝", "🥳", "😭", "🙌", "💪", "☕", "🐛",
  "📅", "🎯", "😀", "😉", "😎", "🙂", "👋", "👌", "🤝", "💬", "📎", "🔗", "🏁", "🎁",
];

/** Search results: recently used first (shared with the picker), then common emoji, then search order. */
export function rankEmoji(
  results: readonly EmojiEntry[],
  recent: readonly string[],
  limit = EMOJI_SUGGESTION_LIMIT,
): EmojiEntry[] {
  const rank = (entry: EmojiEntry) => {
    const index = recent.indexOf(entry.emoji);
    if (index !== -1) return index;
    const common = COMMON_EMOJI.indexOf(entry.emoji);
    return common === -1 ? Number.POSITIVE_INFINITY : 1000 + common;
  };
  return results
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => rank(a.entry) - rank(b.entry) || a.index - b.index)
    .slice(0, limit)
    .map((item) => item.entry);
}

/** The `:query` ending at the caret, outside code. */
export function findEmojiMatch($position: ResolvedPos) {
  const parent = $position.parent;
  if (!parent.isTextblock || parent.type.spec.code) return null;
  const textBefore = parent.textBetween(0, $position.parentOffset, undefined, "￼");
  const match = findEmojiQuery(textBefore);
  if (!match) return null;
  const from = $position.start() + match.colon;
  return { range: { from, to: $position.pos }, query: match.query, text: `:${match.query}` };
}

function inInlineCode(state: EditorState, range: Range): boolean {
  const code = state.schema.marks.code;
  if (!code) return false;
  return (
    state.doc.rangeHasMark(range.from, range.to, code) ||
    code.isInSet(state.selection.$from.marks()) !== undefined
  );
}

export function insertEmoji(editor: Editor, range: Range, emoji: string): void {
  editor.chain().focus().insertContentAt(range, emoji).run();
  pushRecentEmoji(emoji);
}

export function createEmojiExtension(handlers: { current: EmojiHandlers }) {
  return Extension.create({
    name: "emojiSuggestion",

    addProseMirrorPlugins() {
      return [
        Suggestion<EmojiEntry>({
          editor: this.editor,
          pluginKey: emojiPluginKey,
          char: ":",
          findSuggestionMatch: ({ $position }) => findEmojiMatch($position),
          allow: ({ state, range }) => !inInlineCode(state, range),
          items: async ({ query }) => {
            const entries = await loadEmojiData();
            return rankEmoji(searchEmoji(entries, query, 40), getRecentEmoji());
          },
          command: ({ editor, range, props }) => insertEmoji(editor, range, props.emoji),
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
