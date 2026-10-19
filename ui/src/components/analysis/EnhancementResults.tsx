"use client";

/**
 * Enhancement Results (Epic #922).
 *
 * Surfaces the opt-in requirements-enhancement output that the analysis
 * pipeline persists into `metadata`:
 *   - Web Research evidence (#925/#927) — read-only digests with source
 *     domains, trust badges, and a "Needs Review" marker.
 *   - Clarifying Questions (#926) — interactive dialog that lets the user
 *     answer questions for ambiguous requirements; answers feed back into the
 *     server-sourced structured requirements.
 *
 * Both sections render only when the matching flag actually produced data, so
 * the component is a no-op offline (where the pipeline yields nothing).
 */
import { useEffect, useRef } from "react";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import {
  ambiguitiesOf,
  analysisApi,
  readEnhancementMetadata,
  type DomainTrust,
  type EnhancementMetadata,
  type EvidenceDigest,
  type StructuredRequirementsPayload,
} from "@/lib/analysis-api";
import { Card } from "@/components/ui/card";
import { ClarificationDialogPanel } from "@/components/analysis/ClarificationDialog";

/** Anchor id the gaps banner links to and the questions panel scrolls into. */
const QUESTIONS_ANCHOR = "clarifying-questions";

const TRUST_LABEL: Record<DomainTrust, string> = {
  high: "High Trust",
  medium: "Medium Trust",
  low: "Low Trust",
};

const TRUST_STYLE: Record<DomainTrust, string> = {
  high: "border-success/40 bg-success-muted text-success",
  medium: "border-warning/40 bg-warning-muted text-warning",
  low: "border-destructive/40 bg-destructive/10 text-destructive",
};

interface EnhancementResultsProps {
  projectId: string;
  analysisId: string;
  metadata: Record<string, unknown> | null;
}

export function EnhancementResults({
  projectId,
  analysisId,
  metadata,
}: EnhancementResultsProps): React.ReactElement | null {
  const enhancement = readEnhancementMetadata(metadata);
  const webResearchEnabled = enhancement.enhancement?.enableWebResearch ?? false;
  const clarificationEnabled = enhancement.enhancement?.enableClarification ?? false;

  // Nothing was requested — render nothing rather than empty scaffolding.
  if (!webResearchEnabled && !clarificationEnabled) return null;

  // Issue #1058 — extraction ran and failed. Whatever `structuredRequirements`
  // holds is then from an earlier run, so the "no open questions" banner must
  // not vouch for this one.
  const extractionFailed = Boolean(enhancement.structuredExtractionFailure);
  const structured = extractionFailed ? undefined : enhancement.structuredRequirements;

  return (
    <div className="space-y-4">
      {extractionFailed && <StructuredExtractionFailedNotice />}
      {clarificationEnabled && structured && (
        <p data-testid="collaboration-hint" className="text-xs text-muted-foreground">
          Collaborate: answer the clarifying questions below, Approve/Reject and comment on each
          requirement, or export questions / import answers for offline review.
        </p>
      )}
      {clarificationEnabled && (
        <ClarificationImpactNote application={enhancement.clarificationApplication} />
      )}
      {clarificationEnabled && structured && <GapsSummaryBanner structured={structured} />}
      {webResearchEnabled && (
        <EvidenceReview
          digests={enhancement.webResearch?.digests ?? []}
          notice={enhancement.webResearch?.notice}
        />
      )}
      {clarificationEnabled && (
        <ClarificationSection
          projectId={projectId}
          analysisId={analysisId}
          structured={structured}
        />
      )}
    </div>
  );
}

/**
 * Issue #1058 — the requirements-extraction step failed (the model's answer
 * could not be read, or the call failed). Before this notice the run showed
 * "No open questions — requirements look complete", asked nothing and created
 * no approval checkpoint: a failed step dressed as a clean result. The wording
 * is fixed here; the server's `reason` is for the log, not the screen.
 */
