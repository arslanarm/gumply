/**
 * Code block that starts as soon as ``` (or ~~~) is typed, like Notion
 * (#smwaixfp). TipTap's rule waited for a space and took the word typed
 * before it as the language, so "```const x = 1;" lost "const".
 */
import CodeBlock from "@tiptap/extension-code-block";
import { textblockTypeInputRule } from "@tiptap/core";

export const NotionCodeBlock = CodeBlock.extend({
  addInputRules() {
    return [
      textblockTypeInputRule({ find: /^```$/, type: this.type }),
      textblockTypeInputRule({ find: /^~~~$/, type: this.type }),
    ];
  },
});
