"use client";

/**
 * Issue #2341 (epic #2328) — the change request's step header: eight steps,
 * each with its state in words and a link to the screen where that step is
 * done. States come from `deriveChangeRequestSteps`; this component only loads
 * the facts the run snapshot does not carry (governing findings, the portfolio,
 * the publish drafts) and renders them.
 *
 * Keyboard: every step is a link in an ordered list, so Tab walks the steps in
 * order. Each state is a word ("Needs you"), with an icon and colour only as
 * reinforcement.
 */
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Check, CircleDashed, CircleDot, AlertCircle, MinusCircle } from "lucide-react";
import type { AnalysisSnapshot, RequirementReviewStatus } from "@/lib/analysis-api";
import { governingFindingsApi, governingFindingsKeys } from "@/lib/governing-findings-api";
import { productsApi } from "@/lib/products-api";
import { publishingApi } from "@/lib/publishing-api";
import { cn } from "@/lib/utils";
import {
  STEP_STATE_LABELS,
  agentState,
  deriveChangeRequestSteps,
  runOptionsFromMetadata,
  stepHref,
  type ChangeRequestFacts,
  type ChangeRequestStepState,
} from "@/components/analysis/change-request-steps";

const STATE_STYLE: Record<ChangeRequestStepState, { icon: typeof Check; className: string }> = {
  done: { icon: Check, className: "border-success/40 text-success" },
  "needs-you": { icon: AlertCircle, className: "border-warning/60 text-warning" },
  "in-progress": { icon: CircleDot, className: "border-info/50 text-info" },
  "not-started": { icon: CircleDashed, className: "border-border text-muted-foreground" },
  "not-applicable": { icon: MinusCircle, className: "border-dashed text-muted-foreground" },
};

/** The run's requirements tallied by review status. */
export function requirementTally(
  requirements: ReadonlyArray<{ reviewStatus: RequirementReviewStatus }>,
): Record<RequirementReviewStatus, number> {
  const tally = { draft: 0, approved: 0, rejected: 0, deferred: 0 };
  for (const r of requirements) tally[r.reviewStatus] += 1;
  return tally;
}

interface Props {
  projectId: string;
  snapshot: AnalysisSnapshot;
  /** Approval checkpoints still pending; `undefined` while not loaded. */
  pendingApprovals: number | undefined;
}

export function ChangeRequestStepHeader({ projectId, snapshot, pendingApprovals }: Props) {
  const analysisId = snapshot.id;
  // The same query (and cache entry) the policy findings panel reads.
  const governing = useQuery({
    queryKey: governingFindingsKeys.findings(analysisId),
    queryFn: () => governingFindingsApi.list(projectId, analysisId),
    retry: false,
  });
  const products = useQuery({
    queryKey: ["products", "count"],
    queryFn: () => productsApi.list({ pageSize: 1 }),
    retry: false,
  });
  // The publish page's own key, so the two share one read.
  const drafts = useQuery({
    queryKey: ["publishing", "drafts", projectId],
    queryFn: () => publishingApi.listDrafts(projectId),
    retry: false,
  });

  const options = runOptionsFromMetadata(snapshot.metadata);
  const requirementIds = new Set(snapshot.requirements.map((r) => r.id));
  // A payload of an unexpected shape (an older server) is "not known", never a crash.
  const runDrafts = Array.isArray(drafts.data)
    ? drafts.data.filter((d) => d.requirementId && requirementIds.has(d.requirementId))
    : undefined;
  const findings = Array.isArray(governing.data?.findings) ? governing.data.findings : null;
  const productTotal = typeof products.data?.total === "number" ? products.data.total : null;
  const facts: ChangeRequestFacts = {
    status: snapshot.status,
    agentKeys: options.agentKeys,
    documentAgent: agentState(snapshot.agentResults, "document"),
    codeAgent: agentState(snapshot.agentResults, "code"),
    clarificationEnabled: options.clarificationEnabled,
    openQuestions: options.openQuestions,
    requirementCounts: requirementTally(snapshot.requirements),
    pendingApprovals: pendingApprovals ?? null,
    policy: findings
      ? {
          findings: findings.length,
          needsInput: findings.filter((f) => f.status === "needs-ba-input").length,
          checked: governing.data?.checked === true,
        }
      : null,
    products: productTotal,
    drafts: runDrafts
      ? {
          total: runDrafts.length,
          published: runDrafts.filter((d) => d.status === "published").length,
        }
      : null,
  };
  const steps = deriveChangeRequestSteps(facts);
  const current = steps.find((s) => s.state === "needs-you" || s.state === "in-progress");

  return (
    <nav aria-label="Change request steps" data-testid="change-request-steps">
      <ol className="flex flex-wrap gap-2">
        {steps.map((step, i) => {
          const style = STATE_STYLE[step.state];
          const Icon = style.icon;
          return (
            <li key={step.key} className="min-w-0">
              <Link
                href={stepHref(step.key, projectId, analysisId)}
                aria-current={current?.key === step.key ? "step" : undefined}
                title={step.reason}
                data-testid={`change-request-step-${step.key}`}
                data-state={step.state}
                className={cn(
                  "flex flex-col rounded-md border px-2 py-1 text-xs hover:bg-muted/40",
                  "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  style.className,
                )}
              >
                <span className="font-medium text-foreground">
                  {i + 1}. {step.label}
                </span>
                <span className="flex items-center gap-1">
                  <Icon className="h-3 w-3" aria-hidden />
                  {STEP_STATE_LABELS[step.state]}
                </span>
                <span className="sr-only">: {step.reason}</span>
              </Link>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
