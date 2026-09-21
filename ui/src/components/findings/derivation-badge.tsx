"use client";

/**
 * Epic #298 / Issue #312 — DerivationBadge.
 *
 * Renders one of three variants for a Finding's `derivation`:
 *
 *  - `extracted` — green, ✓ glyph, no confidence number (extracted is always 1.0).
 *  - `inferred`  — yellow, ~ glyph, "INFERRED {pct}%". Title attribute carries
 *                  the raw confidence + a link to the agent run that produced
 *                  the finding for accessibility (no JS-only tooltip).
 *  - `ambiguous` — orange, ? glyph. Renders a sibling button that opens a
 *                  confirmation dialog. On confirm we POST to the
 *                  `onReview` callback so the parent can audit the action.
 *
 * Accessibility:
 *  - Each badge has a unique text label AND a unique icon glyph (so colour
 *    is never the only signal — passes deuteranopia / protanopia / tritanopia).
 *  - Colours hit WCAG AA contrast in light + dark themes (the Tailwind
 *    *-100 / *-900 pairings used here are the project-wide default).
 */
import * as React from "react";
import { Check, HelpCircle, Sparkle } from "lucide-react";

export type FindingDerivation = "extracted" | "inferred" | "ambiguous";

export interface DerivationBadgeProps {
  derivation: FindingDerivation;
  /** Confidence in [0, 1]. Required for `inferred`/`ambiguous`. */
  confidence: number;
  /** Id of the AgentResult that produced the finding. Used in the INFERRED tooltip. */
  agentResultId: string;
  /**
   * Called when the user confirms a review on an `ambiguous` badge. The
   * parent is responsible for posting the audit row and updating any
   * downstream state. Optional — when omitted, the review button is hidden.
   */
  onReview?: (input: { agentResultId: string; confidence: number }) => void | Promise<void>;
  /** Optional className to layer on top of the variant styles. */
  className?: string;
}

const BASE =
  "inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs font-medium tabular-nums whitespace-nowrap";

const VARIANTS: Record<
  FindingDerivation,
  { className: string; label: string; icon: React.ReactNode; testid: string }
> = {
  extracted: {
    className:
      "bg-green-100 text-green-900 border-green-300 dark:bg-green-900/30 dark:text-green-100 dark:border-green-700",
    label: "EXTRACTED",
    icon: <Check className="h-3 w-3" aria-hidden="true" />,
    testid: "derivation-badge-extracted",
  },
  inferred: {
    className:
      "bg-yellow-100 text-yellow-900 border-yellow-300 dark:bg-yellow-900/30 dark:text-yellow-100 dark:border-yellow-700",
    label: "INFERRED",
    icon: <Sparkle className="h-3 w-3" aria-hidden="true" />,
    testid: "derivation-badge-inferred",
  },
  ambiguous: {
    className:
      "bg-orange-100 text-orange-900 border-orange-300 dark:bg-orange-900/30 dark:text-orange-100 dark:border-orange-700",
    label: "AMBIGUOUS",
    icon: <HelpCircle className="h-3 w-3" aria-hidden="true" />,
    testid: "derivation-badge-ambiguous",
  },
};

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 100;
  return Math.round(value * 100);
}

/** Format a confidence number like "0.72" with exactly two decimal places. */
function formatRawConfidence(value: number): string {
  if (!Number.isFinite(value)) return "0.00";
  return value.toFixed(2);
}

export function DerivationBadge(props: DerivationBadgeProps): React.ReactElement {
  const { derivation, confidence, agentResultId, onReview, className } = props;
  const variant = VARIANTS[derivation];
  const [open, setOpen] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);

  if (derivation === "extracted") {
    return (
      <span
        data-testid={variant.testid}
        aria-label="Finding extracted directly from source. Confidence is always 1.0."
        className={joinClasses(BASE, variant.className, className)}
      >
        {variant.icon}
        <span>{variant.label}</span>
      </span>
    );
  }

  if (derivation === "inferred") {
    const pct = clampPercent(confidence);
    const raw = formatRawConfidence(confidence);
    const tooltip = `Inferred by analysis agent. Confidence ${raw}. Source agent run: ${agentResultId}`;
    return (
      <span
        data-testid={variant.testid}
        aria-label={tooltip}
        title={tooltip}
        className={joinClasses(BASE, variant.className, className)}
      >
        {variant.icon}
        <span>
          {variant.label} {pct}%
        </span>
      </span>
    );
  }

  // ambiguous
  async function handleConfirm() {
    if (!onReview) {
      setOpen(false);
      return;
    }
    setSubmitting(true);
    try {
      await onReview({ agentResultId, confidence });
      setOpen(false);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-1">
      <span
        data-testid={variant.testid}
        aria-label="Finding flagged as ambiguous. Human review requested."
        title="Finding flagged as ambiguous. Human review requested."
        className={joinClasses(BASE, variant.className, className)}
      >
        {variant.icon}
        <span>{variant.label}</span>
      </span>
      {onReview ? (
        <button
          type="button"
          data-testid="derivation-badge-review-button"
          aria-label="Review this ambiguous finding"
          onClick={() => setOpen(true)}
          className="rounded border border-orange-300 bg-orange-50 px-2 py-0.5 text-xs font-medium text-orange-900 hover:bg-orange-100 dark:bg-orange-900/20 dark:text-orange-100 dark:border-orange-700 dark:hover:bg-orange-900/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-600"
        >
          Review
        </button>
      ) : null}
      {open ? (
        <DerivationBadgeReviewModal
          agentResultId={agentResultId}
          confidence={confidence}
          submitting={submitting}
          onCancel={() => setOpen(false)}
          onConfirm={handleConfirm}
        />
      ) : null}
    </span>
  );
}

interface ReviewModalProps {
  agentResultId: string;
  confidence: number;
  submitting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

function DerivationBadgeReviewModal(props: ReviewModalProps): React.ReactElement {
  const { agentResultId, confidence, submitting, onCancel, onConfirm } = props;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Review ambiguous finding"
      data-testid="derivation-badge-review-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div className="w-full max-w-md rounded border border-zinc-300 bg-white p-4 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
        <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
          Review ambiguous finding
        </h3>
        <p className="mt-2 text-sm text-zinc-700 dark:text-zinc-300">
          The analysis agent flagged this finding for human review. Confirm to record an audit row
          noting that you have reviewed it.
        </p>
        <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs text-zinc-600 dark:text-zinc-400">
          <dt>Confidence</dt>
          <dd className="tabular-nums">{formatRawConfidence(confidence)}</dd>
          <dt>Agent run</dt>
          <dd className="font-mono break-all">{agentResultId}</dd>
        </dl>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="rounded border border-zinc-300 bg-white px-3 py-1 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:hover:bg-zinc-700"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="derivation-badge-review-confirm"
            onClick={onConfirm}
            disabled={submitting}
            className="rounded bg-orange-600 px-3 py-1 text-sm font-medium text-white hover:bg-orange-700 disabled:opacity-60"
          >
            {submitting ? "Recording…" : "Confirm review"}
          </button>
        </div>
      </div>
    </div>
  );
}

function joinClasses(...parts: Array<string | undefined | false>): string {
  return parts.filter(Boolean).join(" ");
}
