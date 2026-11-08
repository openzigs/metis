"use client";

/**
 * #1876 (Epic #1866) — an analysis's governing findings: per requirement, each
 * applicable rule of the workspace's governing documents with its status
 * (Compliant / Gap / Needs BA input), control id, the verified clause excerpt
 * and the policy revision it was checked against, and the BA's Accept / Reject
 * with a note.
 *
 * Renders only when the findings route returns findings: a 404 (the
 * `GOVERNING_DOCS_ENABLED` flag is off) or an empty list renders nothing, and
 * no request error. The header is `governingSummarySentence` (#1875), so the
 * panel never claims compliance; model prose is passed through
 * `neutraliseComplianceClaims` as well, beside the server's own pass. The clause
 * excerpt is the policy's own text and the note is the BA's own words: both are
 * shown verbatim, as quotations.
 *
 * A decision is never shown optimistically: the POST invalidates the findings,
 * and what is shown is what the server read back, decider's name included.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  GOVERNING_FINDING_NOTE_MAX,
  governingSummarySentence,
  neutraliseComplianceClaims,
  type GoverningAnalysisApplicability,
  type GoverningFinding,
  type GoverningFindingDecision,
  type GoverningFindingStatus,
} from "@metis/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { analysisApi, type ClarificationStatePayload } from "@/lib/analysis-api";
import {
  governingFindingsApi,
  governingFindingsKeys,
  type GoverningFindingRevision,
} from "@/lib/governing-findings-api";
import { useAppMutation } from "@/lib/use-app-mutation";

/** How often the findings are read again while a BA answer's re-check is running (#2017). */
export const GOVERNING_REFRESH_POLL_MS = 3000;

/** The in-page anchor of one clarifying question (`ClarificationDialog`). */
export function clarifyQuestionAnchor(questionId: string): string {
  return `#clarify-question-${questionId}`;
}

/** The Questions tab's own anchor, when no single question can be named. */
export const CLARIFYING_QUESTIONS_ANCHOR = "#clarifying-questions";

export const GOVERNING_STATUS_LABELS: Record<GoverningFindingStatus, string> = {
  compliant: "Compliant",
  gap: "Gap",
  "needs-ba-input": "Needs BA input",
};

const STATUS_VARIANT: Record<GoverningFindingStatus, "success" | "destructive" | "warning"> = {
  compliant: "success",
  gap: "destructive",
  "needs-ba-input": "warning",
};

const DECISION_LABELS: Record<GoverningFindingDecision, string> = {
  accepted: "Accepted",
  rejected: "Rejected",
};

/**
 * One summary sentence per policy revision the findings cite: N is the
 * distinct rules with a finding, M the revision's rule count, gaps the Gap
 * findings, and the rules still waiting on BA input. M is never below N (a
 * revision missing from `revisions` counts only its cited rules).
 */
export function governingSummarySentences(
  findings: readonly GoverningFinding[],
  revisions: readonly GoverningFindingRevision[],
): string[] {
  const byRevision = new Map<string, GoverningFinding[]>();
  for (const f of findings)
    byRevision.set(f.revisionId, [...(byRevision.get(f.revisionId) ?? []), f]);
  return [...byRevision].map(([revisionId, list]) => {
    const revision = revisions.find((r) => r.revisionId === revisionId);
    const applicable = new Set(list.map((f) => f.ruleId)).size;
    return governingSummarySentence({
      applicable,
      total: Math.max(applicable, revision?.rules ?? 0),
      gaps: list.filter((f) => f.status === "gap").length,
      needsInput: new Set(list.filter((f) => f.status === "needs-ba-input").map((f) => f.ruleId))
        .size,
      documentTitle: revision?.documentTitle ?? list[0]!.documentTitle,
      revisionLabel: revision?.revisionLabel ?? list[0]!.revisionLabel,
    });
  });
}

export interface RequirementFindings {
  requirementId: string;
  /** The requirement text applicability was judged on; null when not stored. */
  text: string | null;
  findings: GoverningFinding[];
}

