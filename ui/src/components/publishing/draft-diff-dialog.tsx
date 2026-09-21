"use client";

/**
 * Inline draft diff dialog.
 *
 * Shows a draft's body in a Dialog. If `previousBody` is provided, renders a
 * minimal line-by-line diff (LCS-based) so reviewers can see exactly what
 * changed since the previous publish before they re-publish. If only the
 * draft body is available, the panel falls back to a syntax-free preview.
 */
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export interface DraftDiffDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  body: string;
  previousBody?: string | null;
}

interface DiffLine {
  kind: "same" | "add" | "remove";
  text: string;
}

/**
 * Tiny line-level diff. O(n*m) LCS — fine for the few-hundred-line bodies we
 * deal with here. Returns a flat ordered list of diff lines suitable for
 * direct rendering. Not character-level; a one-character change in a line is
 * shown as a remove + add of the entire line, which is good enough.
 */
export function diffLines(a: string, b: string): DiffLine[] {
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  const m = aLines.length;
  const n = bLines.length;

  // Build LCS table.
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i]![j] =
        aLines[i] === bLines[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (aLines[i] === bLines[j]) {
      out.push({ kind: "same", text: aLines[i]! });
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ kind: "remove", text: aLines[i]! });
      i += 1;
    } else {
      out.push({ kind: "add", text: bLines[j]! });
      j += 1;
    }
  }
  while (i < m) {
    out.push({ kind: "remove", text: aLines[i]! });
    i += 1;
  }
  while (j < n) {
    out.push({ kind: "add", text: bLines[j]! });
    j += 1;
  }
  return out;
}

function lineClass(kind: DiffLine["kind"]): string {
  switch (kind) {
    case "add":
      return "bg-emerald-50 text-emerald-900";
    case "remove":
      return "bg-red-50 text-red-900";
    default:
      return "text-slate-700";
  }
}

function linePrefix(kind: DiffLine["kind"]): string {
  switch (kind) {
    case "add":
      return "+";
    case "remove":
      return "−";
    default:
      return " ";
  }
}

export function DraftDiffDialog({
  open,
  onOpenChange,
  title,
  body,
  previousBody,
}: DraftDiffDialogProps) {
  const showDiff = typeof previousBody === "string" && previousBody.length > 0;
  const lines: DiffLine[] = showDiff
    ? diffLines(previousBody!, body)
    : body.split("\n").map((text) => ({ kind: "same" as const, text }));

  const counts = lines.reduce(
    (acc, l) => {
      acc[l.kind] += 1;
      return acc;
    },
    { same: 0, add: 0, remove: 0 },
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div data-testid="draft-diff-summary" className="text-xs text-slate-500">
          {showDiff ? (
            <>
              <span className="text-emerald-700">+{counts.add}</span>{" "}
              <span className="text-red-700">−{counts.remove}</span> <span>={counts.same}</span>
            </>
          ) : (
            <span>No previous version — showing current body.</span>
          )}
        </div>
        <pre
          data-testid="draft-diff-body"
          className="max-h-[60vh] overflow-auto rounded border bg-slate-50 p-3 font-mono text-xs leading-5"
        >
          {lines.map((l, idx) => (
            <div key={idx} className={lineClass(l.kind)}>
              <span className="select-none pr-2 text-slate-400">{linePrefix(l.kind)}</span>
              {l.text}
            </div>
          ))}
        </pre>
      </DialogContent>
    </Dialog>
  );
}
