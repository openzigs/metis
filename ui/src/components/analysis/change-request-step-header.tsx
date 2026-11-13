"use client";

/**
 * Issue #2341 (epic #2328) — the change request's step header: eight steps,
 * each with its state in words and a link to the screen where that step is
 * done. States come from `deriveChangeRequestSteps` (`@metis/shared`, the rules
 * the server shares); this component only loads the facts the run snapshot does
 * not carry (governing findings, the portfolio and this run's checks of it, the
 * publish drafts, and #2345 the impact analyses started from it) and renders
 * them. A fact that is still loading, or whose read failed or was refused,
 * reads "Unknown", never as a state the step might not be in.
 *
 * Keyboard: every step is a link in an ordered list, so Tab walks the steps in
 * order. Each state is a word ("Needs you"), with an icon and colour only as
 * reinforcement.
 */
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Check, CircleDashed, CircleDot, AlertCircle, MinusCircle, HelpCircle } from "lucide-react";
import {
  STEP_STATE_LABELS,
  agentState,
  deriveChangeRequestSteps,
  latestResult,
  portfolioCheckTally,
  questionsWaitingLabel,
  requirementTally,
  runOptionsFromMetadata,
  type ChangeRequestFacts,
  type ChangeRequestStepState,
  type UnknownFact,
} from "@metis/shared";
import type { AnalysisSnapshot } from "@/lib/analysis-api";
import { governingFindingsApi, governingFindingsKeys } from "@/lib/governing-findings-api";
import { impactAnalysisApi } from "@/lib/impact-analysis-api";
import { impactAnalysisKeys } from "@/lib/impact-analysis-hooks";
import { portfolioApi } from "@/lib/portfolio-api";
import { portfolioKeys } from "@/lib/portfolio-hooks";
import { productsApi } from "@/lib/products-api";
import { publishingApi } from "@/lib/publishing-api";
import { useCodeConnected } from "@/lib/use-code-connected";
import { cn } from "@/lib/utils";
import { stepHref } from "@/components/analysis/change-request-steps";

const STATE_STYLE: Record<ChangeRequestStepState, { icon: typeof Check; className: string }> = {
  done: { icon: Check, className: "border-success/40 text-success" },
  "needs-you": { icon: AlertCircle, className: "border-warning/60 text-warning" },
  "in-progress": { icon: CircleDot, className: "border-info/50 text-info" },
  "not-started": { icon: CircleDashed, className: "border-border text-muted-foreground" },
  "not-applicable": { icon: MinusCircle, className: "border-dashed text-muted-foreground" },
  unknown: { icon: HelpCircle, className: "border-dashed text-muted-foreground" },
};

/** A query's fact while it is not known: still loading, or the read failed or was refused. */
function unknownFact(q: { isError: boolean }): UnknownFact {
  return q.isError ? "failed" : "loading";
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
  // #2341 — the portfolio checks started from this run's requirements.
  const checks = useQuery({
    queryKey: portfolioKeys.runList(analysisId),
    queryFn: () => portfolioApi.listForRun(analysisId),
    retry: false,
  });
  // #2345 — the impact analyses started from this change request, newest first;
  // the same key (and cache entry) as its "Impact and portfolio" card.
  const impacts = useQuery({
    queryKey: impactAnalysisKeys.changeRequestList(analysisId),
    queryFn: () => impactAnalysisApi.listForChangeRequest(analysisId),
    retry: false,
  });
  // The publish page's own key, so the two share one read.
  const drafts = useQuery({
    queryKey: ["publishing", "drafts", projectId],
    queryFn: () => publishingApi.listDrafts(projectId),
    retry: false,
  });

  // #2454 — the run's record, or the live probe while the run has not written it.
  const codeConnected = useCodeConnected(projectId, snapshot);
  const options = runOptionsFromMetadata(snapshot.metadata);
  const requirementIds = new Set(snapshot.requirements.map((r) => r.id));
  const productTotal = typeof products.data?.total === "number" ? products.data.total : null;

  // `list` answers `null` for a 404, which is the policy check switched off. A
  // failed or refused read is an error and reads "unknown", never "off"; so
  // does a payload of an unexpected shape (an older server).
  let policy: ChangeRequestFacts["policy"];
  if (!governing.isSuccess) policy = unknownFact(governing);
  else if (governing.data === null) policy = "off";
  else if (!Array.isArray(governing.data?.findings)) policy = "failed";
  else {
    const findings = governing.data.findings;
    policy = {
      findings: findings.length,
      needsInput: findings.filter((f) => f.status === "needs-ba-input").length,
      checked: governing.data.checked === true,
    };
  }

  // A user without `issue.draft` is refused the drafts (403): that is not
  // knowing, not "nothing drafted", so Hand-off reads "unknown".
  let handoff: ChangeRequestFacts["drafts"];
  if (!drafts.isSuccess) handoff = unknownFact(drafts);
  else if (!Array.isArray(drafts.data)) handoff = "failed";
  else {
    const runDrafts = drafts.data.filter(
      (d) => d.requirementId && requirementIds.has(d.requirementId),
    );
    handoff = {
      total: runDrafts.length,
      published: runDrafts.filter((d) => d.status === "published").length,
    };
  }

  // A refused or malformed read is not knowing, never "no checks".
  let portfolioChecks: ChangeRequestFacts["portfolioChecks"];
  if (!checks.isSuccess) portfolioChecks = unknownFact(checks);
  else if (!Array.isArray(checks.data)) portfolioChecks = "failed";
  else portfolioChecks = portfolioCheckTally(checks.data);

  // #2345 — the newest impact analysis decides the Impact step, once read.
  let latestImpact: ChangeRequestFacts["latestImpact"];
  if (!impacts.isSuccess) latestImpact = unknownFact(impacts);
  else if (!Array.isArray(impacts.data)) latestImpact = "failed";
  else latestImpact = latestResult(impacts.data);
  const latest = {
    impact: typeof latestImpact === "object" ? latestImpact?.id : null,
    portfolio: typeof portfolioChecks === "object" ? portfolioChecks.latest?.id : null,
  };

  const facts: ChangeRequestFacts = {
    status: snapshot.status,
    agentKeys: options.agentKeys,
    documentAgent: agentState(snapshot.agentResults, "document"),
    codeAgent: agentState(snapshot.agentResults, "code"),
    clarificationEnabled: options.clarificationEnabled,
    openQuestions: options.openQuestions,
    requirementCounts: requirementTally(snapshot.requirements),
    pendingApprovals: pendingApprovals ?? null,
    policy,
    products: productTotal,
    portfolioChecks,
    drafts: handoff,
    latestImpact,
    // #2454 — a Documents-only project's Impact step does not say code was mapped.
    codeConnected,
  };
  const steps = deriveChangeRequestSteps(facts);
  const waitingQuestions = options.openQuestions ?? 0;
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
                href={stepHref(step.key, projectId, analysisId, latest)}
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
                  {/* #2343 — open questions read as the state they are, with the count. */}
                  {step.key === "questions" && waitingQuestions > 0
                    ? questionsWaitingLabel(waitingQuestions)
                    : STEP_STATE_LABELS[step.state]}
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
