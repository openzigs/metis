"use client";

/**
 * Dry-run plan viewer — #1093.
 *
 * The server has always computed a detailed plan (label upserts, issue
 * creates, sub-issue attaches) and stored it on `publish_batches.dryRunPlan`,
 * but nothing rendered it. The Recent-batches row showed only
 * `Published 0 / Failed 0 / Dedup 0`, which reads as though the dry run did
 * nothing at all — the entire value of a preview was invisible unless you
 * queried the API or the database by hand.
 *
 * This panel also surfaces the credential verdict the plan now carries, so
 * "dry run passed" is a genuine predicate for "the live run will get as far as
 * the network" rather than a false reassurance.
 *
 * Lives in `components/` deliberately: the publish page is excluded from UI
 * coverage, so logic parked there would be untested by construction.
 */
import type { DryRunAction, DryRunPlan } from "@metis/shared";

/**
 * Parse the JSON string persisted on `PublishBatch.dryRunPlan`.
 *
 * Returns `null` rather than throwing — a malformed or absent plan must
 * degrade to "no preview available", never break the publish page.
 */
export function parseDryRunPlan(raw: string | null | undefined): DryRunPlan | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<DryRunPlan>;
    if (!parsed || typeof parsed !== "object") return null;
    if (!Array.isArray(parsed.actions)) return null;
    return parsed as DryRunPlan;
  } catch {
    return null;
  }
}

/** Per-kind counts, in a stable order suitable for direct rendering. */
export function summarizeDryRunPlan(plan: DryRunPlan): Array<{ kind: string; count: number }> {
  const counts = new Map<string, number>();
  for (const action of plan.actions) {
    counts.set(action.kind, (counts.get(action.kind) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
}

/** Rounded estimate, in whole seconds, of how long the live run would take. */
export function estimatedDurationLabel(plan: DryRunPlan): string {
  const seconds = Math.round((plan.estimatedDurationMs ?? 0) / 1000);
  if (seconds < 60) return `~${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `~${minutes}m` : `~${minutes}m ${rest}s`;
}

/**
 * The credential warning to show, or `null` when the credential resolved.
 *
 * Older plans (persisted before #1093) carry no verdict at all; those are
 * treated as "unknown" rather than being reported as a failure.
 */
export function credentialWarning(plan: DryRunPlan): string | null {
  if (plan.credentialResolved) return null;
  switch (plan.credentialCheck) {
    case "missing":
      return "No vault secret ref was supplied, so this preview could not check the credential. A live publish will be rejected until you provide one.";
    case "unresolved":
      return `The vault secret ref did not resolve${
        plan.credentialErrorCode ? ` (${plan.credentialErrorCode})` : ""
      }. A live publish would fail before reaching GitHub.`;
    default:
      return null;
  }
}

function actionDetail(action: DryRunAction): string {
  switch (action.kind) {
    case "label.upsert":
      return (action.labels ?? []).join(", ");
    case "issue.create":
      return action.title ?? "";
    case "issue.update":
      return `#${action.existingIssueNumber} · ${action.title ?? ""}`;
    case "issue.skipDuplicate":
      return `#${action.existingIssueNumber} · ${action.reason ?? "duplicate"}`;
    case "subIssue.attach":
      return `→ epic #${action.parentIssueNumber ?? "?"}`;
    default:
      return "";
  }
}

export interface DryRunPlanPanelProps {
  plan: DryRunPlan;
  /** Cap on rendered rows; the remainder is summarised as a count. */
  maxRows?: number;
}

export function DryRunPlanPanel({ plan, maxRows = 25 }: DryRunPlanPanelProps) {
  const summary = summarizeDryRunPlan(plan);
  const warning = credentialWarning(plan);
  const shown = plan.actions.slice(0, maxRows);
  const hidden = plan.actions.length - shown.length;

  return (
    <section className="mt-4 rounded border border-slate-200 p-3" data-testid="dry-run-plan">
      <h3 className="text-sm font-semibold">
        Dry-run plan — {plan.totalActions} action{plan.totalActions === 1 ? "" : "s"}
      </h3>
      <p className="mt-1 text-xs text-slate-600">
        Against {plan.targetOwner}/{plan.targetRepo} · estimated {estimatedDurationLabel(plan)} ·
        nothing was written to GitHub.
      </p>

      {warning ? (
        <p className="mt-2 rounded bg-amber-50 p-2 text-xs text-amber-800" role="status">
          {warning}
        </p>
      ) : (
        <p className="mt-2 text-xs text-emerald-700" role="status">
          GitHub credential resolved — a live publish would reach the network.
        </p>
      )}

      <ul className="mt-2 flex flex-wrap gap-2">
        {summary.map((s) => (
          <li key={s.kind} className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
            {s.kind} × {s.count}
          </li>
        ))}
      </ul>

      <ol className="mt-3 max-h-64 overflow-y-auto text-xs">
        {shown.map((action, i) => (
          <li key={`${action.kind}-${action.draftId ?? i}`} className="flex gap-2 py-0.5">
            <span className="w-6 shrink-0 text-right text-slate-400">{i + 1}</span>
            <span className="w-40 shrink-0 font-mono text-slate-700">{action.kind}</span>
            <span className="truncate text-slate-600">{actionDetail(action)}</span>
          </li>
        ))}
      </ol>
      {hidden > 0 && (
        <p className="mt-1 text-xs text-slate-500">…and {hidden} more action(s) not shown.</p>
      )}
    </section>
  );
}