function StructuredExtractionFailedNotice(): React.ReactElement {
  return (
    <div
      role="alert"
      data-testid="structured-extraction-failed"
      className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      <span aria-hidden>⚠</span> METIS could not read the requirements out of the model’s answer, so
      no clarifying questions or approval checkpoints were prepared for this run. This step failed —
      it does not mean the requirements are complete. Run the analysis again to retry.
    </div>
  );
}

/**
 * Issue #1116 — **say what the answers actually do.**
 *
 * The reported defect was not only that clarification answers failed to reach
 * the published issue; it was that nothing on screen distinguished "your answer
 * shaped the artifact" from "your answer shaped this panel and stopped here".
 * The server now writes answers into the persisted requirements, and records how
 * many landed. This note states that outcome, including the part that is
 * deliberately excluded: METIS's own rewritten requirement text is NOT copied
 * into published issues — only the answers are, verbatim.
 */
/** Issue #1000 — who wrote an applied answer, as the note words it. */
const PROVENANCE_LABELS: Record<"suggested" | "edited" | "typed", string> = {
  suggested: "METIS suggestion, accepted unchanged",
  edited: "METIS suggestion, edited",
  typed: "typed by you",
};

/** #1162 — why an answer matched to a requirement was not written into it. */
const NOT_APPLIED_REASONS: Record<
  NonNullable<
    NonNullable<
      NonNullable<EnhancementMetadata["clarificationApplication"]>["answers"]
    >[number]["notApplied"]
  >["reason"],
  (title: string) => string
> = {
  "clarification-block-edited": (t) => `Clarifications section of “${t}” was edited`,
  "requirement-changed-during-write": (t) =>
    `“${t}” kept changing while the answers were written; they are retried on the next pass`,
  "requirement-deleted": (t) => `“${t}” was deleted`,
};

/**
 * #1225 — the label for a "not applied" reason. Metadata is stored, so a reason
 * this build does not know (written by a newer server, then rolled back) gets a
 * generic label instead of crashing the note.
 */
function notAppliedLabel(reason: string, title: string): string {
  const label = Object.prototype.hasOwnProperty.call(NOT_APPLIED_REASONS, reason)
    ? NOT_APPLIED_REASONS[reason as keyof typeof NOT_APPLIED_REASONS]
    : undefined;
  return label ? label(title) : `“${title}” could not be updated`;
}

/**
 * #1204 — why one answer could not be placed. Several titles: the answer's
 * requirement fits each of those saved requirements equally well. ONE title is
 * the other way round, and the commoner case: that saved requirement fits this
 * answer's requirement and another reviewed requirement equally well, so the
 * answer cannot be said to belong to it.
 */
export function describeTie(titles: readonly string[]): string {
  const quoted = titles.map((t) => `“${t}”`);
  if (quoted.length === 1) {
    return `${quoted[0]} fits this answer’s requirement and another one equally well, so the answer was not added to it`;
  }
  return `fits ${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1)} equally well, so none was chosen`;
}

