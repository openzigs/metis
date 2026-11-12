"use client";

/**
 * #1876 (Epic #1866) — an analysis's governing findings: per requirement, each
 * applicable rule of the workspace's governing documents with its status
 * (Compliant / Gap / Needs BA input), control id, the verified clause excerpt
 * and the policy revision it was checked against, and the BA's Accept / Reject
 * with a note.
 *
 * A 404 (the `GOVERNING_DOCS_ENABLED` flag is off) renders nothing, and no
 * request error. #2113 — an empty list says whether the check ran (`checked`):
 * "not checked" is never shown as "checked, nothing applied". The header is `governingSummarySentence` (#1875), so the
 * panel never claims compliance; model prose is passed through
 * `neutraliseComplianceClaims` as well, beside the server's own pass. The clause
 * excerpt is the policy's own text and the note is the BA's own words: both are
 * shown verbatim, as quotations.
 *
 * A decision is never shown optimistically: the POST invalidates the findings,
 * and what is shown is what the server read back, decider's name included.
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  GOVERNING_FINDING_NOTE_MAX,
  governingStaleNote,
  governingSummarySentence,
  neutraliseComplianceClaims,
  type GoverningAnalysisApplicability,
  type GoverningFinding,
  type GoverningFindingDecision,
  type GoverningFindingStatus,
  type GoverningStaleRequirement,
} from "@metis/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { renderedClarifyingQuestionIds } from "@/components/analysis/ClarificationDialog";
import { GoverningPreviewNotice } from "@/components/governing/governing-preview-notice";
import { analysisApi, type ClarificationStatePayload } from "@/lib/analysis-api";
import { projectsApi } from "@/lib/projects-api";
import { queryKeys } from "@/lib/query-keys";
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
): { revisionId: string; sentence: string }[] {
  const byRevision = new Map<string, GoverningFinding[]>();
  for (const f of findings)
    byRevision.set(f.revisionId, [...(byRevision.get(f.revisionId) ?? []), f]);
  return [...byRevision].map(([revisionId, list]) => {
    const revision = revisions.find((r) => r.revisionId === revisionId);
    const applicable = new Set(list.map((f) => f.ruleId)).size;
    const sentence = governingSummarySentence({
      applicable,
      total: Math.max(applicable, revision?.rules ?? 0),
      gaps: list.filter((f) => f.status === "gap").length,
      needsInput: new Set(list.filter((f) => f.status === "needs-ba-input").map((f) => f.ruleId))
        .size,
      documentTitle: revision?.documentTitle ?? list[0]!.documentTitle,
      revisionLabel: revision?.revisionLabel ?? list[0]!.revisionLabel,
    });
    return { revisionId, sentence };
  });
}

export interface RequirementFindings {
  requirementId: string;
  /**
   * #2222 — the title of a stored requirement re-checked on its own wording;
   * null for a requirement as the analysis analysed it (named by its id).
   */
  title: string | null;
  /** The requirement text applicability was judged on; null when not stored. */
  text: string | null;
  findings: GoverningFinding[];
  /** #2222 — the stored requirements edited since any of these findings judged them, once each. */
  stale: GoverningStaleRequirement[];
}

/** The findings grouped by requirement, in the order the route returned them. */
export function groupFindingsByRequirement(
  findings: readonly GoverningFinding[],
  applicability: GoverningAnalysisApplicability | null,
  titles: Readonly<Record<string, string>> = {},
): RequirementFindings[] {
  const groups = new Map<string, RequirementFindings>();
  for (const f of findings) {
    let group = groups.get(f.requirementId);
    if (!group) {
      const stored = applicability?.requirements.find((r) => r.requirementId === f.requirementId);
      group = {
        requirementId: f.requirementId,
        title: titles[f.requirementId] ?? null,
        text: stored?.text ?? null,
        findings: [],
        stale: [],
      };
      groups.set(f.requirementId, group);
    }
    group.findings.push(f);
    for (const s of f.stale ?? []) {
      if (!group.stale.some((x) => x.requirementId === s.requirementId)) group.stale.push(s);
    }
  }
  return [...groups.values()];
}

/** The BA answer a finding's rule was re-judged on, and the reason judged on it (#2087). */
export interface AnswerSettlement {
  answer: string;
  reason: string;
}

/**
 * #2087 — why a BA's answer did not rule this finding's rule out: the stored
 * pair was `uncertain`, an answer was judged onto it (#1873), and the rule
 * applies. Its `reason` is that judgement's, and names a contradiction with
 * the requirement's text when there was one (#2078). `null` for a rule no
 * answer re-judged, and for an answer only recorded on a rule that already
 * applied (#2059), whose reason is applicability's own. #2068 — answers
 * recorded later keep the first one's reason, so the first answer is named.
 */
