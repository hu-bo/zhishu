import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import './resizable-split.css';

/** Visual width of the divider, kept in sync with .resizable-split__divider. */
const DIVIDER_WIDTH = 5;

function clampWidth(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function readStoredWidth(
  storageKey: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!storageKey) return clampWidth(fallback, min, max);
  try {
    const raw = window.localStorage.getItem(storageKey);
    // Missing key parses as Number(null) === 0, which would clamp to minWidth and
    // pin the pane there; only a stored value may override the fallback.
    if (raw === null) return clampWidth(fallback, min, max);
    const stored = Number(raw);
    return Number.isFinite(stored) ? clampWidth(stored, min, max) : clampWidth(fallback, min, max);
  } catch {
    return clampWidth(fallback, min, max);
  }
}

export interface ResizableSplitProps {
  left: ReactNode;
  right: ReactNode;
  className?: string;
  /** Extra classes on the left/right wrappers, e.g. pane visibility toggles. */
  leftClassName?: string;
  rightClassName?: string;
  /** localStorage key remembering the right-pane width; omit to keep the width in memory only. */
  storageKey?: string;
  initialWidth?: number;
  /** Smallest width the right pane can be dragged to. */
  minWidth?: number;
  /** Hard ceiling for the right pane; dragging stops here even when space allows more. */
  maxWidth?: number;
  /** Width that always stays available to the left pane. */
  minLeftWidth?: number;
}

/**
 * Two-pane horizontal split with a draggable divider. The right pane keeps a pixel
 * width clamped to [minWidth, maxWidth], while the left pane takes the remaining space.
 * The width is applied through the --resizable-split-width custom property so embedding
 * stylesheets can override the layout (for example full-width panes on narrow screens).
 * Both panes stay mounted while dragging; only their widths change.
 */
export function ResizableSplit({
  left,
  right,
  className,
  leftClassName,
  rightClassName,
  storageKey,
  initialWidth = 420,
  minWidth = 360,
  maxWidth = 800,
  minLeftWidth = 320,
}: ResizableSplitProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ right: number; width: number } | null>(null);
  const widthRef = useRef(initialWidth);
  const [width, setWidth] = useState(() =>
    readStoredWidth(storageKey, initialWidth, minWidth, maxWidth),
  );
  const [dragging, setDragging] = useState(false);
  widthRef.current = width;

  // The right pane never exceeds maxWidth, and the left pane never drops below minLeftWidth.
  const limitFor = useCallback(
    (containerWidth: number) =>
      Math.max(minWidth, Math.min(maxWidth, containerWidth - DIVIDER_WIDTH - minLeftWidth)),
    [minWidth, maxWidth, minLeftWidth],
  );

  // Persist only after an explicit user action (drag end, keyboard step, double-click).
  // Mount-time or transient clamps must never freeze a wrong width into the preference.
  const commitWidth = useCallback(
    (next: number) => {
      widthRef.current = next;
      setWidth(next);
      if (!storageKey) return;
      try {
        window.localStorage.setItem(storageKey, String(next));
      } catch {
        // Storage failures only lose the layout preference, never the content.
      }
    },
    [storageKey],
  );

  // A container shrink can invalidate the remembered width; re-clamp instead of crowding
  // the left pane. The zero-width guard skips pre-layout measurements (e.g. hidden mounts).
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const observer = new ResizeObserver(([entry]) => {
      const containerWidth = entry.contentRect.width;
      if (containerWidth === 0) return;
      setWidth((current) => clampWidth(current, minWidth, limitFor(containerWidth)));
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, [limitFor, minWidth]);

  // Persist once the width settles — after a drag ends or a keyboard step — not on every move.
  useEffect(() => {
    if (dragging || !storageKey) return;
    try {
      window.localStorage.setItem(storageKey, String(width));
    } catch {
      // Storage failures only lose the layout preference, never the content.
    }
  }, [dragging, storageKey, width]);

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    const root = rootRef.current;
    if (!root || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = root.getBoundingClientRect();
    dragRef.current = { right: rect.right, width: rect.width };
    setDragging(true);
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    setWidth(clampWidth(drag.right - event.clientX, minWidth, limitFor(drag.width)));
  }

  function endDrag(event: PointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 48 : 16;
    let next: number | null = null;
    if (event.key === 'ArrowLeft') next = width + step;
    else if (event.key === 'ArrowRight') next = width - step;
    else if (event.key === 'Home') next = minWidth;
    else if (event.key === 'End') next = maxWidth;
    if (next === null) return;
    event.preventDefault();
    const root = rootRef.current;
    const limit = root ? limitFor(root.clientWidth) : maxWidth;
    setWidth(clampWidth(next, minWidth, limit));
  }

  function resetWidth() {
    const root = rootRef.current;
    setWidth(clampWidth(initialWidth, minWidth, root ? limitFor(root.clientWidth) : maxWidth));
  }

  const paneClass = (side: 'left' | 'right', extra?: string) =>
    `resizable-split__pane resizable-split__${side}${extra ? ` ${extra}` : ''}`;

  return (
    <div
      ref={rootRef}
      className={`resizable-split${dragging ? ' is-dragging' : ''}${className ? ` ${className}` : ''}`}
    >
      <div className={paneClass('left', leftClassName)}>{left}</div>
      <div
        aria-label="调整左右分栏宽度"
        aria-orientation="vertical"
        aria-valuemax={maxWidth}
        aria-valuemin={minWidth}
        aria-valuenow={width}
        className="resizable-split__divider"
        onDoubleClick={resetWidth}
        onKeyDown={handleKeyDown}
        onPointerCancel={endDrag}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        role="separator"
        tabIndex={0}
        title="拖动调整宽度，双击恢复默认"
      />
      <div
        className={paneClass('right', rightClassName)}
        style={{ '--resizable-split-width': `${width}px` } as CSSProperties}
      >
        {right}
      </div>
    </div>
  );
}
