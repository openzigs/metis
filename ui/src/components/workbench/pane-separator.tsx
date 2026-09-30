/**
 * #526 — a draggable divider between two Workbench panes (the WAI-ARIA
 * "window splitter" pattern): drag it with a pointer, or focus it and use the
 * arrow keys (Shift for bigger steps), Home and End.
 *
 * `value` is the width of the pane it resizes, as a percentage of `container`'s
 * width. `side` says which pane that is: dragging right widens a `left` pane
 * and narrows a `right` one.
 *
 * `onChange` follows the pointer on every move, for the live resize;
 * `onCommit` fires once when a change is finished — on pointer release, or on
 * each key press — so a caller persists the width once per drag, not per move.
 */
"use client";

import { useEffect, useRef, type KeyboardEvent, type PointerEvent, type RefObject } from "react";

export interface PaneSeparatorProps {
  ariaLabel: string;
  /** The resized pane's id, for `aria-controls`. */
  controls: string;
  side: "left" | "right";
  value: number;
  min: number;
  max: number;
  /** The element whose width 100% refers to. */
  container: RefObject<HTMLElement | null>;
  /** Every step of a drag or key press: the live width. */
  onChange: (pct: number) => void;
  /** The end of a change: pointer released (or cancelled) after a drag, or a key press. */
  onCommit: (pct: number) => void;
}

const STEP = 1;
const BIG_STEP = 5;

export function PaneSeparator({
  ariaLabel,
  controls,
  side,
  value,
  min,
  max,
  container,
  onChange,
  onCommit,
}: PaneSeparatorProps) {
  // Detaches the window listeners of a drag in progress; also run on unmount,
  // so a separator removed mid-drag leaves nothing listening on the window.
  const endDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => endDrag.current?.(), []);

  const clamp = (n: number) => Math.min(max, Math.max(min, Math.round(n * 10) / 10));
  // Moving the pointer or pressing → by `delta` widens a left pane, narrows a right one.
  const direction = side === "left" ? 1 : -1;

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    const width = container.current?.getBoundingClientRect().width ?? 0;
    if (e.button !== 0 || width <= 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startValue = value;
    let last: number | null = null;
    const move = (ev: globalThis.PointerEvent) => {
      last = clamp(startValue + (direction * (ev.clientX - startX) * 100) / width);
      onChange(last);
    };
    const detach = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      endDrag.current = null;
    };
    const stop = () => {
      detach();
      if (last !== null) onCommit(last);
    };
    endDrag.current?.();
    endDrag.current = detach;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const step = e.shiftKey ? BIG_STEP : STEP;
    let next: number;
    if (e.key === "ArrowRight") next = value + direction * step;
    else if (e.key === "ArrowLeft") next = value - direction * step;
    else if (e.key === "Home") next = min;
    else if (e.key === "End") next = max;
    else return;
    e.preventDefault();
    const pct = clamp(next);
    onChange(pct);
    onCommit(pct);
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      aria-controls={controls}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      className="group hidden w-2 cursor-col-resize touch-none select-none items-stretch justify-center rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:flex"
      data-testid={`separator-${side}`}
    >
      <span
        aria-hidden="true"
        className="w-px bg-border group-hover:bg-primary group-focus-visible:bg-primary"
      />
    </div>
  );
}
