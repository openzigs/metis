/**
 * Issue #1220 — an import run's counts as the import page shows them: created
 * and updated, plus — only when there were any — the analyst edits re-sync
 * kept and the requirements it left diverged from their source.
 */
import type { ImportRunView } from "@metis/shared";

type RunCounts = Pick<ImportRunView, "createdCount" | "updatedCount"> &
  Partial<Pick<ImportRunView, "keptLocalCount" | "divergedCount">>;

export function importRunSummary(run: RunCounts): string {
  const parts = [`${run.createdCount} new`, `${run.updatedCount} updated`];
  const kept = run.keptLocalCount ?? 0;
  const diverged = run.divergedCount ?? 0;
  if (kept > 0) parts.push(`kept ${kept} local ${kept === 1 ? "edit" : "edits"}`);
  if (diverged > 0) parts.push(`${diverged} diverged from source`);
  return parts.join(" · ");
}
