"use client";

/**
 * Epic #192 (A.6) — PR-review components.
 *
 * Composes the AC-verdict matrix, inline-comment list, sandbox-test list,
 * and the overall summary card. All three sub-components are exported as
 * named exports for component-test isolation.
 */
import { Card } from "@/components/ui/card";
import type {
  PrReviewComment,
  PrReviewRecord,
  PrReviewSandboxResult,
  PrReviewVerdict,
} from "@/lib/runs-api";

const VERDICT_LABEL: Record<PrReviewRecord["judge"]["overallVerdict"], string> = {
  approve: "Approve",
  request_changes: "Request changes",
  comment: "Comment",
};
const VERDICT_TONE: Record<PrReviewRecord["judge"]["overallVerdict"], string> = {
  approve: "bg-emerald-100 text-emerald-900 border-emerald-300",
  request_changes: "bg-red-100 text-red-900 border-red-300",
  comment: "bg-slate-100 text-slate-900 border-slate-300",
};

export function ReviewPanel({ review }: { review: PrReviewRecord }) {
  return (
    <div className="space-y-4">
      <Card
        className={`border-l-4 p-4 ${VERDICT_TONE[review.judge.overallVerdict]}`}
        data-testid="run-review-summary"
      >
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs uppercase tracking-wide">Overall verdict</div>
            <div className="text-lg font-semibold">
              {VERDICT_LABEL[review.judge.overallVerdict]}
            </div>
          </div>
          {review.reviewUrl && (
            <a
              href={review.reviewUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm underline"
              data-testid="run-review-github-link"
            >
              View on GitHub
            </a>
          )}
        </div>
        {review.judge.summary && (
          <p className="mt-2 whitespace-pre-line text-sm" data-testid="run-review-summary-text">
            {review.judge.summary}
          </p>
        )}
      </Card>
      <AcMatrix verdicts={review.judge.verdicts} />
      <CommentList comments={review.judge.comments} />
      {review.sandboxResults.length > 0 && <SandboxResults results={review.sandboxResults} />}
    </div>
  );
}

export function AcMatrix({ verdicts }: { verdicts: PrReviewVerdict[] }) {
  return (
    <Card className="p-4" data-testid="run-review-ac-matrix">
      <div className="mb-2 text-sm font-medium">Acceptance criteria</div>
      {verdicts.length === 0 && (
        <div className="text-sm text-muted-foreground">No criteria evaluated.</div>
      )}
      <ul className="space-y-2">
        {verdicts.map((v) => (
          <li
            key={v.acId}
            className="flex items-start gap-3 rounded border p-2"
            data-testid={`run-review-ac-${v.acId}`}
            data-verdict={v.verdict}
          >
            <span
              className={`rounded px-2 py-0.5 text-xs font-medium ${
                v.verdict === "satisfied"
                  ? "bg-emerald-100 text-emerald-900"
                  : v.verdict === "not_satisfied"
                    ? "bg-red-100 text-red-900"
                    : "bg-amber-100 text-amber-900"
              }`}
            >
              {v.verdict}
            </span>
            <div className="flex-1 text-sm">
              <div className="font-mono text-xs text-muted-foreground">{v.acId}</div>
              <div>{v.reasoning}</div>
              {v.evidenceFiles.length > 0 && (
                <div className="mt-1 text-xs text-muted-foreground">
                  Evidence: {v.evidenceFiles.join(", ")}
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function CommentList({ comments }: { comments: PrReviewComment[] }) {
  return (
    <Card className="p-4" data-testid="run-review-comments">
      <div className="mb-2 text-sm font-medium">Inline comments</div>
      {comments.length === 0 && (
        <div className="text-sm text-muted-foreground">No inline comments emitted.</div>
      )}
      <ul className="space-y-2">
        {comments.map((c, i) => (
          <li
            key={`${c.filePath}-${c.line}-${i}`}
            className="rounded border p-2 text-sm"
            data-testid={`run-review-comment-${i}`}
            data-severity={c.severity}
          >
            <div className="flex items-center gap-2">
              <span
                className={`rounded px-2 py-0.5 text-xs ${
                  c.severity === "risk"
                    ? "bg-red-100 text-red-900"
                    : c.severity === "warning"
                      ? "bg-amber-100 text-amber-900"
                      : "bg-slate-100 text-slate-900"
                }`}
              >
                {c.severity}
              </span>
              <span className="font-mono text-xs">
                {c.filePath}:{c.line}
              </span>
            </div>
            <div className="mt-1 whitespace-pre-line">{c.body}</div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function SandboxResults({ results }: { results: PrReviewSandboxResult[] }) {
  return (
    <Card className="p-4" data-testid="run-review-sandbox">
      <div className="mb-2 text-sm font-medium">Sandbox test results</div>
      <ul className="space-y-2">
        {results.map((r, i) => (
          <li
            key={`${r.acId}-${i}`}
            className="rounded border p-2 text-sm"
            data-testid={`run-review-sandbox-${r.acId}`}
            data-exit-code={r.exitCode}
          >
            <div className="flex items-center justify-between">
              <span className="font-mono text-xs">{r.acId}</span>
              <span
                className={`rounded px-2 py-0.5 text-xs ${
                  r.exitCode === 0 ? "bg-emerald-100 text-emerald-900" : "bg-red-100 text-red-900"
                }`}
              >
                exit {r.exitCode} · {r.durationMs}ms
                {r.truncated ? " · truncated" : ""}
              </span>
            </div>
            {(r.stdout || r.stderr) && (
              <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted/50 p-2 text-xs">
                {r.stderr ? `[stderr]\n${r.stderr}\n\n` : ""}
                {r.stdout ? `[stdout]\n${r.stdout}` : ""}
              </pre>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