export function ClarificationImpactNote({
  application,
}: {
  application: EnhancementMetadata["clarificationApplication"];
}): React.ReactElement | null {
  if (!application || application.answeredCount === 0) return null;
  const { answeredCount, appliedCount, unattributedCount, requirementsAvailable } = application;
  const blockEditedCount = application.blockEditedCount ?? 0;
  const notWrittenCount = application.notWrittenCount ?? 0;
  // Issue #979 — absent on analyses clarified before the per-answer record.
  const outcomes = application.answers ?? [];
  const applied = outcomes.filter((a) => a.requirementTitle !== null);
  const unmatched = outcomes.filter((a) => a.requirementTitle === null);
  // #1204 — answers not applied because their requirement could not be told apart.
  const tied = unmatched.filter((a) => (a.ambiguousBetween?.length ?? 0) > 0);
  const tiedSubject =
    tied.length !== unattributedCount
      ? `${tied.length} of them`
      : tied.length === 1
        ? "It"
        : "They";

  return (
    <div
      data-testid="clarification-impact"
      className="space-y-1 rounded border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
    >
      {requirementsAvailable ? (
        <p className="text-foreground">
          {appliedCount} of {answeredCount} answer{answeredCount === 1 ? "" : "s"} {""}
          {appliedCount === 1 ? "was" : "were"} written into the saved requirements and will appear
          in published issues under “Clarifications”.
        </p>
      ) : (
        // Issue #979 — with no saved requirement yet, every answer is "unmatched"
        // by construction, so the unmatched warning below is withheld in this
        // state: it contradicted this sentence. Matching happens at promotion,
        // and only then can the note say which answers landed.
        <p className="text-foreground">
          {answeredCount} answer{answeredCount === 1 ? "" : "s"} recorded. The requirements are not
          saved yet — they are awaiting approval. When they are promoted, each answer is written
          into the requirement it matches, and this note will list which answers were applied.
        </p>
      )}
      {requirementsAvailable && applied.length > 0 && (
        <details data-testid="clarification-applied-list">
          <summary className="cursor-pointer">Show which answers were applied</summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {applied.map((a) => (
              <li key={a.questionId}>
                {a.question} <span aria-hidden>→</span>{" "}
                <span className="text-foreground">{a.requirementTitle}</span>
                {a.provenance ? (
                  <span data-testid="clarification-answer-provenance">
                    {" "}
                    ({PROVENANCE_LABELS[a.provenance]})
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      )}
      {requirementsAvailable && unattributedCount > 0 && (
        <div className="text-warning" data-testid="clarification-unattributed">
          <p>
            {unattributedCount} answer{unattributedCount === 1 ? "" : "s"} could not be matched to a
            saved requirement, so {unattributedCount === 1 ? "it refines" : "they refine"} the
            requirement text shown here but will not appear in a published issue.
            {tied.length > 0
              ? ` ${tiedSubject} could not be placed because the match was too close to call:`
              : null}
          </p>
          {tied.length > 0 ? (
            <ul className="mt-1 list-disc space-y-0.5 pl-4" data-testid="clarification-ambiguous">
              {tied.map((a) => (
                <li key={a.questionId}>
                  {a.question} <span aria-hidden>→</span> {describeTie(a.ambiguousBetween!)}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
      {/* #1237 — the retry routes as they are. A submit re-runs the pass, but a
          completed dialog offers none; after that only promotion re-runs it, and
          only when it writes a newly approved requirement: a rejection reopened
          and approved on the Approvals panel (a hub card's Approve does not).
          The block's markers are hidden in every view, so the block-edited
          notice points to History, as the user guide does. */}
      {requirementsAvailable && blockEditedCount > 0 && (
        <p className="text-warning" data-testid="clarification-block-edited">
          {blockEditedCount} answer{blockEditedCount === 1 ? " was" : "s were"} not written because
          the Clarifications section of{" "}
          {blockEditedCount === 1 ? "its requirement" : "their requirements"} was edited.{" "}
          {blockEditedCount === 1 ? "Open the requirement" : "Open each requirement"} and delete
          that section, or restore it from History. The answers are then written again when you
          submit the next answers while clarifying questions are still open or, after clarification
          is complete, when you reopen a rejected requirement on the Approvals panel and approve it.
        </p>
      )}
      {requirementsAvailable && notWrittenCount > 0 && (
        <p className="text-warning" data-testid="clarification-not-written">
          {notWrittenCount} answer{notWrittenCount === 1 ? " was" : "s were"} not written because{" "}
          {notWrittenCount === 1 ? "its requirement" : "their requirements"} changed or{" "}
          {notWrittenCount === 1 ? "was" : "were"} deleted while the answers were being saved. While
          clarifying questions are still open, they are written again when you submit the next
          answers. After clarification is complete, they are written again only when you reopen a
          rejected requirement on the Approvals panel and approve it. To add an answer yourself,
          edit the requirement and type it outside the Clarifications section; if the answers are
          written again later, delete your copy so it does not appear twice. A deleted requirement
          is not restored, so nothing is written into it.
        </p>
      )}
      {requirementsAvailable && unmatched.length > 0 && (
        <details data-testid="clarification-unmatched-list">
          <summary className="cursor-pointer">Show the answers that were not applied</summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {unmatched.map((a) => (
              <li key={a.questionId}>
                {a.question}
                {a.notApplied ? (
                  <span data-testid="clarification-not-applied-reason">
                    {" "}
                    ({notAppliedLabel(a.notApplied.reason, a.notApplied.requirementTitle)})
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      )}
      <p>
        The refined requirement wording below is METIS’s own summary and is not copied into
        published issues — the answers are, verbatim, each marked as typed by you, a METIS
        suggestion you edited, or a METIS suggestion you accepted unchanged.
      </p>
    </div>
  );
}

/**
 * Prominent "gaps detected" banner shown on a completed analysis (Change 4).
 * Surfaces the open-question + evidence-need counts and links to the questions
 * panel; renders a positive "all clear" state when there are no ambiguities.
 */
function GapsSummaryBanner({
  structured,
}: {
  structured: StructuredRequirementsPayload;
}): React.ReactElement {
  const totalAmbiguities = structured.totalAmbiguities ?? 0;
  const totalEvidenceNeeds = structured.totalEvidenceNeeds ?? 0;
  const requirementCount = structured.requirements?.length ?? 0;

  if (totalAmbiguities === 0) {
    return (
      <div
        data-testid="gaps-summary"
        role="status"
        className="rounded border border-success/40 bg-success-muted px-3 py-2 text-sm text-success"
      >
        <span aria-hidden>✓</span> No open questions — requirements look complete
        {requirementCount > 0 && ` across ${requirementCount} requirements`}.
      </div>
    );
  }

  return (
    <div
      data-testid="gaps-summary"
      role="alert"
      className="flex flex-wrap items-center justify-between gap-2 rounded border border-warning/40 bg-warning-muted px-3 py-2 text-sm text-warning"
    >
      <span>
        <span aria-hidden>⚠</span> {totalAmbiguities} open questions / ambiguities detected across{" "}
        {requirementCount} requirements
        {totalEvidenceNeeds > 0 && ` (${totalEvidenceNeeds} evidence needs)`} — review and answer to
        refine.
      </span>
      <a
        href={`#${QUESTIONS_ANCHOR}`}
        className="shrink-0 rounded border border-warning/40 px-2 py-0.5 text-xs font-medium hover:bg-warning-muted"
      >
        Review questions
      </a>
    </div>
  );
}

function EvidenceReview({
  digests,
  notice,
}: {
  digests: EvidenceDigest[];
  /** #864 — why research did not run, stated once in place of the list. */
  notice?: string;
}): React.ReactElement {
  return (
    <Card className="space-y-3 p-4">
      <h3 className="text-lg font-semibold">Evidence Review</h3>
      {digests.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="web-research-notice">
          {notice ?? "No web research evidence to review."}
        </p>
      ) : (
        <ul className="space-y-3">
          {digests.map((digest) => (
            <li key={digest.id} className="rounded border border-border p-3">
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-foreground">{digest.query}</span>
                {digest.needsHumanReview && (
                  <span className="rounded border border-warning/40 bg-warning-muted px-2 py-0.5 text-xs text-warning">
                    Needs Review
                  </span>
                )}
              </div>
              <p className="mb-2 text-sm text-muted-foreground">{digest.digest}</p>
              {digest.sources.length > 0 && (
                <ul className="space-y-1">
                  {digest.sources.map((source) => (
                    <li key={source.url} className="flex items-center gap-2 text-xs">
                      <span
                        className={`rounded border px-1.5 py-0.5 ${TRUST_STYLE[source.domainTrust]}`}
                      >
                        {TRUST_LABEL[source.domainTrust]}
                      </span>
                      <a
                        href={source.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-info hover:underline"
                      >
                        {source.title}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ClarificationSection({
  projectId,
  analysisId,
  structured,
}: {
  projectId: string;
  analysisId: string;
  structured: StructuredRequirementsPayload | undefined;
}): React.ReactElement | null {
  const queryClient = useQueryClient();
  const hasAmbiguities = (structured?.totalAmbiguities ?? 0) > 0;

  // Epic #201 (#213) — rehydrate or start a REAL server-side dialog. Starting the
  // real dialog is what makes answers submittable: the interactive panel posts
  // server-issued `q.id`s, which is the ONLY key the server matches answers
  // against (clarification-dialog.ts resolveAmbiguities: `a.questionId === q.id`).
  //
  // The READ and the START are deliberately SEPARATE (issue #1135). They have
  // opposite gating requirements and folding them into one query is what broke
  // both of them in turn:
  //
  //   - The READ is cheap and must ALWAYS run. Issue #1104 (finding C): the old
  //     `enabled: hasAmbiguities` gate keyed off
  //     `structuredRequirements.totalAmbiguities`, which drops back to 0 once a
  //     round is answered, so a completed dialog — and the user's answers with
  //     it — became unreachable on the next page load.
  //   - The START is the expensive LLM-backed half and must stay gated on
  //     ambiguities actually existing.
  //
  // Issue #1135: moving that gate INSIDE the read's `queryFn` made the read
  // resolve `null` while the analysis was still running (`totalAmbiguities` is 0
  // until it finishes). With a run-status-free `queryKey`, `retry: false` and no
  // invalidation on completion, that `null` was cached for the life of the mount
  // and the read-only preview rendered forever. Only a reload recovered it. The
  // start is now an explicit one-shot effect that fires when ambiguities appear,
  // so a mid-run render no longer decides anything permanent.
  const dialog = useQuery({
    queryKey: ["analyses", analysisId, "clarify"],
    queryFn: async () => {
      const existing = await analysisApi.getClarification(projectId, analysisId);
      return existing.state ?? null;
    },
    retry: false,
    refetchOnWindowFocus: false,
  });

  // Issue #937 — the start is keyed in the shared mutation cache, which outlives
  // this component. Leaving the Questions tab unmounts the panel; the ref below
  // dies with it, and the remount used to POST a second (billed) start that
  // replaced the first one's questions. `useIsMutating` sees the first mount's
  // start still pending, and its `onSuccess` (an option on the mutation itself,
  // not on this observer) still writes the dialog into the query cache.
  const startKey = ["analyses", analysisId, "clarify", "start"];
  const startDialog = useMutation({
    mutationKey: startKey,
    mutationFn: () => analysisApi.clarify(projectId, analysisId, {}),
    retry: false,
    onSuccess: (state) => {
      queryClient.setQueryData(["analyses", analysisId, "clarify"], state);
    },
  });
  const startInFlight = useIsMutating({ mutationKey: startKey }) > 0;

  // One start per analysis per mount. Tracked by id rather than a bare boolean
  // so a run switch in the same mount is not silently skipped — and so a
  // re-render storm from the detail poll cannot fire a second (billable) round.
  const startedFor = useRef<string | null>(null);
  const startMutate = startDialog.mutate;
  useEffect(() => {
    if (!hasAmbiguities) return;
    // Wait for the read: only start when the server confirms there is no dialog.
    if (!dialog.isSuccess || dialog.data) return;
    if (startedFor.current === analysisId) return;
    // Issue #937 — a start from an earlier mount is still generating.
    if (startInFlight) return;
    startedFor.current = analysisId;
    startMutate();
  }, [hasAmbiguities, dialog.isSuccess, dialog.data, analysisId, startInFlight, startMutate]);

  if (!hasAmbiguities && !dialog.data) return null;

  // Prefer the live interactive dialog whenever one is available. This is the
  // SINGLE path that submits answers — it posts the server-issued `q.id`s, so
  // answers always match server-side.
  const preparing = dialog.isLoading || startDialog.isPending || startInFlight;

  if (dialog.data) {
    return (
      <div id={QUESTIONS_ANCHOR}>
        <ClarificationDialogPanel
          projectId={projectId}
          analysisId={analysisId}
          state={dialog.data}
          onComplete={() => {
            void dialog.refetch();
            // Issue #1135 — `ClarificationImpactNote` and the refined requirement
            // text both live in the analysis `metadata` the server rewrites when
            // answers are applied. Without this the note only appeared after a
            // page reload.
            void queryClient.invalidateQueries({
              queryKey: queryKeys.analyses.detail(analysisId),
            });
          }}
        />
      </div>
    );
  }

  // While the dialog start round-trips, render a READ-ONLY preview of the gaps
  // from structuredRequirements so the panel is never a bare spinner. This
  // preview deliberately has NO submit affordance — answers can only be posted
  // through the interactive panel above, which carries real server `q.id`s.
  if (structured && structured.requirements.some((r) => ambiguitiesOf(r).length > 0)) {
    return (
      <GapsPreviewPanel
        structured={structured}
        loading={preparing}
        // Issue #1135 — a start that never happens must not look like a start
        // that is still happening. The reported defect was silent: no error, no
        // POST, and a preview that reads as "any moment now" forever.
        startFailed={startDialog.isError}
        onRetryStart={() => startMutate()}
      />
    );
  }

  if (preparing) {
    return (
      <Card id={QUESTIONS_ANCHOR} className="p-4">
        <p className="text-sm text-muted-foreground">Preparing clarifying questions…</p>
      </Card>
    );
  }

  return null;
}

/**
 * Read-only preview of detected requirement gaps, shown while the real server
 * clarification dialog is being started/rehydrated. Surfaces the suggested
 * questions from `structuredRequirements` so the user immediately sees what
 * will be asked, WITHOUT any input or Submit control: answers are only ever
 * posted through the interactive `ClarificationDialogPanel`, which uses the
 * genuine server-issued question ids. This panel never fabricates ids.
 */
function GapsPreviewPanel({
  structured,
  loading,
  startFailed = false,
  onRetryStart,
}: {
  structured: StructuredRequirementsPayload;
  loading: boolean;
  /** #1135 — the dialog start round-tripped and failed; say so. */
  startFailed?: boolean;
  onRetryStart?: () => void;
}): React.ReactElement {
  const requirementsWithGaps = structured.requirements.filter((r) => ambiguitiesOf(r).length > 0);

  return (
    <Card id={QUESTIONS_ANCHOR} className="space-y-4 p-4" data-testid="gaps-preview">
      <div>
        <h3 className="text-lg font-semibold">Clarifying Questions</h3>
        <p className="text-sm text-muted-foreground">
          {loading
            ? "Preparing an interactive clarification session for these doc-grounded gaps…"
            : "These doc-grounded gaps will be turned into an interactive clarification session."}
        </p>
        {startFailed && !loading && (
          <p
            role="alert"
            data-testid="clarify-start-error"
            className="mt-1 text-sm text-destructive"
          >
            Could not start the interactive session, so these gaps cannot be answered yet.{" "}
            <button
              type="button"
              onClick={onRetryStart}
              className="underline hover:text-destructive"
            >
              Try again
            </button>
          </p>
        )}
      </div>

      <div className="space-y-4">
        {requirementsWithGaps.map((req) => (
          <div key={req.id} className="rounded border border-border p-3">
            <p className="mb-1 text-sm font-medium text-foreground">{req.title}</p>
            {req.description && (
              <p className="mb-2 text-xs text-muted-foreground">{req.description}</p>
            )}
            <ul className="space-y-2">
              {ambiguitiesOf(req).map((amb) => (
                <li
                  key={`${req.id}:${amb.field}`}
                  className="rounded border border-border/70 bg-muted/40 p-2"
                >
                  <p className="text-sm font-medium text-foreground">
                    {amb.suggestedQuestion || amb.description}
                  </p>
                  {amb.description && amb.suggestedQuestion && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      <span className="font-mono text-muted-foreground">{amb.field}</span> —{" "}
                      {amb.description}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Card>
  );
}
