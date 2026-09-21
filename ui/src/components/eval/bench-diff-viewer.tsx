/**
 * Epic #194 (C.5) — Per-task diff viewer.
 *
 * Side-by-side expected vs actual blocks for a failing task. Used by the
 * leaderboard run-detail page (admin-only — non-admins receive nulls).
 */
"use client";

import type { BenchTaskRow } from "@/lib/eval-api";

export interface BenchDiffViewerProps {
  task: BenchTaskRow;
}

export function BenchDiffViewer({ task }: BenchDiffViewerProps) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2" data-testid={`diff-${task.id}`}>
      <DiffPanel title="Expected" content={task.expected} testId="diff-expected" />
      <DiffPanel title="Actual" content={task.actual} testId="diff-actual" />
    </div>
  );
}

function DiffPanel({
  title,
  content,
  testId,
}: {
  title: string;
  content: string | null;
  testId: string;
}) {
  if (content == null) {
    return (
      <div
        className="rounded border border-dashed p-3 text-xs text-muted-foreground"
        data-testid={`${testId}-empty`}
      >
        {title} content is admin-only.
      </div>
    );
  }
  return (
    <div className="rounded border bg-muted/20 p-3" data-testid={testId}>
      <div className="mb-1 text-xs font-semibold uppercase">{title}</div>
      <pre className="overflow-auto whitespace-pre-wrap break-words text-xs leading-snug">
        {content}
      </pre>
    </div>
  );
}
