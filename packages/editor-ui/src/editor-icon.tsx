import type { ReactNode } from "react";

export type EditorIconName =
  | "alert"
  | "align-center"
  | "align-left"
  | "align-right"
  | "bold"
  | "check"
  | "chevron-down"
  | "chevron-left"
  | "chevron-right"
  | "comment"
  | "code"
  | "clear-format"
  | "file-up"
  | "image"
  | "italic"
  | "link"
  | "list"
  | "ordered-list"
  | "task-list"
  | "paragraph"
  | "heading"
  | "highlight"
  | "table"
  | "quote"
  | "horizontal-rule"
  | "loader"
  | "more"
  | "panel-left-close"
  | "panel-left-open"
  | "redo"
  | "refresh"
  | "search"
  | "sparkles"
  | "strike"
  | "undo"
  | "underline"
  | "x";

const paths: Record<EditorIconName, ReactNode> = {
  alert: (
    <>
      <path d="M12 3 2.8 19h18.4L12 3Z" />
      <path d="M12 9v4" />
      <path d="M12 16h.01" />
    </>
  ),
  "align-center": <path d="M4 6h16M7 10h10M4 14h16M7 18h10" />,
  "align-left": <path d="M4 6h16M4 10h10M4 14h16M4 18h10" />,
  "align-right": <path d="M4 6h16M10 10h10M4 14h16M10 18h10" />,
  bold: (
    <>
      <path d="M7 5h6a3.5 3.5 0 0 1 0 7H7z" />
      <path d="M7 12h7a3.5 3.5 0 0 1 0 7H7z" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  "chevron-down": <path d="m6 9 6 6 6-6" />,
  "chevron-left": <path d="m15 18-6-6 6-6" />,
  "chevron-right": <path d="m9 18 6-6-6-6" />,
  comment: (
    <>
      <path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H6l-3 2v-6.5A7.5 7.5 0 1 1 20 11.5Z" />
      <path d="M8 11h8M8 14h5" />
    </>
  ),
  code: (
    <>
      <path d="m8 8-4 4 4 4" />
      <path d="m16 8 4 4-4 4" />
      <path d="m14 5-4 14" />
    </>
  ),
  "clear-format": (
    <>
      <path d="M4 7h12M10 7v13M7 20h6" />
      <path d="m17 14 4 4m0-4-4 4" />
    </>
  ),
  "file-up": (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <path d="M12 18v-6" />
      <path d="m9 15 3-3 3 3" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="m21 15-5-5L5 21" />
    </>
  ),
  italic: (
    <>
      <path d="M19 4h-9" />
      <path d="M14 20H5" />
      <path d="m15 4-6 16" />
    </>
  ),
  link: (
    <>
      <path d="M10 13a5 5 0 0 0 7.1 0l3-3A5 5 0 0 0 13 2.9l-1.7 1.7" />
      <path d="M14 11a5 5 0 0 0-7.1 0l-3 3A5 5 0 0 0 11 21.1l1.7-1.7" />
    </>
  ),
  list: (
    <>
      <path d="M9 6h11" />
      <path d="M9 12h11" />
      <path d="M9 18h11" />
      <path d="M4 6h.01" />
      <path d="M4 12h.01" />
      <path d="M4 18h.01" />
    </>
  ),
  "ordered-list": (
    <>
      <path d="M10 6h10M10 12h10M10 18h10" />
      <path d="M4 5h1v3M4 11h2l-2 2h2M4 17h2l-2 2h2" />
    </>
  ),
  "task-list": (
    <>
      <rect x="3" y="4" width="5" height="5" rx="1" />
      <path d="m4.5 6.5 1 1L8 5M11 6.5h10" />
      <rect x="3" y="15" width="5" height="5" rx="1" />
      <path d="M11 17.5h10" />
    </>
  ),
  paragraph: (
    <>
      <path d="M5 5h14M5 10h14M5 15h9M5 19h9" />
    </>
  ),
  heading: (
    <>
      <path d="M5 5v14M19 5v14M5 12h14" />
    </>
  ),
  highlight: (
    <>
      <path d="m14 4 6 6-8.5 8.5a3 3 0 0 1-4.2 0l-1.8-1.8A3 3 0 0 1 5.5 15L14 4Z" />
      <path d="M4 21h16" />
    </>
  ),
  table: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="1" />
      <path d="M3 10h18M3 15h18M9 4v16M15 4v16" />
    </>
  ),
  quote: (
    <>
      <path d="M4 7h5v5H5v5M15 7h5v5h-4v5" />
    </>
  ),
  "horizontal-rule": <path d="M3 12h18" />,
  loader: (
    <>
      <path d="M21 12a9 9 0 0 1-9 9" />
      <path d="M3 12a9 9 0 0 1 9-9" />
    </>
  ),
  more: (
    <>
      <circle cx="12" cy="5" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="12" cy="19" r="1" />
    </>
  ),
  "panel-left-close": (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
      <path d="m15 9-3 3 3 3" />
    </>
  ),
  "panel-left-open": (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
      <path d="m13 9 3 3-3 3" />
    </>
  ),
  redo: (
    <>
      <path d="m15 14 5-5-5-5" />
      <path d="M4 18v-2a7 7 0 0 1 7-7h9" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 7v5h-5" />
      <path d="M4 17v-5h5" />
      <path d="M5.6 9A7 7 0 0 1 18 6l2 6" />
      <path d="M18.4 15A7 7 0 0 1 6 18l-2-6" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4-4" />
    </>
  ),
  sparkles: (
    <>
      <path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z" />
      <path d="m19 15 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z" />
    </>
  ),
  strike: (
    <>
      <path d="M4 12h16" />
      <path d="M16 5H9a3 3 0 0 0-2.9 3.8" />
      <path d="M8 19h7a3 3 0 0 0 2.9-3.8" />
    </>
  ),
  undo: (
    <>
      <path d="m9 14-5-5 5-5" />
      <path d="M20 18v-2a7 7 0 0 0-7-7H4" />
    </>
  ),
  underline: (
    <>
      <path d="M6 4v6a6 6 0 0 0 12 0V4" />
      <path d="M4 21h16" />
    </>
  ),
  x: <path d="m18 6-12 12M6 6l12 12" />,
};

export function EditorIcon({ name, className }: { name: EditorIconName; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
    >
      {paths[name]}
    </svg>
  );
}
