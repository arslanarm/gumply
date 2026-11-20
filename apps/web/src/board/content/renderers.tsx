/** W2b renderers for the board engine's slots (#5hme2fwj). */
import type { BoardRenderers } from "../context.js";
import { BoardCard } from "./BoardCard.js";
import { BoardRichText } from "./BoardRichText.js";

export const boardContentRenderers: BoardRenderers = {
  text: ({ text }) => <BoardRichText text={text} />,
  card: (props) => <BoardCard {...props} />,
};
