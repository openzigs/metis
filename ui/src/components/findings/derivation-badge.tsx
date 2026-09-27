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
 *  - Colours come from the semantic status tokens (#267): success / info /
 *    warning, each asserted ≥4.5:1 on its own tint in both themes
 *    (ui/tests/contrast-tokens.test.ts).
 *  - The review confirmation is a Radix Dialog (#268): focus trap, Escape,
 *    focus return to the Review button.
 */
import * as React from "react";
import { Check, HelpCircle, Sparkle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

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
    className: "bg-success-muted text-success border-success/40",
    label: "EXTRACTED",
    icon: <Check className="h-3 w-3" aria-hidden="true" />,
    testid: "derivation-badge-extracted",
  },
  inferred: {
    className: "bg-info-muted text-info border-info/40",
    label: "INFERRED",
    icon: <Sparkle className="h-3 w-3" aria-hidden="true" />,
    testid: "derivation-badge-inferred",
  },
  ambiguous: {
    className: "bg-warning-muted text-warning border-warning/40",
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
          className="rounded border border-warning/40 bg-warning-muted px-2 py-0.5 text-xs font-medium text-warning hover:bg-warning/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-warning"
        >
          Review
        </button>
      ) : null}
      <Dialog open={open} onOpenChange={(next) => !submitting && setOpen(next)}>
        {open ? (
          <DerivationBadgeReviewModal
            agentResultId={agentResultId}
            confidence={confidence}
            submitting={submitting}
            onCancel={() => setOpen(false)}
            onConfirm={handleConfirm}
          />
        ) : null}
      </Dialog>
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
    <DialogContent className="max-w-md" data-testid="derivation-badge-review-dialog">
      <DialogHeader>
        <DialogTitle className="text-base">Review ambiguous finding</DialogTitle>
        <DialogDescription>
          The analysis agent flagged this finding for human review. Confirm to record an audit row
          noting that you have reviewed it.
        </DialogDescription>
      </DialogHeader>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <dt>Confidence</dt>
        <dd className="tabular-nums">{formatRawConfidence(confidence)}</dd>
        <dt>Agent run</dt>
        <dd className="font-mono break-all">{agentResultId}</dd>
      </dl>
      <DialogFooter className="gap-2">
        <Button variant="outline" size="sm" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button
          size="sm"
          data-testid="derivation-badge-review-confirm"
          onClick={onConfirm}
          disabled={submitting}
        >
          {submitting ? "Recording…" : "Confirm review"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function joinClasses(...parts: Array<string | undefined | false>): string {
  return parts.filter(Boolean).join(" ");
}
