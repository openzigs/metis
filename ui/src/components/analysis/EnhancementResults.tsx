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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import {
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
  high: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  medium: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  low: "border-red-500/30 bg-red-500/10 text-red-300",
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

  const structured = enhancement.structuredRequirements;

  return (
    <div className="space-y-4">
      {clarificationEnabled && structured && (
        <p data-testid="collaboration-hint" className="text-xs text-zinc-400">
          Collaborate: answer the clarifying questions below, Approve/Reject and comment on each
          requirement, or export questions / import answers for offline review.
        </p>
      )}
      {clarificationEnabled && (
        <ClarificationImpactNote application={enhancement.clarificationApplication} />
      )}
      {clarificationEnabled && structured && <GapsSummaryBanner structured={structured} />}
      {webResearchEnabled && <EvidenceReview digests={enhancement.webResearch?.digests ?? []} />}
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
export function ClarificationImpactNote({
  application,
}: {
  application: EnhancementMetadata["clarificationApplication"];
}): React.ReactElement | null {
  if (!application || application.answeredCount === 0) return null;
  const { answeredCount, appliedCount, unattributedCount, requirementsAvailable } = application;

  return (
    <div
      data-testid="clarification-impact"
      className="space-y-1 rounded border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-xs text-zinc-400"
    >
      {requirementsAvailable ? (
        <p className="text-zinc-300">
          {appliedCount} of {answeredCount} answer{answeredCount === 1 ? "" : "s"} {""}
          {appliedCount === 1 ? "was" : "were"} written into the saved requirements and will appear
          in published issues under “Clarifications”.
        </p>
      ) : (
        <p className="text-zinc-300">
          {answeredCount} answer{answeredCount === 1 ? "" : "s"} recorded. The requirements are not
          saved yet — they are awaiting approval, and your answers are written into them when they
          are promoted.
        </p>
      )}
      {unattributedCount > 0 && (
        <p className="text-amber-300" data-testid="clarification-unattributed">
          {unattributedCount} answer{unattributedCount === 1 ? "" : "s"} could not be matched to a
          saved requirement, so {unattributedCount === 1 ? "it refines" : "they refine"} the
          requirement text shown here but will not appear in a published issue.
        </p>
      )}
      <p>
        The refined requirement wording below is METIS’s own summary and is not copied into
        published issues — your answers are, verbatim.
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
        className="rounded border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300"
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
      className="flex flex-wrap items-center justify-between gap-2 rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-300"
    >
      <span>
        <span aria-hidden>⚠</span> {totalAmbiguities} open questions / ambiguities detected across{" "}
        {requirementCount} requirements
        {totalEvidenceNeeds > 0 && ` (${totalEvidenceNeeds} evidence needs)`} — review and answer to
        refine.
      </span>
      <a
        href={`#${QUESTIONS_ANCHOR}`}
        className="shrink-0 rounded border border-amber-500/40 px-2 py-0.5 text-xs font-medium hover:bg-amber-500/20"
      >
        Review questions
      </a>
    </div>
  );
}

function EvidenceReview({ digests }: { digests: EvidenceDigest[] }): React.ReactElement {
  return (
    <Card className="space-y-3 p-4">
      <h3 className="text-lg font-semibold">Evidence Review</h3>
      {digests.length === 0 ? (
        <p className="text-sm text-zinc-400">No web research evidence to review.</p>
      ) : (
        <ul className="space-y-3">
          {digests.map((digest) => (
            <li key={digest.id} className="rounded border border-zinc-800 p-3">
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-zinc-200">{digest.query}</span>
                {digest.needsHumanReview && (
                  <span className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-300">
                    Needs Review
                  </span>
                )}
              </div>
              <p className="mb-2 text-sm text-zinc-400">{digest.digest}</p>
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
                        className="text-blue-400 hover:underline"
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

  const startDialog = useMutation({
    mutationFn: () => analysisApi.clarify(projectId, analysisId, {}),
    retry: false,
    onSuccess: (state) => {
      queryClient.setQueryData(["analyses", analysisId, "clarify"], state);
    },
  });

  // One start per analysis, ever. Tracked by id rather than a bare boolean so a
  // run switch in the same mount is not silently skipped — and so a re-render
  // storm from the detail poll cannot fire a second (billable) round.
  const startedFor = useRef<string | null>(null);
  const startMutate = startDialog.mutate;
  useEffect(() => {
    if (!hasAmbiguities) return;
    // Wait for the read: only start when the server confirms there is no dialog.
    if (!dialog.isSuccess || dialog.data) return;
    if (startedFor.current === analysisId) return;
    startedFor.current = analysisId;
    startMutate();
  }, [hasAmbiguities, dialog.isSuccess, dialog.data, analysisId, startMutate]);

  if (!hasAmbiguities && !dialog.data) return null;

  // Prefer the live interactive dialog whenever one is available. This is the
  // SINGLE path that submits answers — it posts the server-issued `q.id`s, so
  // answers always match server-side.
  const preparing = dialog.isLoading || startDialog.isPending;

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
  if (structured && structured.requirements.some((r) => r.ambiguities.length > 0)) {
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
        <p className="text-sm text-zinc-400">Preparing clarifying questions…</p>
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
  const requirementsWithGaps = structured.requirements.filter((r) => r.ambiguities.length > 0);

  return (
    <Card id={QUESTIONS_ANCHOR} className="space-y-4 p-4" data-testid="gaps-preview">
      <div>
        <h3 className="text-lg font-semibold">Clarifying Questions</h3>
        <p className="text-sm text-zinc-400">
          {loading
            ? "Preparing an interactive clarification session for these doc-grounded gaps…"
            : "These doc-grounded gaps will be turned into an interactive clarification session."}
        </p>
        {startFailed && !loading && (
          <p role="alert" data-testid="clarify-start-error" className="mt-1 text-sm text-red-400">
            Could not start the interactive session, so these gaps cannot be answered yet.{" "}
            <button type="button" onClick={onRetryStart} className="underline hover:text-red-300">
              Try again
            </button>
          </p>
        )}
      </div>

      <div className="space-y-4">
        {requirementsWithGaps.map((req) => (
          <div key={req.id} className="rounded border border-zinc-800 p-3">
            <p className="mb-1 text-sm font-medium text-zinc-200">{req.title}</p>
            {req.description && <p className="mb-2 text-xs text-zinc-500">{req.description}</p>}
            <ul className="space-y-2">
              {req.ambiguities.map((amb) => (
                <li
                  key={`${req.id}:${amb.field}`}
                  className="rounded border border-zinc-800/70 bg-zinc-900/40 p-2"
                >
                  <p className="text-sm font-medium text-zinc-200">
                    {amb.suggestedQuestion || amb.description}
                  </p>
                  {amb.description && amb.suggestedQuestion && (
                    <p className="mt-1 text-xs text-zinc-500">
                      <span className="font-mono text-zinc-600">{amb.field}</span> —{" "}
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