/** The findings grouped by requirement, in the order the route returned them. */
export function groupFindingsByRequirement(
  findings: readonly GoverningFinding[],
  applicability: GoverningAnalysisApplicability | null,
): RequirementFindings[] {
  const groups = new Map<string, RequirementFindings>();
  for (const f of findings) {
    let group = groups.get(f.requirementId);
    if (!group) {
      const stored = applicability?.requirements.find((r) => r.requirementId === f.requirementId);
      group = { requirementId: f.requirementId, text: stored?.text ?? null, findings: [] };
      groups.set(f.requirementId, group);
    }
    group.findings.push(f);
  }
  return [...groups.values()];
}

/**
 * The anchor of the clarifying question a `needs-ba-input` finding waits on:
 * the question whose governing link (#1873) names this finding's requirement
 * and rule, latest round first. Without one, the Questions tab itself.
 */
export function clarifyingQuestionHref(
  finding: Pick<GoverningFinding, "requirementId" | "ruleId">,
  state: ClarificationStatePayload | null | undefined,
): string {
  for (const round of [...(state?.rounds ?? [])].reverse()) {
    const question = (round.questions ?? []).find(
      (q) =>
        q.governing?.requirementId === finding.requirementId &&
        q.governing.ruleIds.includes(finding.ruleId),
    );
    if (question) return clarifyQuestionAnchor(question.id);
  }
  return CLARIFYING_QUESTIONS_ANCHOR;
}

function formatDecidedAt(iso: string | null): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? null
    : at.toLocaleDateString(undefined, { dateStyle: "medium" });
}

