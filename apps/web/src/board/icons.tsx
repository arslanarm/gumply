/** Line icons for the board UI, in the same Lucide-like style as `Icon`. */
import type { ReactNode } from "react";

const PATHS = {
  select: <path d="M5 3l14 7.5-6.2 1.6L10 18.5z" />,
  hand: (
    <>
      <path d="M18 11V6.5a1.5 1.5 0 0 0-3 0V11" />
      <path d="M15 10.5V4.5a1.5 1.5 0 0 0-3 0v6" />
      <path d="M12 10.5V5.5a1.5 1.5 0 0 0-3 0V13" />
      <path d="M18 8.5a1.5 1.5 0 0 1 3 0V14a8 8 0 0 1-8 8h-1.5a7 7 0 0 1-5.4-2.6L3.3 16a1.6 1.6 0 0 1 2.4-2.1L9 16" />
    </>
  ),
  sticky: (
    <>
      <path d="M15 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10z" />
      <path d="M15 21v-4a2 2 0 0 1 2-2h4" />
    </>
  ),
  text: (
    <>
      <path d="M5 6V4h14v2" />
      <path d="M12 4v16" />
      <path d="M9 20h6" />
    </>
  ),
  shape: (
    <>
      <rect x="3" y="3" width="10" height="10" rx="1.5" />
      <circle cx="15.5" cy="15.5" r="5.5" />
    </>
  ),
  rect: <rect x="3.5" y="6" width="17" height="12" />,
  rounded: <rect x="3.5" y="6" width="17" height="12" rx="4" />,
  ellipse: <ellipse cx="12" cy="12" rx="9" ry="6.5" />,
  diamond: <path d="M12 3l9 9-9 9-9-9z" />,
  connector: (
    <>
      <path d="M5 19C5 11 19 13 19 5" />
      <path d="M14 5h5v5" />
    </>
  ),
  frame: (
    <>
      <path d="M7 3v18M17 3v18M3 7h18M3 17h18" />
    </>
  ),
  pen: (
    <>
      <path d="M17 3a2.8 2.8 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
      <path d="M15 5l4 4" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="M21 15l-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
    </>
  ),
  page: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M9 13h6M9 17h4" />
    </>
  ),
  undo: (
    <>
      <path d="M9 14L4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </>
  ),
  redo: (
    <>
      <path d="M15 14l5-5-5-5" />
      <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
    </>
  ),
  // #b9425ktw D: align and distribute (Lucide's align-*/align-*-distribute shapes).
  "align-left": (
    <>
      <path d="M4 3v18" />
      <rect x="7" y="6" width="12" height="4" rx="1" />
      <rect x="7" y="14" width="7" height="4" rx="1" />
    </>
  ),
  "align-center": (
    <>
      <path d="M12 3v18" />
      <rect x="5" y="6" width="14" height="4" rx="1" />
      <rect x="8" y="14" width="8" height="4" rx="1" />
    </>
  ),
  "align-right": (
    <>
      <path d="M20 3v18" />
      <rect x="5" y="6" width="12" height="4" rx="1" />
      <rect x="10" y="14" width="7" height="4" rx="1" />
    </>
  ),
  "align-top": (
    <>
      <path d="M3 4h18" />
      <rect x="6" y="7" width="4" height="12" rx="1" />
      <rect x="14" y="7" width="4" height="7" rx="1" />
    </>
  ),
  "align-middle": (
    <>
      <path d="M3 12h18" />
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="8" width="4" height="8" rx="1" />
    </>
  ),
  "align-bottom": (
    <>
      <path d="M3 20h18" />
      <rect x="6" y="5" width="4" height="12" rx="1" />
      <rect x="14" y="10" width="4" height="7" rx="1" />
    </>
  ),
  "distribute-horizontal": (
    <>
      <path d="M3 4v16M21 4v16" />
      <rect x="9" y="7" width="6" height="10" rx="1" />
    </>
  ),
  "distribute-vertical": (
    <>
      <path d="M4 3h16M4 21h16" />
      <rect x="7" y="9" width="10" height="6" rx="1" />
    </>
  ),
  minus: <path d="M5 12h14" />,
  plus: <path d="M12 5v14M5 12h14" />,
  fit: (
    <>
      <path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" />
    </>
  ),
  front: (
    <>
      <rect x="8" y="8" width="13" height="13" rx="2" fill="currentColor" fillOpacity="0.25" />
      <path d="M4 16a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h11a1 1 0 0 1 1 1" />
    </>
  ),
  back: (
    <>
      <rect x="3" y="3" width="13" height="13" rx="2" fill="currentColor" fillOpacity="0.25" />
      <path d="M20 8a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1" />
    </>
  ),
  trash: (
    <>
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </>
  ),
  open: (
    <>
      <path d="M15 3h6v6" />
      <path d="M10 14L21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </>
  ),
  arrowEnd: (
    <>
      <path d="M4 12h15" />
      <path d="M14 7l5 5-5 5" />
    </>
  ),
  arrowNone: <path d="M4 12h16" />,
  link: (
    <>
      <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
      <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
    </>
  ),
  board: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <rect x="6.5" y="6.5" width="5" height="5" rx="0.5" />
      <path d="M14 15.5h3.5M13 9h4.5M6.5 15.5H10" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type BoardIconName = keyof typeof PATHS;

export function BoardIcon({ name, size = 18 }: { name: BoardIconName; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      className="icon"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.75}
      viewBox="0 0 24 24"
      width={size}
    >
      {PATHS[name]}
    </svg>
  );
}