export function answerSettlementOf(
  finding: Pick<GoverningFinding, "requirementId" | "ruleId">,
  applicability: GoverningAnalysisApplicability | null,
): AnswerSettlement | null {
  const decision = applicability?.requirements
    .find((r) => r.requirementId === finding.requirementId)
    ?.decisions.find((d) => d.ruleId === finding.ruleId);
  const settled = decision?.settled;
  if (!decision || !settled || decision.verdict !== "applies") return null;
  if (settled.previousVerdict !== "uncertain") return null;
  const answer = (settled.earlier?.[0]?.answer ?? settled.answer).trim();
  const reason = decision.reason.trim();
  return answer && reason ? { answer, reason } : null;
}

/**
 * The anchor of the clarifying question a `needs-ba-input` finding waits on:
 * the question whose governing link (#1873) names this finding's requirement
 * and rule, latest round first. Only a question the Questions tab renders
 * counts (#2032): an earlier round's question is not on the page while a later
 * round is open, so its anchor would lead nowhere. Without one, the Questions
 * tab itself.
 */
export function clarifyingQuestionHref(
  finding: Pick<GoverningFinding, "requirementId" | "ruleId">,
  state: ClarificationStatePayload | null | undefined,
): string {
  if (!state) return CLARIFYING_QUESTIONS_ANCHOR;
  const rendered = renderedClarifyingQuestionIds(state);
  for (const round of [...state.rounds].reverse()) {
    const question = (round.questions ?? []).find(
      (q) =>
        rendered.has(q.id) &&
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
  analysisStatus,
}: {
  projectId: string;
  analysisId: string;
  /** The analysis's status; while it runs nothing is stored, so no empty state is said (#2113). */
  analysisStatus?: string;
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
  // #2087 — a BA answer's settle is stored before its findings re-check
  // starts, so once the re-check is seen to finish the applicability is read
  // again: the reason a settled finding shows is never the pre-answer one.
  const queryClient = useQueryClient();
  const refreshing = findingsQuery.data?.refreshing ?? false;
  const wasRefreshing = useRef(refreshing);
  useEffect(() => {
    if (wasRefreshing.current && !refreshing) {
      void queryClient.invalidateQueries({
        queryKey: governingFindingsKeys.applicability(analysisId),
      });
    }
    wasRefreshing.current = refreshing;
  }, [refreshing, queryClient, analysisId]);
  // #2113 — the governing keys sit outside the analysis detail's, so the job
  // lifecycle never refreshes them: read again once the run leaves running.
  const inFlight = analysisStatus === "pending" || analysisStatus === "running";
  const wasInFlight = useRef(inFlight);
  useEffect(() => {
    if (wasInFlight.current && !inFlight) {
      void queryClient.invalidateQueries({ queryKey: governingFindingsKeys.all(analysisId) });
    }
    wasInFlight.current = inFlight;
  }, [inFlight, queryClient, analysisId]);
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
  if (!findingsQuery.data) return null;
  if (!hasFindings) {
    // #2113 — "not checked" and "checked, nothing applied" read differently.
    // While a findings run is in flight, the list is about to change: nothing yet.
    if (findingsQuery.data.refreshing || inFlight) return null;
    return (
      <section
        aria-labelledby="governing-findings-heading"
        className="space-y-1"
        data-testid="governing-findings-empty"
      >
        <h4
          id="governing-findings-heading"
          className="text-sm font-semibold uppercase tracking-wide text-muted-foreground"
        >
          Governing rules
        </h4>
        <GoverningPreviewNotice className="mt-1" />
        <WorkspaceGoverningLink projectId={projectId} />
        <p className="text-sm text-muted-foreground">
          {findingsQuery.data.checked
            ? "Governing rules were checked against this analysis's requirements. None produced a finding."
            : "Governing rules were not checked for this analysis: the workspace had no current governing rules, or the check did not run."}
        </p>
      </section>
    );
  }

  const sentences = governingSummarySentences(findings, findingsQuery.data.revisions ?? []);
  const groups = groupFindingsByRequirement(
    findings,
    applicabilityQuery.data ?? null,
    findingsQuery.data.requirementTitles ?? {},
  );

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
        <GoverningPreviewNotice className="mt-1" />
        <WorkspaceGoverningLink projectId={projectId} />
        {sentences.map(({ revisionId, sentence }) => (
          <p
            key={revisionId}
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
          aria-label={`Governing rules for ${group.title ?? group.requirementId}`}
          className="rounded border border-border bg-muted/30 p-3"
        >
          <h5 className="text-sm font-medium text-foreground">
            {group.title ?? group.requirementId}
          </h5>
          {group.text ? (
            <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{group.text}</p>
          ) : null}
          {group.stale.length > 0 ? (
            <StaleRequirementsNotice
              projectId={projectId}
              analysisId={analysisId}
              stale={group.stale}
              canRecheck={canDecide}
            />
          ) : null}
          <ul className="mt-2 space-y-2">
            {group.findings.map((finding) => (
              <li key={finding.id}>
                <GoverningFindingItem
                  projectId={projectId}
                  analysisId={analysisId}
                  finding={finding}
                  canDecide={canDecide}
                  settlement={answerSettlementOf(finding, applicabilityQuery.data ?? null)}
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

/**
 * #2222 — the requirements edited since these findings judged them, and a
 * **Re-check this requirement** for each: the governing check on its current
 * wording only. The findings and the applicability are read again once the
 * server has stored the new result; nothing is shown optimistically.
 */
function StaleRequirementsNotice({
  projectId,
  analysisId,
  stale,
  canRecheck,
}: {
  projectId: string;
  analysisId: string;
  stale: readonly GoverningStaleRequirement[];
  /** The user holds `analysis.run`, which the re-check route requires. */
  canRecheck: boolean;
}): React.ReactElement {
  const recheck = useAppMutation({
    mutationFn: (requirementId: string) =>
      governingFindingsApi.recheck(projectId, analysisId, { requirementId }),
    successMessage: (result) =>
      `Re-checked at v${result.version}: ${result.findings} governing ${result.findings === 1 ? "rule applies" : "rules apply"}`,
    errorMessage: "Could not re-check the requirement",
    invalidateKeys: [governingFindingsKeys.all(analysisId)],
  });
  return (
    <div
      role="note"
      className="mt-2 rounded border border-warning/40 bg-warning/10 p-2 text-xs text-foreground"
      data-testid="governing-stale"
    >
      <p>{governingStaleNote(stale)}</p>
      {canRecheck ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {stale.map((s) => (
            <Button
              key={s.requirementId}
              type="button"
              size="sm"
              variant="outline"
              disabled={recheck.isPending}
              aria-label={`Re-check this requirement: ${s.title}`}
              onClick={() => recheck.mutate(s.requirementId)}
            >
              {recheck.isPending && recheck.variables === s.requirementId
                ? "Re-checking…"
                : stale.length === 1
                  ? "Re-check this requirement"
                  : `Re-check “${s.title}”`}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function GoverningFindingItem({
  projectId,
  analysisId,
  finding,
  canDecide,
  settlement,
  questionHref,
}: {
  projectId: string;
  analysisId: string;
  finding: GoverningFinding;
  canDecide: boolean;
  settlement: AnswerSettlement | null;
  questionHref: string | null;
}): React.ReactElement {
  const label = GOVERNING_STATUS_LABELS[finding.status];
  // #2032 — the note follows the server's: a refetch that brings another BA's
  // decision replaces it, unless this BA has typed since, so the next Accept or
  // Reject never sends a stale copy over theirs. Adjusted during render, not in
  // an effect, so the stale note is never painted.
  const serverNote = finding.decisionNote ?? "";
  const [note, setNote] = useState(serverNote);
  const [seededFrom, setSeededFrom] = useState(serverNote);
  const [dirty, setDirty] = useState(false);
  if (serverNote !== seededFrom) {
    setSeededFrom(serverNote);
    if (!dirty) setNote(serverNote);
  }
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
    // The note was sent: from here the server's copy is the one to show.
    onSuccess: () => setDirty(false),
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
        {finding.stale?.length ? (
          <Badge variant="outline" data-testid="governing-finding-stale">
            Stale
          </Badge>
        ) : null}
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

      {settlement ? (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="governing-finding-answer">
          <span className="font-medium text-foreground">
            After the answer “{settlement.answer}”, this rule applies.
          </span>{" "}
          {neutraliseComplianceClaims(settlement.reason)}
        </p>
      ) : null}

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
            onChange={(e) => {
              setNote(e.target.value);
              setDirty(true);
            }}
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

/**
 * #2339 — the way to the workspace's governing documents, where an analyst who
 * sees no rules checked can go and add one. The page decides what they may do
 * there (read-only for a member). Rendered only inside the panel, which is
 * itself absent while the feature is off; none for a project in no workspace.
 */
function WorkspaceGoverningLink({ projectId }: { projectId: string }): React.ReactElement | null {
  // Shared with the project switcher and Overview: usually already cached.
  const project = useQuery({
    queryKey: queryKeys.projects.detail(projectId),
    queryFn: () => projectsApi.get(projectId),
  });
  const workspaceId = project.isError ? null : project.data?.workspaceId;
  if (!workspaceId) return null;
  return (
    <p className="mt-1 text-sm">
      <Link
        href={`/workspaces/${workspaceId}/governing`}
        className="text-primary underline underline-offset-2"
      >
        Open this workspace&apos;s governing documents
      </Link>
    </p>
  );
}