export function GoverningFindingsPanel({
  projectId,
  analysisId,
  canDecide,
}: {
  projectId: string;
  analysisId: string;
  /** The user holds `analysis.run`, which the decision route requires. */
  canDecide: boolean;
}): React.ReactElement | null {
  const findingsQuery = useQuery({
    queryKey: governingFindingsKeys.findings(analysisId),
    queryFn: () => governingFindingsApi.list(projectId, analysisId),
    retry: false,
    refetchInterval: (query) => (query.state.data?.refreshing ? GOVERNING_REFRESH_POLL_MS : false),
  });
  const findings = findingsQuery.data?.findings ?? [];
  const hasFindings = findings.length > 0;
  const needsInput = findings.some((f) => f.status === "needs-ba-input");

  const applicabilityQuery = useQuery({
    queryKey: governingFindingsKeys.applicability(analysisId),
    queryFn: () => governingFindingsApi.applicability(projectId, analysisId),
    enabled: hasFindings,
    retry: false,
  });
  // The Questions tab's own query (`EnhancementResults`): one cache entry.
  const clarification = useQuery({
    queryKey: ["analyses", analysisId, "clarify"],
    queryFn: async () => (await analysisApi.getClarification(projectId, analysisId)).state ?? null,
    enabled: needsInput,
    retry: false,
    refetchOnWindowFocus: false,
  });

  if (findingsQuery.isError) {
    return (
      <p className="text-sm text-destructive" role="alert" data-testid="governing-findings-error">
        Governing findings could not be loaded.
      </p>
    );
  }
  if (!findingsQuery.data || !hasFindings) return null;

  const sentences = governingSummarySentences(findings, findingsQuery.data.revisions ?? []);
  const groups = groupFindingsByRequirement(findings, applicabilityQuery.data ?? null);

  return (
    <section
      aria-labelledby="governing-findings-heading"
      className="space-y-3"
      data-testid="governing-findings"
    >
      <div>
        <h4
          id="governing-findings-heading"
          className="text-sm font-semibold uppercase tracking-wide text-muted-foreground"
        >
          Governing rules
        </h4>
        {sentences.map((sentence) => (
          <p
            key={sentence}
            className="mt-1 text-sm text-foreground"
            data-testid="governing-summary-sentence"
          >
            {sentence}
          </p>
        ))}
        {findingsQuery.data.refreshing ? (
          <p className="mt-1 text-xs text-muted-foreground" role="status">
            Re-checking after a BA answer. These findings update when it finishes.
          </p>
        ) : null}
      </div>
      {groups.map((group) => (
        <div
          key={group.requirementId}
          role="group"
          aria-label={`Governing rules for ${group.requirementId}`}
          className="rounded border border-border bg-muted/30 p-3"
        >
          <h5 className="text-sm font-medium text-foreground">{group.requirementId}</h5>
          {group.text ? (
            <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{group.text}</p>
          ) : null}
          <ul className="mt-2 space-y-2">
            {group.findings.map((finding) => (
              <li key={finding.id}>
                <GoverningFindingItem
                  projectId={projectId}
                  analysisId={analysisId}
                  finding={finding}
                  canDecide={canDecide}
                  questionHref={
                    finding.status === "needs-ba-input"
                      ? clarifyingQuestionHref(finding, clarification.data)
                      : null
                  }
                />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

function GoverningFindingItem({
  projectId,
  analysisId,
  finding,
  canDecide,
  questionHref,
}: {
  projectId: string;
  analysisId: string;
  finding: GoverningFinding;
  canDecide: boolean;
  questionHref: string | null;
}): React.ReactElement {
  const label = GOVERNING_STATUS_LABELS[finding.status];
  const [note, setNote] = useState(finding.decisionNote ?? "");
  const decide = useAppMutation({
    mutationFn: (decision: GoverningFindingDecision) =>
      governingFindingsApi.decide(projectId, analysisId, finding.id, {
        decision,
        ...(note.trim() ? { note: note.trim() } : {}),
      }),
    successMessage: (_data, decision) =>
      `Finding ${finding.controlId} ${DECISION_LABELS[decision].toLowerCase()}`,
    errorMessage: "Could not record the decision",
    invalidateKeys: [governingFindingsKeys.findings(analysisId)],
  });
  const noteId = `governing-note-${finding.id}`;
  const decidedOn = formatDecidedAt(finding.decidedAt);

  return (
    <article
      aria-label={`${finding.controlId}: ${label}`}
      className="rounded border border-border bg-background p-3"
      data-testid="governing-finding"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={STATUS_VARIANT[finding.status]}>
          <span className="sr-only">Status: </span>
          {label}
        </Badge>
        <span className="font-mono text-xs text-foreground">{finding.controlId}</span>
        {finding.clauseRef ? (
          <span className="text-xs text-muted-foreground">{finding.clauseRef}</span>
        ) : null}
        <span className="text-xs text-muted-foreground" data-testid="governing-finding-revision">
          {finding.documentTitle} {finding.revisionLabel}
        </span>
      </div>

      {finding.clauseExcerpt ? (
        <blockquote
          aria-label={`Clause ${finding.clauseRef || finding.controlId}`}
          className="mt-2 border-l-2 border-border pl-2 text-xs italic text-muted-foreground"
        >
          {finding.clauseExcerpt}
        </blockquote>
      ) : finding.citationDropped ? (
        <p className="mt-2 text-xs text-warning">
          The cited clause could not be found in the policy text, so the citation was dropped.
        </p>
      ) : null}

      <p className="mt-2 text-sm text-foreground">
        {neutraliseComplianceClaims(finding.reasoning)}
      </p>

      {questionHref ? (
        <p className="mt-2 text-sm">
          {finding.businessQuestion ? (
            <span className="text-foreground">
              {neutraliseComplianceClaims(finding.businessQuestion)}{" "}
            </span>
          ) : null}
          <a href={questionHref} className="text-primary underline underline-offset-2">
            Answer the clarifying question
          </a>
        </p>
      ) : null}

      {finding.decision ? (
        <div
          className="mt-2 text-xs text-muted-foreground"
          data-testid="governing-finding-decision"
        >
          <p>
            <span className="font-medium text-foreground">{DECISION_LABELS[finding.decision]}</span>{" "}
            by {finding.decidedByName ?? "a former user"}
            {decidedOn ? ` on ${decidedOn}` : ""}
          </p>
          {finding.decisionNote ? (
            <blockquote aria-label="Decision note" className="mt-1 border-l-2 border-border pl-2">
              {finding.decisionNote}
            </blockquote>
          ) : null}
        </div>
      ) : null}

      {canDecide ? (
        <div className="mt-3 space-y-2">
          <Label htmlFor={noteId} className="text-xs">
            Note for {finding.controlId} (optional)
          </Label>
          <Textarea
            id={noteId}
            value={note}
            maxLength={GOVERNING_FINDING_NOTE_MAX}
            rows={2}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={decide.isPending}
              onClick={() => decide.mutate("accepted")}
            >
              Accept
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={decide.isPending}
              onClick={() => decide.mutate("rejected")}
            >
              Reject
            </Button>
          </div>
        </div>
      ) : null}
    </article>
  );
}
