"use client";

/**
 * SandboxStatusBadge — Epic #395 #419.
 *
 * Visual indicator for the most recent `SandboxSession` outcome on a
 * Run detail page. Uses semantic colour + a unique glyph so colour is
 * never the only signal (passes WCAG / colour-blind contrast).
 *
 * Status mapping:
 *   - `pending`         — session inserted, no `destroyedAt` yet → slate
 *   - `running`         — alias for `pending` (kept for clarity in the UI)
 *   - `passed`          — `outcome=completed` AND `errorMessage IS NULL` → green
 *   - `failed:timeout`  — `outcome=timeout` → amber
 *   - `failed:exit-N`   — `outcome=completed` with non-zero exit (currently
 *                         surfaced via `errorMessage`) → red
 *   - `error`           — `outcome=error` OR `outcome=killed` → red, hover
 *                         tooltip exposes `errorMessage`
 */
import * as React from "react";

export type SandboxBadgeKind =
  | "pending"
  | "running"
  | "passed"
  | "failed-timeout"
  | "failed-exit"
  | "error";

export interface SandboxStatusBadgeProps {
  /** Outcome value as persisted on `SandboxSession.outcome` (or `null`). */
  outcome: string | null;
  /** `errorMessage` from the session row. Surfaced in the title attr for hover. */
  errorMessage?: string | null;
  /** Optional className to layer onto the variant styles. */
  className?: string;
}

const BASE =
  "inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs font-medium tabular-nums whitespace-nowrap";

const VARIANTS: Record<
  SandboxBadgeKind,
  { className: string; label: string; glyph: string; testid: string }
> = {
  pending: {
    className:
      "bg-slate-100 text-slate-800 border-slate-300 dark:bg-slate-800/40 dark:text-slate-100 dark:border-slate-600",
    label: "PENDING",
    glyph: "•",
    testid: "sandbox-badge-pending",
  },
  running: {
    className:
      "bg-blue-100 text-blue-900 border-blue-300 dark:bg-blue-900/30 dark:text-blue-100 dark:border-blue-700",
    label: "RUNNING",
    glyph: "▶",
    testid: "sandbox-badge-running",
  },
  passed: {
    className:
      "bg-green-100 text-green-900 border-green-300 dark:bg-green-900/30 dark:text-green-100 dark:border-green-700",
    label: "PASSED",
    glyph: "✓",
    testid: "sandbox-badge-passed",
  },
  "failed-timeout": {
    className:
      "bg-amber-100 text-amber-900 border-amber-300 dark:bg-amber-900/30 dark:text-amber-100 dark:border-amber-700",
    label: "FAILED:TIMEOUT",
    glyph: "⏱",
    testid: "sandbox-badge-failed-timeout",
  },
  "failed-exit": {
    className:
      "bg-red-100 text-red-900 border-red-300 dark:bg-red-900/30 dark:text-red-100 dark:border-red-700",
    label: "FAILED",
    glyph: "✗",
    testid: "sandbox-badge-failed-exit",
  },
  error: {
    className:
      "bg-red-100 text-red-900 border-red-300 dark:bg-red-900/30 dark:text-red-100 dark:border-red-700",
    label: "ERROR",
    glyph: "!",
    testid: "sandbox-badge-error",
  },
};

/**
 * Map a session row's `outcome` + `errorMessage` to a badge variant.
 * Pure function so call sites can test mappings without rendering.
 */
export function classifySandboxOutcome(
  outcome: string | null,
  errorMessage?: string | null,
): SandboxBadgeKind {
  if (outcome == null) return "pending";
  switch (outcome) {
    case "completed":
      return errorMessage ? "failed-exit" : "passed";
    case "timeout":
      return "failed-timeout";
    case "killed":
    case "error":
      return "error";
    default:
      return "pending";
  }
}

export function SandboxStatusBadge({
  outcome,
  errorMessage,
  className,
}: SandboxStatusBadgeProps): React.ReactElement {
  const kind = classifySandboxOutcome(outcome, errorMessage);
  const v = VARIANTS[kind];
  const title = errorMessage ? `${v.label} — ${errorMessage}` : v.label;
  return (
    <span
      className={`${BASE} ${v.className}${className ? ` ${className}` : ""}`}
      data-testid={v.testid}
      data-sandbox-badge={kind}
      title={title}
      role="status"
      aria-label={title}
    >
      <span aria-hidden="true">{v.glyph}</span>
      <span>{v.label}</span>
    </span>
  );
}
