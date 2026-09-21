"use client";

import { useId, useState } from "react";

/**
 * Issue #1232 — a finding's body, made scannable.
 *
 * Measured on the reference run: eight bodies of 855–1113 characters each, with
 * exactly zero newline characters in any of them. So a markdown renderer alone
 * would change nothing visible; what makes the list readable is clamping each
 * body to a few lines behind an expand control and holding the text to a
 * readable measure instead of the full card width.
 *
 * The full text stays in the DOM while clamped (CSS clamp, not truncation), so
 * in-page search and assistive tech still reach it.
 */

/**
 * Bodies shorter than this fit inside the clamp, so offering an expand control
 * for them would be a control that does nothing. Sized against the ~3-line
 * clamp at this measure and font size.
 */
export const CLAMP_THRESHOLD_CHARS = 260;

export function FindingBody({ body }: { body: string }): React.ReactElement | null {
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();

  const text = body?.trim() ?? "";
  if (!text) return null;

  const clampable = text.length > CLAMP_THRESHOLD_CHARS;
  const clamped = clampable && !expanded;

  return (
    <div className="mt-2">
      <p
        id={bodyId}
        data-testid="finding-body"
        data-expanded={clampable ? String(expanded) : undefined}
        className={`max-w-prose whitespace-pre-line text-sm leading-relaxed text-zinc-300 ${
          clamped ? "line-clamp-3" : ""
        }`}
      >
        {text}
      </p>
      {clampable ? (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 rounded text-xs font-medium text-sky-400 underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}
