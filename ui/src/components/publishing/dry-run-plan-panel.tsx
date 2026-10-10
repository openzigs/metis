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

/**
 * #744 — the approval-gate warning to show, or `null` when the gate is off or
 * passes. A plan persisted before #744 carries no verdict and shows none.
 */
export function approvalGateWarning(plan: DryRunPlan): string | null {
  const gate = plan.approvalGate;
  if (!gate) return null;
  switch (gate.check) {
    case "blocked": {
      const n = gate.blockedDraftIds.length;
      return `Approval required: ${n} draft${n === 1 ? "" : "s"} in this batch ${
        n === 1 ? "has" : "have"
      } no approved, up-to-date review. A live publish will be refused (APPROVAL_REQUIRED) until ${
        n === 1 ? "it is" : "they are"
      } approved.`;
    }
    case "unavailable":
      return "The approval gate could not be checked, so a live publish would be refused. Retry later.";
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
  const gateWarning = approvalGateWarning(plan);
  const shown = plan.actions.slice(0, maxRows);
  const hidden = plan.actions.length - shown.length;

  return (
    <section className="mt-4 rounded border border-border p-3" data-testid="dry-run-plan">
      <h3 className="text-sm font-semibold">
        Dry-run plan — {plan.totalActions} action{plan.totalActions === 1 ? "" : "s"}
      </h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Against {plan.targetOwner}/{plan.targetRepo} · estimated {estimatedDurationLabel(plan)} ·
        nothing was written to GitHub.
      </p>

      {warning ? (
        <p className="mt-2 rounded bg-warning-muted p-2 text-xs text-warning" role="status">
          {warning}
        </p>
      ) : (
        <p className="mt-2 text-xs text-success" role="status">
          GitHub credential resolved — a live publish would reach the network.
        </p>
      )}

      {gateWarning && (
        <p
          className="mt-2 rounded bg-warning-muted p-2 text-xs text-warning"
          role="status"
          data-testid="dry-run-approval-gate"
        >
          {gateWarning}
        </p>
      )}

      <ul className="mt-2 flex flex-wrap gap-2">
        {summary.map((s) => (
          <li key={s.kind} className="rounded bg-muted px-2 py-0.5 text-xs text-foreground">
            {s.kind} × {s.count}
          </li>
        ))}
      </ul>

      <ol className="mt-3 max-h-64 overflow-y-auto text-xs">
        {shown.map((action, i) => (
          <li key={`${action.kind}-${action.draftId ?? i}`} className="flex gap-2 py-0.5">
            <span className="w-6 shrink-0 text-right text-muted-foreground">{i + 1}</span>
            <span className="w-40 shrink-0 font-mono text-foreground">{action.kind}</span>
            <span className="truncate text-muted-foreground">{actionDetail(action)}</span>
            {action.blockedByApprovalGate && (
              <span className="shrink-0 rounded bg-warning-muted px-1 text-warning">
                needs approval
              </span>
            )}
          </li>
        ))}
      </ol>
      {hidden > 0 && (
        <p className="mt-1 text-xs text-muted-foreground">
          …and {hidden} more action(s) not shown.
        </p>
      )}
    </section>
  );
}
