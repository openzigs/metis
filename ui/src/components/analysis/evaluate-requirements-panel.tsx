"use client";

/**
 * Issue #907 — "Evaluate new requirements (optional)" panel for the Analysis page.
 *
 * A collapsible (progressive-disclosure) panel containing a textarea where the
 * user describes *new* requirements to evaluate against the current
 * implementation. The text flows to the start mutation as `extraInstructions`
 * (capped at {@link MAX_EXTRA_INSTRUCTIONS} chars to match the server-side Zod
 * cap from #905), so the agents report the requirements→code gap.
 *
 * Collapsed by default; toggled via the in-house `aria-expanded` convention
 * (no accordion primitive), matching `data-mappings-panel.tsx`.
 */
import { useId, useState } from "react";
import { MAX_EXTRA_INSTRUCTIONS } from "@metis/shared";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/**
 * Maximum length for the free-text requirements. Re-exported from `@metis/shared`
 * (#1112) so this textarea, the server Zod cap and the run's input-truncation
 * check can never drift to three different numbers.
 */
export { MAX_EXTRA_INSTRUCTIONS };

const HELPER_TEXT =
  "Describe new requirements to evaluate against the current implementation; the agents report the gaps and changes needed.";

interface Props {
  /** Current value of the requirements textarea. */
  value: string;
  /** Called with the next value (already clamped to the max length). */
  onChange: (next: string) => void;
  /** Start collapsed (default) or expanded. */
  defaultExpanded?: boolean;
}

export function EvaluateRequirementsPanel({
  value,
  onChange,
  defaultExpanded = false,
}: Props): React.ReactElement {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const textareaId = useId();
  const remaining = MAX_EXTRA_INSTRUCTIONS - value.length;
  const overLimit = remaining < 0;
  /**
   * Issue #1112 (from #1101) — how many characters the last change lost to the
   * cap. The panel used to set `maxLength` AND slice, which meant the browser
   * silently discarded the tail of an over-long paste before React ever saw it —
   * the loss was undetectable, and a character counter reading "4096 / 4096"
   * looks identical whether or not anything was cut. Dropping `maxLength` and
   * clamping only in `onChange` (the value stays controlled, so the limit still
   * holds) makes the overflow observable, and therefore reportable.
   */
  const [truncatedBy, setTruncatedBy] = useState(0);

  return (
    <div className="rounded border border-zinc-800 p-3" data-testid="evaluate-requirements-panel">
      <div className="flex items-center justify-between gap-2">
        <div>
          <Label className="text-sm font-medium">Evaluate new requirements (optional)</Label>
          <p className="mt-0.5 text-xs text-zinc-400">{HELPER_TEXT}</p>
        </div>
        <Button
          size="sm"
          variant="outline"
          type="button"
          aria-expanded={expanded}
          aria-controls={textareaId}
          onClick={() => setExpanded((v) => !v)}
          data-testid="evaluate-requirements-toggle"
        >
          {expanded ? "Hide" : "Add requirements"}
        </Button>
      </div>

      {expanded ? (
        <div className="mt-3 space-y-1">
          <Textarea
            id={textareaId}
            value={value}
            placeholder="e.g. Support SSO for enterprise tenants; add audit logging to all mutations…"
            rows={5}
            onChange={(e) => {
              const next = e.target.value;
              setTruncatedBy(Math.max(0, next.length - MAX_EXTRA_INSTRUCTIONS));
              onChange(next.slice(0, MAX_EXTRA_INSTRUCTIONS));
            }}
            data-testid="evaluate-requirements-textarea"
          />
          {truncatedBy > 0 ? (
            <p
              className="text-xs text-amber-300"
              data-testid="evaluate-requirements-truncated"
              role="status"
            >
              Your text was cut at {MAX_EXTRA_INSTRUCTIONS} characters — the last {truncatedBy}{" "}
              character{truncatedBy === 1 ? "" : "s"} were removed and will not be analyzed. Submit
              the remainder as a separate run.
            </p>
          ) : null}
          <div
            className={`text-right text-xs ${overLimit ? "text-red-400" : "text-zinc-500"}`}
            data-testid="evaluate-requirements-counter"
            aria-live="polite"
          >
            {value.length} / {MAX_EXTRA_INSTRUCTIONS}
          </div>
        </div>
      ) : null}
    </div>
  );
}
