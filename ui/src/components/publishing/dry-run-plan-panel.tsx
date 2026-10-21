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
import { useState } from "react";
import type { DryRunAction, DryRunPlan } from "@metis/shared";
import { Button } from "@/components/ui/button";

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
      // #1106 — the preview cannot read the tracker; the publish checks.
      return action.mayMatchIssueNumber !== undefined
        ? `${action.title ?? ""} · may match existing issue #${action.mayMatchIssueNumber}, checked at publish`
        : (action.title ?? "");
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

/** One row of the plan list: the action and its 1-based place in the run. */
export interface DryRunPlanRow {
  action: DryRunAction;
  step: number;
}

/**
 * #1064 — the order the plan is LISTED in. The run upserts every label before
 * it creates an issue, so a plan cut at 25 rows showed 25 label upserts and hid
 * every issue title behind "…and 6 more". The titles are what a reviewer came
 * to check, so the rows that carry one (create, update, skip) are listed
 * first, then the sub-issue attaches, then the label upserts — each group in
 * run order. An attach row has no title and every feature under an epic adds
 * one, so listed among the issues they pushed titles past the cut again from 13
 * features; behind them, 24 features and their epic fit in 25 rows. Each row
 * keeps its place in the run as `step`, so the list never claims an order the
 * run does not have.
 */
export function orderDryRunRows(actions: readonly DryRunAction[]): DryRunPlanRow[] {
  const rows = actions.map((action, i) => ({ action, step: i + 1 }));
  const group = (kind: string) =>
    kind === "label.upsert" ? 2 : kind === "subIssue.attach" ? 1 : 0;
  return [0, 1, 2].flatMap((g) => rows.filter((r) => group(r.action.kind) === g));
}

/** #1136 — the plain-language name of a collapsed step, singular and plural. */
const STEP_NAMES: Readonly<Record<string, [string, string]>> = {
  "label.upsert": ["label update", "label updates"],
  "subIssue.attach": ["link to the epic", "links to the epic"],
};

/**
 * What the rows left out are, by kind, in words an analyst reads:
 * `33 links to the epic, 51 label updates`.
 */
export function describeHiddenRows(hidden: readonly DryRunPlanRow[]): string {
  const counts = new Map<string, number>();
  for (const row of hidden) counts.set(row.action.kind, (counts.get(row.action.kind) ?? 0) + 1);
  return [...counts.entries()]
    .map(([kind, count]) => {
      const [one, many] = STEP_NAMES[kind] ?? ["other step", "other steps"];
      return `${count} ${count === 1 ? one : many}`;
    })
    .join(", ");
}

/**
 * PR #1275 review — the step a row or chip names, in plain words for an
 * analyst. The raw kind stays on the element's `title` for whoever needs it.
 */
const KIND_LABELS: Readonly<Record<string, string>> = {
  "issue.create": "Create issue",
  "issue.update": "Update issue",
  "issue.skipDuplicate": "Skip (already exists)",
  "subIssue.attach": "Link to epic",
  "label.upsert": "Add labels",
};

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

/** #1136 — a row that names an issue: create, update or skip-as-duplicate. */
function carriesTitle(row: DryRunPlanRow): boolean {
  return row.action.kind !== "label.upsert" && row.action.kind !== "subIssue.attach";
}

/**
 * #1136 — which rows to list. Every row that names an issue is listed, however
 * many there are: they are what a reviewer reads before publishing, and a
 * 34-issue plan used to hide 9 of them behind the 25-row cut. Only the rows
 * with no title (label updates, links to the epic) fill the remaining room and
 * collapse past it.
 */
export function splitDryRunRows(
  rows: readonly DryRunPlanRow[],
  maxRows: number,
): { shown: DryRunPlanRow[]; hidden: DryRunPlanRow[] } {
  const titled = rows.filter(carriesTitle);
  const untitled = rows.filter((r) => !carriesTitle(r));
  const room = Math.max(0, maxRows - titled.length);
  return { shown: [...titled, ...untitled.slice(0, room)], hidden: untitled.slice(room) };
}

export interface DryRunPlanPanelProps {
  plan: DryRunPlan;
  /**
   * Rows listed before the rest collapse behind "Show all steps". Rows that
   * name an issue are never collapsed (#1136), so the list can exceed this.
   */
  maxRows?: number;
}

/**
 * #1103 — the Jira leg of a dry run: what each Jira issue is created with, and
 * the hidden `metis.source` property that routes it back to its requirement.
 */
export function JiraDryRunSection({ jira }: { jira: NonNullable<DryRunPlan["jira"]> }) {
  const withProperty = jira.issues.filter((i) => i.sourceProperty !== null).length;
  return (
    <div className="mt-3 border-t border-border pt-3" data-testid="dry-run-jira">
      <h4 className="text-sm font-semibold">
        Jira — {jira.issues.length} issue{jira.issues.length === 1 ? "" : "s"} in project{" "}
        <span className="font-mono">{jira.projectKey}</span>
      </h4>
      <p className="mt-1 text-xs text-muted-foreground" data-testid="dry-run-jira-source">
        {withProperty === jira.issues.length
          ? "Each issue"
          : `${withProperty} of ${jira.issues.length} issues`}{" "}
        also gets the issue property <span className="font-mono">metis.source</span>, holding the
        METIS project, analysis and requirement it came from. It is not shown in the description.
        Nothing was written to Jira.
      </p>
      <ul className="mt-2 list-disc pl-4 text-xs" aria-label="Jira issues">
        {jira.issues.map((i) => (
          <li key={i.draftId}>
            {i.issueType}: {i.title}
            {i.labels.length > 0 ? (
              <span className="text-muted-foreground"> · labels {i.labels.join(", ")}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function DryRunPlanPanel({ plan, maxRows = 25 }: DryRunPlanPanelProps) {
  // #1103 — a Jira-only project's plan has no GitHub leg to describe.
  if (plan.jira && plan.actions.length === 0) {
    return (
      <section className="mt-4 rounded border border-border p-3" data-testid="dry-run-plan">
        <h3 className="text-sm font-semibold">Dry-run plan</h3>
        <JiraDryRunSection jira={plan.jira} />
      </section>
    );
  }
  return <GitHubDryRunPlan plan={plan} maxRows={maxRows} />;
}

function GitHubDryRunPlan({ plan, maxRows = 25 }: DryRunPlanPanelProps) {
  const summary = summarizeDryRunPlan(plan);
  const warning = credentialWarning(plan);
  const gateWarning = approvalGateWarning(plan);
  const rows = orderDryRunRows(plan.actions);
  const [expanded, setExpanded] = useState(false);
  const split = splitDryRunRows(rows, maxRows);
  const shown = expanded ? rows : split.shown;
  const hidden = expanded ? [] : split.hidden;
  const collapsible = split.hidden.length > 0;
  const reordered = shown.some((row, i) => row.step !== i + 1);

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
          <li
            key={s.kind}
            title={s.kind}
            className="rounded bg-muted px-2 py-0.5 text-xs text-foreground"
          >
            {kindLabel(s.kind)} × {s.count}
          </li>
        ))}
      </ul>

      {reordered && (
        <p className="mt-3 text-xs text-muted-foreground" data-testid="dry-run-order-note">
          Issues are listed first, then sub-issue links, then labels. The run upserts labels before
          it creates issues; the number on each row is its place in the run.
        </p>
      )}
      <ol className="mt-3 max-h-96 overflow-y-auto text-xs" aria-label="Dry-run steps">
        {shown.map(({ action, step }) => (
          // `value` makes the list item's own number the run step, so a screen
          // reader announces the number that is printed; the printed copy is
          // hidden from it so the step is not read twice.
          <li key={step} value={step} className="flex gap-2 py-0.5" data-testid="dry-run-row">
            <span aria-hidden="true" className="w-6 shrink-0 text-right text-muted-foreground">
              {step}
            </span>
            <span className="w-40 shrink-0 text-foreground" title={action.kind}>
              {kindLabel(action.kind)}
            </span>
            <span className="min-w-0 break-words text-muted-foreground">
              {actionDetail(action)}
            </span>
            {action.blockedByApprovalGate && (
              <span className="shrink-0 rounded bg-warning-muted px-1 text-warning">
                needs approval
              </span>
            )}
          </li>
        ))}
      </ol>
      {hidden.length > 0 && (
        <p className="mt-1 text-xs text-muted-foreground" data-testid="dry-run-hidden">
          {hidden.length} more {hidden.length === 1 ? "step is" : "steps are"} not listed:{" "}
          {describeHiddenRows(hidden)}.
        </p>
      )}
      {collapsible && (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto px-0 text-xs"
          aria-expanded={expanded}
          onClick={() => setExpanded((e) => !e)}
          data-testid="dry-run-toggle"
        >
          {expanded ? "Show fewer steps" : `Show all ${rows.length} steps`}
        </Button>
      )}
      {plan.jira ? <JiraDryRunSection jira={plan.jira} /> : null}
    </section>
  );
}
