"use client";

/**
 * Analysis tab \u2014 list past runs, start a new one, view live progress with
 * persona cards, and review findings + requirements with approve/reject/edit.
 *
 * Issue #30 \u2014 starting a run is a collapsible form, and a run's results are
 * split into deep-linkable tabs (`?tab=`) with paged lists, so no view grows
 * with the size of the run.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api-client";
import { toast } from "sonner";
import { useAppMutation, resolveErrorMessage } from "@/lib/use-app-mutation";
import { useJobLifecycle, useProjectJobEvents } from "@/hooks/use-job-events";
import { useProjectDocuments } from "@/hooks/use-project-documents";
import {
  analysisApi,
  isCodeCitation,
  type AnalysisAgentKey,
  type AnalysisPersona,
  type AnalysisSnapshot,
  type RequirementSummary,
  type RequirementReviewStatus,
  type RequirementCoverage,
  type UpdateRequirementInput,
} from "@/lib/analysis-api";
import { projectsApi } from "@/lib/projects-api";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CodeCitation } from "@/components/findings/code-citation";
import { DerivationBadge } from "@/components/findings/derivation-badge";
import { PersonaTag } from "@/components/findings/persona-tag";
import { agentSourcePersonas } from "@/components/findings/agent-source-persona";
import { DeepDiveDialog, type DeepDiveDialogFinding } from "@/components/findings/deep-dive-dialog";
import { ModelRecommendation } from "@/components/analysis/ModelRecommendation";
import { formatChangeRunLabels } from "@/lib/format-change-run-label";
import { EnhancementStatus } from "@/components/analysis/EnhancementStatus";
import { EnhancementResults } from "@/components/analysis/EnhancementResults";
import { ApprovalsPanel } from "@/components/analysis/ApprovalsPanel";
import { GenerateIssuesAction } from "@/components/analysis/GenerateIssuesAction";
// Issue #1104 — a gated run's empty requirements list must explain itself.
import { RequirementsEmptyState } from "@/components/analysis/RequirementsEmptyState";
import { SynthesisDegradedNotice } from "@/components/analysis/SynthesisDegradedNotice";
import { RequirementReplacementWithheldNotice } from "@/components/analysis/RequirementReplacementWithheldNotice";
import { AddDocumentsPanel } from "@/components/analysis/add-documents-panel";
import { formatSourceLabel } from "@/lib/format-source-label";
import { useRepoNames } from "@/hooks/use-repo-names";
import { useScrollToAnchor } from "@/hooks/use-scroll-to-anchor";
import { EvaluateRequirementsPanel } from "@/components/analysis/evaluate-requirements-panel";
import { CrossDocFindingsPanel } from "@/components/analysis/CrossDocFindingsPanel";
import { StakeholdersPanel } from "@/components/analysis/StakeholdersPanel";
import { stakeholderApi } from "@/lib/stakeholder-api";
import { AnalysisRunSummary } from "@/components/analysis/analysis-run-summary";
import { AnalysisCapabilityBanner } from "@/components/analysis/analysis-capability-banner";
import { RequirementInputAccountPanel } from "@/components/analysis/requirement-input-account-panel";
import { AnalysisCapabilityHint } from "@/components/analysis/analysis-capability-hint";
import { AffectedCodePanel } from "@/components/analysis/affected-code-panel";
import { AnalysisDepthPanel } from "@/components/analysis/analysis-depth-panel";
import { AnalysisDatabaseAwareIndicator } from "@/components/analysis/analysis-database-aware-indicator";
import { CoverageBadge } from "@/components/analysis/CoverageBadge";
// Epic #1107 (#1110) — the support panel's confidence treatment. Ranking,
// wording and the second-class card classes all live in the component module
// (measured by coverage); this page only wires them in.
import {
  AbsenceVerdictBadge,
  RequirementConfidenceNote,
  SupportPanelBadge,
  SupportPanelDetails,
  findingConfidenceClasses,
  orderFindingsByConfidence,
} from "@/components/analysis/SupportPanelBadge";
import { AcceptanceCriteriaList } from "@/components/analysis/AcceptanceCriteriaList";
import { VerificationBadge } from "@/components/analysis/VerificationBadge";
// Issue #1232 — the run's outcome first, then a scannable finding body.
import { AnalysisOutcomeCard } from "@/components/analysis/AnalysisOutcomeCard";
import { FindingBody } from "@/components/analysis/FindingBody";
import { TraceabilityMatrix } from "@/components/analysis/traceability-matrix";
import { GapReport } from "@/components/analysis/gap-report";
import { RequirementDiff } from "@/components/analysis/requirement-diff";
import { DataMappingsPanel } from "@/components/traceability/data-mappings-panel";
import { RequirementLinksPanel } from "@/components/requirements/requirement-links-panel";
import { TraceabilityView } from "@/components/traceability/traceability-view";
import { UntestedRequirementsPanel } from "@/components/traceability/untested-requirements-panel";
import { RequirementHistoryTab } from "@/components/requirements/RequirementHistoryTab";
import { findingsApi } from "@/lib/findings-api";
// Epic #34 — collaboration on requirements (comments, assignees/SLA, optimistic-lock merge).
import { useAuth } from "@/lib/auth-context";
import { CommentPanel } from "@/components/comments/CommentPanel";
import { AssigneePicker } from "@/components/requirements/AssigneePicker";
import { SLABadge } from "@/components/requirements/SLABadge";
import {
  MergeConflictModal,
  type ConflictState,
} from "@/components/requirements/MergeConflictModal";
import { requirementUpdateApi, assignmentApi } from "@/lib/collaboration-api";
import { MessageSquare } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { TabsContent } from "@/components/ui/tabs";
// Issue #30 — tabbed, paged, filterable results.
import { AnalysisResultTabs } from "@/components/analysis/AnalysisResultTabs";
import { FindingsFilterBar } from "@/components/analysis/FindingsFilterBar";
import { ListPager } from "@/components/analysis/ListPager";
import {
  FINDINGS_PAGE_SIZE,
  NO_FINDING_FILTERS,
  REQUIREMENTS_PAGE_SIZE,
  agentDisplayStatus,
  analysisTabCounts,
  analysisViewHref,
  collectFindings,
  filterFindings,
  findingFacets,
  findingFiltersParams,
  paginate,
  parseAnalysisTab,
  parseFindingFilters,
  requirementPage,
  sameFindingFilters,
  runHasQuestionsView,
  tabForAnchor,
  traceabilityPendingMessage,
  type AnalysisTab,
  type FindingFilters,
} from "@/components/analysis/analysis-views";

const SPECIALIST_AGENTS: AnalysisAgentKey[] = ["document", "code", "database", "web"];

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function StatusBadge({ status }: { status: string }): React.ReactElement {
  const colour =
    status === "completed"
      ? "bg-success-muted text-success border-success/30"
      : status === "degraded"
        ? "bg-warning-muted text-warning border-warning/30"
        : status === "failed"
          ? "bg-destructive/10 text-destructive border-destructive/30"
          : status === "cancelled"
            ? "bg-muted text-foreground border-border/30"
            : "bg-info-muted text-info border-info/30";
  return (
    <span className={`inline-block rounded border px-2 py-0.5 text-xs font-medium ${colour}`}>
      {status}
    </span>
  );
}

export default function AnalysisPage(): React.ReactElement {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? "";
  // #23 — connector id → repository name for citation labels.
  const repoNames = useRepoNames(projectId);
  const qc = useQueryClient();
  const [selectedAnalysisId, setSelectedAnalysisId] = useState<string | null>(null);

  const project = useQuery({
    queryKey: queryKeys.projects.detail(projectId),
    queryFn: () => projectsApi.get(projectId),
    enabled: Boolean(projectId),
  });
  // #322 — keeps re-reading while a document is ingesting, so one uploaded
  // from the inline panel turns selectable when it is ready.
  const docs = useProjectDocuments(projectId);
  const personas = useQuery({
    queryKey: ["analyses", "personas"],
    queryFn: () => analysisApi.personas(),
  });
  const costCap = useQuery({
    queryKey: ["analyses", "cost-cap"],
    queryFn: () => analysisApi.costCap(),
    refetchInterval: 30_000,
  });
  const list = useQuery({
    queryKey: queryKeys.analyses.forProject(projectId),
    queryFn: () => analysisApi.listForProject(projectId),
    enabled: Boolean(projectId),
  });
  // #364 — runs were labelled by a raw id ("cmumww553000"); name them "Run #N —
  // <date>" and keep the short id as a secondary token.
  const runLabels = useMemo(() => formatChangeRunLabels(list.data?.items ?? []).byId, [list.data]);
  // Epic #208 (#233) — stakeholders + project context for the surface panel.
  const stakeholders = useQuery({
    queryKey: ["stakeholders", projectId],
    queryFn: () => stakeholderApi.list(projectId),
    enabled: Boolean(projectId),
  });
  const projectContext = useQuery({
    queryKey: ["project-context", projectId],
    queryFn: () => stakeholderApi.getContext(projectId),
    enabled: Boolean(projectId),
  });

  // Auto-select a run after the list loads: the one named in `?analysisId=`
  // (the Overview's and Requirements tab's deep links, #29) when it belongs to
  // THIS project's list, otherwise the most recent. Matching against the list
  // keeps a foreign id from rendering another project's run under this one.
  const searchParams = useSearchParams();
  const requestedAnalysisId = searchParams?.get("analysisId") ?? null;
  useEffect(() => {
    const items = list.data?.items;
    if (!selectedAnalysisId && items?.[0]) {
      const requested = items.find((item) => item.id === requestedAnalysisId);
      setSelectedAnalysisId((requested ?? items[0]).id);
    }
  }, [list.data, selectedAnalysisId, requestedAnalysisId]);

  // Issue #30 — the open run and the open tab both live in the URL, so every
  // sub-view is deep-linkable and picking a past run is shareable. `replace`,
  // not `push`: a tab click is not a navigation worth a Back-button stop.
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const requestedTab = searchParams?.get("tab") ?? null;
  const [tab, setTab] = useState<AnalysisTab>(() => parseAnalysisTab(requestedTab));
  // Issue #487 — resync on a soft navigation during render, as the filters do
  // below: an effect rendered the old tab against the new URL for one frame.
  const [syncedTab, setSyncedTab] = useState(requestedTab);
  if (requestedTab !== syncedTab) {
    setSyncedTab(requestedTab);
    setTab(parseAnalysisTab(requestedTab));
  }
  // Issue #406 — an anchor to scroll to once its target mounts: the URL's own
  // `#approvals` (the Publish page's link) or one a tab switch intercepted.
  // The browser's fragment scroll runs before the panel's queries resolve.
  const [pendingAnchor, setPendingAnchor] = useState<string | null>(null);
  // PR #434 review: a fragment with no `?tab=` (an old `?analysisId=…#approvals`
  // bookmark) opens the tab that holds the anchor, rather than arming a scroll
  // that would fire only when the user later opened that tab.
  useEffect(() => {
    const hash = window.location.hash;
    const anchorTab = tabForAnchor(hash);
    if (!anchorTab) return;
    setPendingAnchor(hash);
    if (!requestedTab) setTab(anchorTab);
    // Mount only: the fragment is read once, like the browser's own scroll.
  }, []);
  const clearPendingAnchor = useCallback(() => setPendingAnchor(null), []);
  useScrollToAnchor(pendingAnchor, clearPendingAnchor);
  const updateUrl = (patch: Record<string, string | null>) =>
    router.replace(analysisViewHref(pathname, searchParams, patch), { scroll: false });
  // Epic #727 (#740) filtered findings by verifier verdict; #30 adds severity,
  // category and agent. `null` in a field = no filter on it. Issue #424 — they
  // are read from and written to the URL, so a filtered view can be shared.
  const [findingFilters, setFindingFilters] = useState<FindingFilters>(() =>
    parseFindingFilters(searchParams),
  );
  const [findingsPage, setFindingsPage] = useState(0);
  const [requirementsPage, setRequirementsPage] = useState(0);
  // Issue #476 — resync from the URL on a soft navigation (a second shared link,
  // Back/Forward), as `tab` does. Keyed on the filter params' values, not the
  // params object, and applied only when they differ from what is shown: the
  // page's own `router.replace` echoes back equal filters, which must neither
  // loop nor send a reader who has paged on back to page 1.
  const urlFilters = parseFindingFilters(searchParams);
  const urlFiltersKey = JSON.stringify(findingFiltersParams(urlFilters));
  const [syncedFiltersKey, setSyncedFiltersKey] = useState(urlFiltersKey);
  if (urlFiltersKey !== syncedFiltersKey) {
    setSyncedFiltersKey(urlFiltersKey);
    if (!sameFindingFilters(urlFilters, findingFilters)) {
      setFindingFilters(urlFilters);
      setFindingsPage(0);
    }
  }
  const selectTab = (next: AnalysisTab) => {
    // PR #434 review: a tab switch cancels a scroll still waiting for its target,
    // or it fires later as a surprise. An anchor the tab bar intercepts is set
    // after this (onValueChange runs before onAnchor), so it survives.
    setPendingAnchor(null);
    setTab(next);
    updateUrl({ tab: next });
  };
  const selectRun = (id: string) => {
    setSelectedAnalysisId(id);
    setFindingsPage(0);
    setRequirementsPage(0);
    // PR #416 review — filters are per run: a filter kept across a switch
    // showed "No findings match" under a select that read "All".
    setFindingFilters(NO_FINDING_FILTERS);
    setCoverageFilter(null);
    updateUrl({ analysisId: id, ...findingFiltersParams(NO_FINDING_FILTERS) });
  };
  const changeFindingFilters = (next: FindingFilters) => {
    setFindingFilters(next);
    setFindingsPage(0);
    // Pin the run too: a shared link without it would open the latest run.
    updateUrl({ analysisId: selectedAnalysisId, ...findingFiltersParams(next) });
  };
  // Issue #30 — the run form is collapsed once there are runs to read, and
  // open on a project that has none. An explicit toggle wins after that.
  const [startFormOpen, setStartFormOpen] = useState<boolean | null>(null);
  const hasRuns = (list.data?.items?.length ?? 0) > 0;
  const showStartForm = startFormOpen ?? !hasRuns;

  const detail = useQuery({
    queryKey: queryKeys.analyses.detail(selectedAnalysisId ?? ""),
    queryFn: () => analysisApi.get(selectedAnalysisId!),
    enabled: Boolean(selectedAnalysisId),
    refetchInterval: (query) => {
      const data = query.state.data as AnalysisSnapshot | undefined;
      if (!data) return 4000;
      return data.status === "running" || data.status === "pending" ? 2500 : false;
    },
  });

  // Refresh the runs list when the selected run reaches a terminal state so
  // the sidebar badge and token count stay in sync with the detail panel.
  const detailStatus = detail.data?.status;
  useEffect(() => {
    if (detailStatus === "completed" || detailStatus === "failed" || detailStatus === "cancelled") {
      qc.invalidateQueries({ queryKey: queryKeys.analyses.forProject(projectId) });
      qc.invalidateQueries({ queryKey: ["analyses", "cost-cap"] });
    }
  }, [detailStatus, projectId, qc]);

  // #240 — push-driven status. The server emits unified job-lifecycle events on
  // each analysis transition; on every event we invalidate the detail so the UI
  // updates immediately. The `refetchInterval` above is retained ONLY as a
  // degraded fallback for a disconnected socket.
  const analysisJob = useJobLifecycle(selectedAnalysisId);
  useEffect(() => {
    if (!analysisJob || !selectedAnalysisId) return;
    qc.invalidateQueries({ queryKey: queryKeys.analyses.detail(selectedAnalysisId) });
    if (analysisJob.status === "completed" || analysisJob.status === "failed") {
      qc.invalidateQueries({ queryKey: queryKeys.analyses.forProject(projectId) });
    }
  }, [analysisJob, selectedAnalysisId, projectId, qc]);
  // #240 — project-room consumer keeps the runs list fresh as jobs transition.
  useProjectJobEvents(projectId);

  // #241 — analysis trigger with loading + success/error toasts.
  const start = useAppMutation({
    mutationFn: (input: {
      agentKeys: AnalysisAgentKey[];
      documentIds?: string[];
      model?: string;
      extraInstructions?: string;
      enableWebResearch?: boolean;
      enableClarification?: boolean;
    }) => analysisApi.start(projectId, input),
    successMessage: "Analysis started",
    invalidateKeys: [queryKeys.analyses.forProject(projectId), ["analyses", "cost-cap"]],
    onSuccess: (res) => {
      // Starting a run and reading one stay separate: close the form (PR #416 review).
      setStartFormOpen(false);
      selectRun(res.id);
    },
  });
  const cancel = useAppMutation({
    mutationFn: () => analysisApi.cancel(selectedAnalysisId!),
    successMessage: "Analysis cancelled",
    invalidateKeys: selectedAnalysisId ? [queryKeys.analyses.detail(selectedAnalysisId)] : [],
  });
  const regenerate = useAppMutation({
    mutationFn: (agentKey: AnalysisAgentKey) =>
      analysisApi.regenerateAgent(selectedAnalysisId!, agentKey),
    successMessage: "Agent regeneration started",
    invalidateKeys: selectedAnalysisId ? [queryKeys.analyses.detail(selectedAnalysisId)] : [],
  });
  // Issue #741 — re-run the agentic code agent for repos a prior multi-repo run
  // dropped for token budget. Progress streams over the analysis socket room;
  // the invalidate refreshes the capability banner once the resume completes.
  const resumeRepos = useAppMutation({
    mutationFn: () => analysisApi.resumeRepos(selectedAnalysisId!),
    successMessage: (res) =>
      res.accepted ? "Analyzing remaining repositories" : "No repositories to re-run",
    invalidateKeys: selectedAnalysisId ? [queryKeys.analyses.detail(selectedAnalysisId)] : [],
  });
  // AC2 — review-status changes (approve/reject) go through the same
  // optimistic-locked PUT as field edits. `PUT /api/requirements/:id` accepts
  // `reviewStatus` (see server/src/routes/requirements.ts) and runs the
  // optimisticLock middleware, so a concurrent change against a stale version
  // produces a 409. Because a status-enum toggle has no free text to reconcile,
  // useAppMutation surfaces that conflict as a toast — not the 3-way
  // MergeConflictModal, which is reserved for free-text field edits.
  const review = useAppMutation({
    mutationFn: (input: {
      reqId: string;
      reviewStatus: RequirementReviewStatus;
      version: number;
    }) =>
      requirementUpdateApi.update(input.reqId, {
        reviewStatus: input.reviewStatus,
        version: input.version,
      }),
    successMessage: (_d, input) =>
      input.reviewStatus === "approved" ? "Requirement approved" : "Requirement updated",
    invalidateKeys: selectedAnalysisId ? [queryKeys.analyses.detail(selectedAnalysisId)] : [],
  });
  // Edit-modal state (AC1 / sub-issue #58). Keeping the editing requirement
  // in component state lets us populate the form synchronously when the user
  // clicks Edit and apply optimistic updates on save.
  const [editingReq, setEditingReq] = useState<RequirementSummary | null>(null);
  // Epic #770 — which requirement's version history is currently expanded.
  const [historyReqId, setHistoryReqId] = useState<string | null>(null);
  // Epic #726 (#736) — filter the requirement list by coverage classification.
  // `null` = show all; otherwise show only requirements with that coverage.
  const [coverageFilter, setCoverageFilter] = useState<RequirementCoverage | null>(null);
  // Issue #487 — a soft navigation to a link naming a different run switches
  // the run, as the filters and tab already follow the URL. Keyed on the
  // param's CHANGE, not on a difference from the shown run: after a pick, the
  // page's own `router.replace` lands a render later, and a stale URL in
  // between must not send the reader back. The auto-select effect above still
  // owns the first pick; a foreign id (not in this project's list) is ignored.
  // Filters need no reset here: they come from the same URL, resynced above.
  const [syncedAnalysisId, setSyncedAnalysisId] = useState(requestedAnalysisId);
  if (requestedAnalysisId !== syncedAnalysisId) {
    setSyncedAnalysisId(requestedAnalysisId);
    const known = list.data?.items?.some((item) => item.id === requestedAnalysisId);
    if (known && requestedAnalysisId !== selectedAnalysisId) {
      setSelectedAnalysisId(requestedAnalysisId);
      setFindingsPage(0);
      setRequirementsPage(0);
      setCoverageFilter(null);
    }
  }
  // Epic #34 — collaboration state.
  const { user } = useAuth();
  const [commentsReqId, setCommentsReqId] = useState<string | null>(null);
  // AC2 — pending optimistic-lock conflict awaiting 3-way merge resolution.
  const [conflict, setConflict] = useState<{
    reqId: string;
    state: ConflictState<Record<string, unknown>>;
  } | null>(null);
  const editMutation = useMutation({
    // AC2 — persist through the optimistic-lock PUT so concurrent edits surface
    // a 409. We submit the version that was RENDERED into the edit form (carried
    // on the requirement snapshot), NOT a freshly-fetched one. Re-reading the
    // version at save time would mask the common "stale form" conflict — the
    // user could edit a row another writer changed and still win. A stale
    // rendered version reliably 409s, yielding the server diff used to seed the
    // 3-way merge modal.
    mutationFn: async (input: {
      reqId: string;
      patch: UpdateRequirementInput;
      version: number;
    }) => {
      try {
        return await requirementUpdateApi.update(input.reqId, {
          ...input.patch,
          version: input.version,
        });
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          // The optimistic-lock 409 carries `{ serverVersion, diff }` on the
          // error payload (surfaced via ApiError.details). Build client/server
          // value maps for the merge modal from the field-level diff.
          const payload = err.details as
            | {
                serverVersion?: number;
                diff?: Array<{ field: string; server: unknown; client: unknown }>;
              }
            | undefined;
          const diff = payload?.diff ?? [];
          const clientValue: Record<string, unknown> = {};
          const serverValue: Record<string, unknown> = {};
          for (const d of diff) {
            clientValue[d.field] = d.client;
            serverValue[d.field] = d.server;
          }
          setConflict({
            reqId: input.reqId,
            state: {
              clientValue,
              serverValue,
              serverVersion: payload?.serverVersion ?? input.version,
              fieldLabels: {
                title: "Title",
                body: "Body",
                priority: "Priority",
                type: "Type",
                labels: "Labels",
              },
            },
          });
        }
        throw err;
      }
    },
    onMutate: async (input) => {
      const detailKey = queryKeys.analyses.detail(selectedAnalysisId!);
      await qc.cancelQueries({ queryKey: detailKey });
      const previous = qc.getQueryData<AnalysisSnapshot>(detailKey);
      if (previous) {
        qc.setQueryData<AnalysisSnapshot>(detailKey, {
          ...previous,
          requirements: previous.requirements.map((r) =>
            r.id === input.reqId
              ? {
                  ...r,
                  ...(input.patch.title !== undefined ? { title: input.patch.title } : {}),
                  ...(input.patch.body !== undefined ? { body: input.patch.body } : {}),
                  ...(input.patch.priority !== undefined ? { priority: input.patch.priority } : {}),
                  ...(input.patch.type !== undefined ? { type: input.patch.type } : {}),
                  ...(input.patch.labels !== undefined ? { labels: input.patch.labels } : {}),
                }
              : r,
          ),
        });
      }
      return { previous, detailKey };
    },
    onError: (err, _input, ctx) => {
      // Roll back on failure so the UI doesn't lie about the persisted state.
      if (ctx?.previous) qc.setQueryData(ctx.detailKey, ctx.previous);
      // AC2 — a 409 opens the 3-way merge modal (set in mutationFn); skip the
      // generic toast so the user resolves the conflict instead.
      if (err instanceof ApiError && err.status === 409) {
        setEditingReq(null);
        return;
      }
      // #241 — surface the failure instead of silently reverting.
      toast.error(resolveErrorMessage(err, "Failed to save requirement"));
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: queryKeys.analyses.detail(selectedAnalysisId!) });
    },
    onSuccess: () => {
      setEditingReq(null);
      toast.success("Requirement saved");
    },
  });

  // AC2 — resubmit a conflict resolution with the authoritative server version.
  const resolveConflictMutation = useMutation({
    mutationFn: (input: {
      reqId: string;
      resolved: Record<string, unknown>;
      serverVersion: number;
    }) =>
      requirementUpdateApi.update(input.reqId, {
        ...input.resolved,
        version: input.serverVersion,
      }),
    onSuccess: () => {
      setConflict(null);
      setEditingReq(null);
      qc.invalidateQueries({ queryKey: queryKeys.analyses.detail(selectedAnalysisId!) });
      toast.success("Conflict resolved");
    },
    onError: (err) => {
      toast.error(resolveErrorMessage(err, "Failed to resolve conflict"));
    },
  });

  const personaByKey = useMemo(() => {
    const map = new Map<string, AnalysisPersona>();
    for (const p of personas.data?.items ?? []) map.set(p.agentKey, p);
    return map;
  }, [personas.data]);

  // #289 — custom/library agents from the analysis agent phase have no server
  // persona; their chip is built from the agent's own name and kind.
  const sourcePersonaByKey = useMemo(
    () => agentSourcePersonas(detail.data?.agentResults ?? []),
    [detail.data],
  );
  const personaFor = (agentKey: string) =>
    sourcePersonaByKey.get(agentKey) ?? personaByKey.get(agentKey);

  // Epic #176 — Deep Dive → Issue. Ticket creation is gated by the approval
  // checkpoint state (`ticketStatus.allowed`); fetch it for the selected run.
  const approvals = useQuery({
    // Issue #30 — the SAME key ApprovalsPanel reads and invalidates. Under its
    // own key this copy was never invalidated, so resolving an approval left
    // the Deep Dive gate (and now the tab's pending count) stale until reload.
    queryKey: ["approvals", selectedAnalysisId ?? ""],
    queryFn: () => analysisApi.listApprovals(projectId, selectedAnalysisId!),
    enabled: Boolean(projectId && selectedAnalysisId) && detail.data?.status === "completed",
  });
  const ticketsAllowed = approvals.data?.ticketStatus?.allowed ?? true;
  const [deepDiveFinding, setDeepDiveFinding] = useState<DeepDiveDialogFinding | null>(null);
  const [deepDiveOpen, setDeepDiveOpen] = useState(false);

  const [selectedAgents, setSelectedAgents] = useState<AnalysisAgentKey[]>([...SPECIALIST_AGENTS]);
  const [selectedDocs, setSelectedDocs] = useState<string[]>([]);
  const [modelOverride, setModelOverride] = useState<
    "auto" | "force-haiku" | "force-sonnet" | "force-fable" | "force-opus"
  >("auto");
  // Epic #597 — enhancement toggles
  const [enableWebResearch, setEnableWebResearch] = useState(false);
  // Default ON so doc-grounded clarifying questions surface by default; the
  // toggle below still lets users opt out.
  const [enableClarification, setEnableClarification] = useState(true);
  // Issue #907 — free-text new requirements (requirements→code gap evaluation).
  const [extraInstructions, setExtraInstructions] = useState("");

  // Issue #906 — auto-select a freshly-ingested doc after the documents cache
  // has been invalidated/refetched so the new row exists before it is checked.
  const allDocs = useMemo(() => docs.data?.items ?? [], [docs.data]);
  const invalidateDocs = useMemo(
    () => () => qc.invalidateQueries({ queryKey: queryKeys.documents.forProject(projectId) }),
    [qc, projectId],
  );
  const selectedHasPending = allDocs.some(
    (d) => selectedDocs.includes(d.id) && d.status !== "ready",
  );

  // Issue #30 — the findings and requirements the active tabs page through.
  const allFindings = detail.data ? orderFindingsByConfidence(collectFindings(detail.data)) : [];
  const findingsView = paginate(
    filterFindings(allFindings, findingFilters),
    findingsPage,
    FINDINGS_PAGE_SIZE,
  );
  const requirementsView = paginate(
    (detail.data?.requirements ?? []).filter(
      (req) => coverageFilter === null || (req.coverage ?? null) === coverageFilter,
    ),
    requirementsPage,
    REQUIREMENTS_PAGE_SIZE,
  );
  const tabCounts = detail.data ? analysisTabCounts(detail.data, approvals.data?.ticketStatus) : {};
  const traceabilityPending = detail.data ? traceabilityPendingMessage(detail.data.status) : null;

  // Issue #424 — `?requirementId=` (the promote dialog's "View requirement")
  // opens the page that holds it and scrolls to its card. Applied once per run,
  // so a refetch never pulls a reader back after they page away. With no
  // `?tab=`, the link opens the Requirements tab, as `#approvals` does.
  const requestedRequirementId = searchParams?.get("requirementId") ?? null;
  const appliedRequirementLink = useRef<string | null>(null);
  const snapshot = detail.data;
  useEffect(() => {
    if (!requestedRequirementId || !snapshot) return;
    const key = `${snapshot.id}:${requestedRequirementId}`;
    if (appliedRequirementLink.current === key) return;
    const page = requirementPage(
      snapshot.requirements,
      requestedRequirementId,
      REQUIREMENTS_PAGE_SIZE,
    );
    // Not in this snapshot yet: a promote appends it to a run whose detail may
    // still be cached, so leave the link for the refetch that brings it.
    if (page === null) return;
    appliedRequirementLink.current = key;
    setCoverageFilter(null);
    setRequirementsPage(page);
    if (!requestedTab) setTab("requirements");
    if (!requestedTab || parseAnalysisTab(requestedTab) === "requirements")
      setPendingAnchor(`#requirement-${requestedRequirementId}`);
  }, [snapshot, requestedRequirementId, requestedTab]);

  if (!projectId) return <p className="p-6">Missing project id.</p>;

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title={<>Requirements Analysis — {project.data?.name ?? "loading…"}</>}
        description={
          <>
            Synthesize structured requirements &amp; acceptance criteria from this project&apos;s
            documents and code. (To map a requirement change to affected code across multiple
            projects, use Impact Analysis.)
          </>
        }
        actions={
          <>
            {/* Issue #30 — rendered once the runs list has settled, so the
                default (open only when there are no runs) cannot flip under
                a click. */}
            {list.isSuccess || list.isError ? (
              <Button
                variant={showStartForm ? "outline" : "default"}
                aria-expanded={showStartForm}
                aria-controls="start-analysis-form"
                data-testid="start-analysis-toggle"
                onClick={() => setStartFormOpen(!showStartForm)}
              >
                {showStartForm ? "Hide new analysis" : "New analysis"}
              </Button>
            ) : null}
            {costCap.data ? (
              <div className="rounded border border-border bg-muted/40 px-3 py-2 text-xs">
                <div className="text-muted-foreground">Monthly token usage</div>
                <div className="font-mono">
                  {formatTokens(costCap.data.monthlyUsed)} /{" "}
                  {costCap.data.monthlyCap === 0 ? "\u221E" : formatTokens(costCap.data.monthlyCap)}
                </div>
                {costCap.data.exceeded ? (
                  <div className="text-destructive">cap exceeded</div>
                ) : null}
              </div>
            ) : null}
          </>
        }
      />

      {showStartForm ? (
        <Card id="start-analysis-form" className="space-y-4 p-4">
          <div>
            <h2 className="text-lg font-semibold">Start a new analysis</h2>
            <p className="text-sm text-muted-foreground">
              Pick the specialist agents and (optionally) constrain to specific documents.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <Label className="mb-2 block">Agents</Label>
              <div className="space-y-1">
                {SPECIALIST_AGENTS.map((agent) => {
                  const p = personaByKey.get(agent);
                  const checked = selectedAgents.includes(agent);
                  return (
                    <label key={agent} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          setSelectedAgents((prev) =>
                            e.target.checked
                              ? [...new Set([...prev, agent])]
                              : prev.filter((a) => a !== agent),
                          );
                        }}
                      />
                      <span>{p?.avatar ?? "\ud83e\udd16"}</span>
                      <span className="font-medium">{p?.name ?? agent}</span>
                      <span className="text-muted-foreground">— {p?.role ?? agent}</span>
                    </label>
                  );
                })}
              </div>
            </div>
            <div>
              <AddDocumentsPanel
                projectId={projectId}
                docs={allDocs}
                selectedDocs={selectedDocs}
                onSelectedDocsChange={setSelectedDocs}
                onInvalidateDocs={invalidateDocs}
                loading={docs.isLoading}
              />
            </div>
          </div>

          <EvaluateRequirementsPanel value={extraInstructions} onChange={setExtraInstructions} />

          <ModelRecommendation
            projectId={projectId}
            override={modelOverride}
            onOverrideChange={setModelOverride}
            // #1095 — the panel must be told what run it is sizing, or it can only
            // ever report a constant.
            agentKeys={selectedAgents}
            requirementText={extraInstructions}
          />

          {/* Epic #597 — Enhancement options */}
          <div className="rounded border border-border p-3">
            <Label className="mb-2 block text-sm font-medium">Enhancement Options</Label>
            <div className="flex items-center gap-6">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={enableWebResearch}
                  onChange={(e) => setEnableWebResearch(e.target.checked)}
                />
                <span>Enhance with web research</span>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={enableClarification}
                  onChange={(e) => setEnableClarification(e.target.checked)}
                />
                <span>Ask clarifying questions</span>
              </label>
            </div>
            {(enableWebResearch || enableClarification) &&
              !start.isPending &&
              !selectedAnalysisId && (
                <div className="mt-2">
                  <EnhancementStatus
                    currentStep="extraction"
                    stepsCompleted={[]}
                    enableWebResearch={enableWebResearch}
                    enableClarification={enableClarification}
                  />
                </div>
              )}
          </div>

          <div className="space-y-2">
            {/* Issue #733 — warn which capabilities the run will have before starting. */}
            <AnalysisCapabilityHint projectId={projectId} selectedAgents={selectedAgents} />
            <AnalysisRunSummary
              docCount={selectedDocs.length}
              hasRequirements={extraInstructions.trim().length > 0}
            />
            <div className="flex items-center gap-3">
              <Button
                onClick={() =>
                  start.mutate({
                    agentKeys: selectedAgents,
                    documentIds: selectedDocs.length > 0 ? selectedDocs : undefined,
                    model: modelOverride !== "auto" ? modelOverride : undefined,
                    extraInstructions:
                      extraInstructions.trim().length > 0 ? extraInstructions.trim() : undefined,
                    enableWebResearch: enableWebResearch || undefined,
                    enableClarification: enableClarification || undefined,
                  })
                }
                disabled={
                  start.isPending ||
                  selectedAgents.length === 0 ||
                  costCap.data?.exceeded ||
                  selectedHasPending
                }
              >
                {start.isPending ? "Starting\u2026" : "Run analysis"}
              </Button>
              {selectedHasPending ? (
                <p className="text-sm text-warning">
                  Wait for selected documents to finish ingesting.
                </p>
              ) : null}
              {start.error instanceof ApiError ? (
                <p role="alert" className="text-sm text-destructive">
                  {start.error.message}
                </p>
              ) : null}
            </div>
          </div>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
        <Card className="md:col-span-1 p-4">
          <h3 className="mb-3 text-base font-semibold">Past runs</h3>
          {list.isLoading ? <p className="text-sm">Loading…</p> : null}
          {list.data?.items?.length === 0 ? (
            <p className="text-sm text-muted-foreground">No analyses yet.</p>
          ) : null}
          <ul className="space-y-1">
            {list.data?.items?.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => selectRun(item.id)}
                  className={`w-full rounded border px-2 py-2 text-left text-sm transition ${
                    selectedAnalysisId === item.id
                      ? "border-info/50 bg-info/10"
                      : "border-border hover:bg-muted/40"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-foreground">
                      {runLabels.get(item.id)?.primary}
                    </span>
                    <StatusBadge status={item.status} />
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {formatTokens(item.totalTokens)} tok ·{" "}
                    <span className="font-mono" title={item.id}>
                      {runLabels.get(item.id)?.shortId}
                    </span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </Card>

        <Card className="md:col-span-2 p-4">
          {!detail.data ? (
            <p className="text-sm text-muted-foreground">Select a run to view details.</p>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-base font-semibold">
                    {runLabels.has(detail.data.id)
                      ? `Run #${runLabels.get(detail.data.id)?.sequence}`
                      : "Run"}{" "}
                    <StatusBadge status={detail.data.status} />
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    Started {new Date(detail.data.startedAt).toLocaleString()} ·{" "}
                    {formatTokens(detail.data.totalTokens)} tok
                  </p>
                </div>
                {detail.data.status === "running" || detail.data.status === "pending" ? (
                  <Button
                    variant="outline"
                    onClick={() => cancel.mutate()}
                    disabled={cancel.isPending}
                  >
                    Cancel
                  </Button>
                ) : null}
              </div>

              <AnalysisResultTabs
                value={tab}
                onValueChange={selectTab}
                counts={tabCounts}
                onAnchor={setPendingAnchor}
              >
                <TabsContent value="summary" className="space-y-4">
                  {/* Issue #1232 — the run's outcome, in the synthesis agent's own
                  words, above everything it is a conclusion about. Renders
                  nothing when synthesis produced no summary. */}
                  <AnalysisOutcomeCard
                    status={detail.data.status}
                    agentResults={detail.data.agentResults}
                  />

                  {/* Issue #859 (Epic #852) — whether database-aware schema analysis ran
                  for this run, and why. Renders nothing on pre-#855 runs. */}
                  <AnalysisDatabaseAwareIndicator
                    databaseAware={detail.data.databaseAware}
                    projectId={projectId}
                  />

                  {/* Issue #733 — explain degraded capabilities for this run (not silence). */}
                  {/* Issue #741 — offer a resume of budget-skipped repos from the banner. */}
                  <AnalysisCapabilityBanner
                    capability={detail.data.capability}
                    onResumeRepos={() => resumeRepos.mutate(undefined)}
                    resuming={resumeRepos.isPending}
                  />

                  {/* Issue #1112 (Epic #1107) — account for every requirement the user
                  typed: analyzed, merged into another, or dropped with a reason.
                  Renders nothing on runs with no free-text requirements. */}
                  <RequirementInputAccountPanel capability={detail.data.capability} />

                  {/* Issue #735 — deterministic requirement→code mapping for new requirements. */}
                  <AffectedCodePanel affectedCode={detail.data.affectedCode} />

                  {/* Issue #739 — per-requirement analysis-depth indicator (escalation policy). */}
                  <AnalysisDepthPanel escalation={detail.data.escalation} />

                  {/* Epic #208 (#233) — stakeholders + project context surface. */}
                  <StakeholdersPanel
                    stakeholders={stakeholders.data ?? []}
                    context={projectContext.data ?? null}
                  />
                </TabsContent>

                <TabsContent value="requirements" className="space-y-4">
                  {/* Issue #1232 — requirements are the actionable output, so they
                  are read before the findings they were derived from. */}
                  <div data-testid="requirements-section">
                    <h4 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                      Requirements
                    </h4>
                    {/* Epic #726 (#736) — filter the list by coverage classification. */}
                    <div
                      className="mb-2 flex flex-wrap items-center gap-1"
                      data-testid="coverage-filter"
                      role="group"
                      aria-label="Filter requirements by coverage"
                    >
                      <span className="mr-1 text-xs text-muted-foreground">Coverage:</span>
                      {(
                        [
                          [null, "All"],
                          ["grounded_in_code", "Grounded in code"],
                          ["grounded_in_docs_only", "Docs only"],
                          ["no_evidence", "No evidence"],
                        ] as Array<[RequirementCoverage | null, string]>
                      ).map(([value, label]) => (
                        <Button
                          key={label}
                          size="sm"
                          variant={coverageFilter === value ? "default" : "outline"}
                          aria-pressed={coverageFilter === value}
                          data-testid={`coverage-filter-${value ?? "all"}`}
                          onClick={() => {
                            setCoverageFilter(value);
                            setRequirementsPage(0);
                          }}
                        >
                          {label}
                        </Button>
                      ))}
                    </div>
                    <div className="space-y-2">
                      {/* Issue #1117 (findings B + C) — when synthesis degraded,
                      every requirement below is typed "feature" and has no
                      acceptance criteria because the fallback cannot classify.
                      Rendered above the list so it is read before them. */}
                      <SynthesisDegradedNotice metadata={detail.data.metadata} />
                      {/* Issue #769 — a re-synthesis was refused permission to
                      replace this (reviewed or healthy) set; say so. */}
                      <RequirementReplacementWithheldNotice metadata={detail.data.metadata} />
                      {detail.data.requirements.length === 0 ? (
                        /* Issue #1104 (finding B) — distinguish "produced nothing"
                       from "produced N and the approval gate is holding them". */
                        <RequirementsEmptyState metadata={detail.data.metadata} />
                      ) : null}
                      {requirementsView.items.map((req) => (
                        <div
                          key={req.id}
                          id={`requirement-${req.id}`}
                          data-deep-linked={req.id === requestedRequirementId ? "true" : undefined}
                          className={`scroll-mt-4 rounded border border-border bg-muted/30 p-3 ${
                            req.id === requestedRequirementId ? "ring-2 ring-primary" : ""
                          }`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <div className="flex items-center gap-2">
                                <div className="text-sm font-medium">{req.title}</div>
                                {/* Epic #726 (#736) — coverage classification badge. */}
                                <CoverageBadge coverage={req.coverage} />
                              </div>
                              <div className="text-xs text-muted-foreground">
                                {req.type} · {req.priority} · {req.reviewStatus}
                              </div>
                            </div>
                            <div className="flex gap-1">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setEditingReq(req)}
                                disabled={editMutation.isPending}
                              >
                                Edit
                              </Button>
                              {/* Epic #34 (AC1) — open comments for this requirement. */}
                              <Button
                                size="sm"
                                variant={commentsReqId === req.id ? "default" : "outline"}
                                onClick={() => setCommentsReqId(req.id)}
                                aria-label={`Comments for ${req.title}`}
                                data-testid={`req-comments-${req.id}`}
                              >
                                <MessageSquare className="mr-1 h-3.5 w-3.5" aria-hidden />
                                Comments
                              </Button>
                              <Button
                                size="sm"
                                variant={historyReqId === req.id ? "default" : "outline"}
                                onClick={() =>
                                  setHistoryReqId((cur) => (cur === req.id ? null : req.id))
                                }
                                aria-expanded={historyReqId === req.id}
                              >
                                History
                              </Button>
                              <Button
                                size="sm"
                                variant={req.reviewStatus === "approved" ? "default" : "outline"}
                                onClick={() =>
                                  review.mutate({
                                    reqId: req.id,
                                    reviewStatus: "approved",
                                    version: req.version,
                                  })
                                }
                                disabled={review.isPending}
                              >
                                Approve
                              </Button>
                              <Button
                                size="sm"
                                variant={req.reviewStatus === "rejected" ? "default" : "outline"}
                                onClick={() =>
                                  review.mutate({
                                    reqId: req.id,
                                    reviewStatus: "rejected",
                                    version: req.version,
                                  })
                                }
                                disabled={review.isPending}
                              >
                                Reject
                              </Button>
                            </div>
                          </div>
                          {/* Epic #34 (AC4) — assignee picker + SLA badge. */}
                          <RequirementCollabRow requirementId={req.id} />
                          <p className="mt-1 max-w-prose text-sm leading-relaxed text-foreground">
                            {req.body}
                          </p>
                          {/* Epic #1107 (#1110) — the panel's rolled-up confidence
                            for this requirement's evidence, with each dissenting
                            lens's reason. Rendered ABOVE the acceptance criteria
                            so the caution arrives before the work does. */}
                          <RequirementConfidenceNote confidence={req.supportConfidence} />
                          {/* #1096 — the real criteria, or an explicit note that
                            none were derived. Never a placeholder. */}
                          <AcceptanceCriteriaList criteria={req.acceptanceCriteria ?? []} />
                          {req.labels.length > 0 ? (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {req.labels.map((l) => (
                                <span
                                  key={l}
                                  className="rounded bg-muted px-1.5 py-0.5 text-xs text-foreground"
                                >
                                  {l}
                                </span>
                              ))}
                            </div>
                          ) : null}
                          <DataMappingsPanel projectId={projectId} requirementId={req.id} />
                          <RequirementLinksPanel
                            projectId={projectId}
                            requirementId={req.id}
                            workspaceId={project.data?.workspaceId ?? null}
                          />
                          <div className="mt-3 border-t border-border pt-3">
                            <TraceabilityView projectId={projectId} requirementId={req.id} />
                          </div>
                          {historyReqId === req.id ? (
                            <div className="mt-3 border-t border-border pt-3">
                              <RequirementHistoryTab requirementId={req.id} />
                            </div>
                          ) : null}
                        </div>
                      ))}
                      <ListPager
                        page={requirementsView}
                        noun="requirements"
                        onPageChange={setRequirementsPage}
                        testId="requirements-pager"
                      />
                    </div>
                  </div>
                </TabsContent>

                <TabsContent value="findings" className="space-y-4">
                  <div data-testid="findings-section">
                    <div className="mb-2 flex items-center justify-between">
                      <h4 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                        Findings
                      </h4>
                      {/* Issue #362 — disabled, with the reason, until requirements exist. */}
                      <GenerateIssuesAction
                        projectId={projectId}
                        analysisId={detail.data.id}
                        status={detail.data.status}
                        requirementCount={detail.data.requirements.length}
                        hasFindings={detail.data.agentResults.some((a) => a.findings.length > 0)}
                        ticketStatus={approvals.data?.ticketStatus}
                        approvalsState={
                          approvals.isError ? "error" : approvals.data ? "ready" : "loading"
                        }
                      />
                    </div>
                    {/* Issue #30 — severity, category and agent join #740's verification filter. */}
                    <FindingsFilterBar
                      facets={findingFacets(allFindings)}
                      filters={findingFilters}
                      onChange={changeFindingFilters}
                      agentLabel={(key) => personaFor(key)?.name ?? key}
                    />
                    <div className="space-y-2">
                      {findingsView.items.map((f) => {
                        const isGap = f.severity === "info" && f.tags?.includes("requirement-gap");
                        return (
                          <div
                            key={f.id}
                            // Epic #1107 (#1110) — a low-confidence finding is dimmed
                            // and dashed, ranked last, and STILL RENDERED. There is
                            // deliberately no confidence filter: the panel grades,
                            // it never gates.
                            data-confidence={f.supportPanel?.confidence ?? "none"}
                            className={`rounded border p-3 ${
                              isGap
                                ? "border-warning/50 bg-warning-muted"
                                : "border-border bg-muted/30"
                            } ${findingConfidenceClasses(f.supportPanel)}`}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <div className="text-sm font-medium">{f.title}</div>
                                <div className="mt-1 flex flex-wrap items-center gap-2">
                                  <span
                                    data-testid="finding-severity"
                                    className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-foreground"
                                  >
                                    {f.severity}
                                  </span>
                                  <span className="text-xs text-muted-foreground">
                                    {f.category}
                                  </span>
                                  <PersonaTag
                                    persona={personaFor(f.agentKey)}
                                    agentKey={f.agentKey}
                                  />
                                </div>
                                {f.requirementId ? (
                                  <span
                                    className={`mt-1 inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${
                                      isGap
                                        ? "bg-warning-muted text-warning"
                                        : "bg-info-muted text-info"
                                    }`}
                                  >
                                    {isGap ? "Gap for " : "Grounded in "}
                                    {f.requirementId}
                                  </span>
                                ) : null}
                              </div>
                              {/* Issue #1232 — secondary signals: each badge below
                                already renders nothing when its value is absent,
                                so this column collapses instead of holding empty
                                placeholders. Muted until hovered so severity and
                                agent stay the first things read. */}
                              <div className="flex shrink-0 flex-wrap items-start justify-end gap-1 opacity-70 transition-opacity hover:opacity-100 focus-within:opacity-100">
                                {/* Epic #727 (#740) — verifier verdict badge. */}
                                <VerificationBadge status={f.verificationStatus} />
                                {/* Epic #1107 (#1110) — the panel's confidence.
                                  Stacks with the verifier badge: one asks "was
                                  the file retrieved?", the other "does it back
                                  the claim?". */}
                                <SupportPanelBadge panel={f.supportPanel} />
                                {/* Epic #1107 (#1111) — the ABSENCE verdict, on
                                  findings that claim something is missing.
                                  "Absence unexamined" (amber) and "Absence
                                  checked" (emerald) are the two states #773
                                  rendered identically. */}
                                <AbsenceVerdictBadge panel={f.supportPanel} />
                                <DerivationBadge
                                  derivation={f.derivation}
                                  confidence={f.confidence}
                                  agentResultId={f.agentResultId}
                                  onReview={
                                    f.derivation === "ambiguous"
                                      ? async () => {
                                          await findingsApi.acknowledgeReview(f.id);
                                        }
                                      : undefined
                                  }
                                />
                              </div>
                            </div>
                            {/* Issue #1232 — bodies arrive as ~1000-char single
                              paragraphs with no newlines; clamp + expand is what
                              makes the list scannable. */}
                            <FindingBody body={f.body} />
                            {f.citations.length > 0 ? (
                              <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                                {f.citations.map((c, idx) => {
                                  // #734 \u2014 a code citation renders as its
                                  // `filePath:startLine-endLine` locator, visually
                                  // distinct from document citations.
                                  if (isCodeCitation(c)) {
                                    return (
                                      <CodeCitation
                                        key={`code-${c.filePath}-${c.startLine}-${idx}`}
                                        citation={c}
                                      />
                                    );
                                  }
                                  // Issue #427 \u2014 render connector ids as a friendly
                                  // `basename \u2014 repo` label with the full raw id in
                                  // the title tooltip. The chunk index (#{chunkIndex})
                                  // is the file:line provenance and is preserved.
                                  // #573 — classified on the cited row's
                                  // stored source, not the filename prefix.
                                  const source = formatSourceLabel(
                                    c.filename ?? c.documentId,
                                    repoNames,
                                    c.source,
                                  );
                                  return (
                                    <li key={`${c.documentId}-${c.chunkIndex}-${idx}`}>
                                      \u2192 <span title={source.rawId}>{source.label}</span> #
                                      {c.chunkIndex}
                                      {c.snippet ? <em className="ml-2">"{c.snippet}"</em> : null}
                                    </li>
                                  );
                                })}
                              </ul>
                            ) : isGap ? (
                              <p className="mt-2 text-xs text-warning">
                                No supporting evidence retrieved from the selected documents.
                              </p>
                            ) : null}
                            {/* Epic #1107 (#1110) — every lens's verdict, its own
                              words and its file:line, from the snapshot already
                              loaded: "why is this low-confidence?" is one click,
                              not another request. */}
                            <SupportPanelDetails panel={f.supportPanel} />
                            <div className="mt-3 flex justify-end">
                              <Button
                                size="sm"
                                variant="outline"
                                data-testid="deep-dive-action"
                                disabled={!ticketsAllowed}
                                title={
                                  ticketsAllowed
                                    ? "Expand this finding into a publishable issue draft"
                                    : "Ticket creation is blocked until pending approvals are resolved"
                                }
                                onClick={() => {
                                  setDeepDiveFinding({
                                    id: f.id,
                                    title: f.title,
                                    agentKey: f.agentKey,
                                  });
                                  setDeepDiveOpen(true);
                                }}
                              >
                                Deep Dive → Issue
                              </Button>
                            </div>
                          </div>
                        );
                      })}
                      {allFindings.length === 0 ? (
                        <p className="text-sm text-muted-foreground">No findings yet.</p>
                      ) : findingsView.total === 0 ? (
                        <p
                          className="text-sm text-muted-foreground"
                          data-testid="findings-no-match"
                        >
                          No findings match these filters.
                        </p>
                      ) : null}
                      <ListPager
                        page={findingsView}
                        noun="findings"
                        onPageChange={setFindingsPage}
                        testId="findings-pager"
                      />
                    </div>
                  </div>

                  {/* Epic #203 (#221) — first-class cross-document findings. */}
                  <CrossDocFindingsPanel crossDocFindings={detail.data.crossDocFindings} />
                </TabsContent>

                <TabsContent value="questions" className="space-y-4">
                  {/* Clarifying questions (and the web-research evidence that
                    feeds them) for this run. */}
                  <EnhancementResults
                    projectId={projectId}
                    analysisId={detail.data.id}
                    metadata={detail.data.metadata}
                  />

                  {!runHasQuestionsView(detail.data.metadata) ? (
                    <p className="text-sm text-muted-foreground" data-testid="questions-none">
                      This run did not ask clarifying questions.
                    </p>
                  ) : null}
                </TabsContent>

                <TabsContent value="approvals" className="space-y-4">
                  {/* Epic #202 (#217) — human-in-the-loop approval checkpoints. */}
                  {approvals.data && (approvals.data.items?.length ?? 0) === 0 ? (
                    <p className="text-sm text-muted-foreground" data-testid="approvals-none">
                      This run has no approval checkpoints.
                    </p>
                  ) : null}
                  <ApprovalsPanel
                    projectId={projectId}
                    analysisId={detail.data.id}
                    metadata={detail.data.metadata}
                  />
                </TabsContent>

                <TabsContent value="agents" className="space-y-4">
                  <div>
                    <h4 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                      Agents
                    </h4>
                    <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                      {detail.data.agentResults.map((agent) => {
                        const persona = personaFor(agent.agentKey);
                        // #289 — an agent-phase agent is not a specialist: it has no
                        // single-agent regenerate endpoint.
                        const isSpecialist = agent.agentKey !== "synthesis" && !agent.source;
                        return (
                          <div
                            key={agent.id}
                            className="rounded border border-border bg-muted/30 p-3"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-2">
                                <span className="text-lg">{persona?.avatar ?? "\ud83e\udd16"}</span>
                                <div>
                                  <div className="text-sm font-medium">
                                    {persona?.name ?? agent.agentKey}
                                  </div>
                                  <div className="text-xs text-muted-foreground">
                                    {persona?.role ?? agent.agentKey} · {agent.findings.length}{" "}
                                    finding
                                    {agent.findings.length === 1 ? "" : "s"}
                                  </div>
                                </div>
                              </div>
                              <StatusBadge status={agentDisplayStatus(agent)} />
                            </div>
                            {isSpecialist && detail.data.status === "completed" ? (
                              <div className="mt-2">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() =>
                                    regenerate.mutate(agent.agentKey as AnalysisAgentKey)
                                  }
                                  disabled={regenerate.isPending}
                                >
                                  Regenerate
                                </Button>
                              </div>
                            ) : null}
                            {agent.errorMessage ? (
                              <p className="mt-2 text-xs text-destructive">{agent.errorMessage}</p>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </TabsContent>

                <TabsContent value="traceability" className="space-y-4">
                  {/* Issue #424 — the panels below render nothing until the run
                  completes; say why rather than leave an empty pane. */}
                  {traceabilityPending ? (
                    <p
                      className="rounded border border-dashed border-border p-4 text-sm text-muted-foreground"
                      data-testid="traceability-pending"
                    >
                      {traceabilityPending}
                    </p>
                  ) : null}
                  {/* Issue #737 — requirement→findings→code→tests traceability matrix. */}
                  <TraceabilityMatrix
                    projectId={projectId}
                    analysisId={detail.data.id}
                    enabled={detail.data.status === "completed"}
                  />

                  {/* Issue #816 — requirements whose mapped code has no linked test. */}
                  <UntestedRequirementsPanel
                    projectId={projectId}
                    analysisId={detail.data.id}
                    enabled={detail.data.status === "completed"}
                  />

                  {/* Issue #742 — per-requirement gap report (current impl + gap + effort). */}
                  <GapReport
                    projectId={projectId}
                    analysisId={detail.data.id}
                    enabled={detail.data.status === "completed"}
                  />

                  {/* Issue #743 — diff-style current-vs-proposed view for changed requirements. */}
                  <RequirementDiff
                    projectId={projectId}
                    analysisId={detail.data.id}
                    analyses={list.data?.items ?? []}
                    enabled={detail.data.status === "completed"}
                  />
                </TabsContent>
              </AnalysisResultTabs>
            </div>
          )}
        </Card>
      </div>
      <RequirementEditModal
        requirement={editingReq}
        onClose={() => setEditingReq(null)}
        onSave={(patch) => {
          if (editingReq)
            editMutation.mutate({ reqId: editingReq.id, patch, version: editingReq.version });
        }}
        isSaving={editMutation.isPending}
        errorMessage={editMutation.error instanceof ApiError ? editMutation.error.message : null}
      />
      <DeepDiveDialog
        open={deepDiveOpen}
        onOpenChange={setDeepDiveOpen}
        projectId={projectId}
        analysisId={selectedAnalysisId ?? ""}
        finding={deepDiveFinding}
        persona={deepDiveFinding ? personaFor(deepDiveFinding.agentKey) : undefined}
      />
      {/* Epic #34 (AC1) — requirement comment thread panel. */}
      <CommentPanel
        open={commentsReqId !== null}
        onClose={() => setCommentsReqId(null)}
        requirementId={commentsReqId ?? undefined}
        currentUserId={user?.id}
        title={
          detail.data?.requirements.find((r) => r.id === commentsReqId)?.title ??
          "Requirement comments"
        }
      />
      {/* Epic #34 (AC2) — optimistic-lock 3-way merge resolver. */}
      <MergeConflictModal
        conflict={conflict?.state ?? null}
        onResolve={(resolved, serverVersion) => {
          if (conflict) {
            resolveConflictMutation.mutate({ reqId: conflict.reqId, resolved, serverVersion });
          }
        }}
        onDismiss={() => setConflict(null)}
      />
    </div>
  );
}

/**
 * Epic #34 (AC4) — per-requirement collaboration row. Self-fetches assignments
 * to drive the SLA badge and renders the assignee picker. Kept as its own
 * component so each requirement card owns one `assignmentApi.list` query.
 */
function RequirementCollabRow({ requirementId }: { requirementId: string }): React.ReactElement {
  const { data: assignments = [] } = useQuery({
    queryKey: ["assignments", requirementId],
    queryFn: () => assignmentApi.list(requirementId),
  });
  // Surface the soonest unresolved SLA deadline as the card's badge.
  const nextDeadline = assignments
    .filter((a) => !a.resolvedAt && a.slaDeadline)
    .map((a) => a.slaDeadline as string)
    .sort()[0];

  return (
    <div className="mt-2 flex items-center gap-2" data-testid={`req-collab-${requirementId}`}>
      <span className="text-xs text-muted-foreground">Assignees</span>
      <AssigneePicker requirementId={requirementId} />
      <SLABadge deadline={nextDeadline ?? null} />
    </div>
  );
}

const REQ_TYPES = ["feature", "bug", "chore", "epic", "task"] as const;
const REQ_PRIORITIES = ["low", "medium", "high", "critical"] as const;

function RequirementEditModal(props: {
  requirement: RequirementSummary | null;
  onClose: () => void;
  onSave: (patch: UpdateRequirementInput) => void;
  isSaving: boolean;
  errorMessage: string | null;
}): React.ReactElement {
  const { requirement, onClose, onSave, isSaving, errorMessage } = props;
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [priority, setPriority] = useState<string>("medium");
  const [type, setType] = useState<string>("feature");
  const [labelsText, setLabelsText] = useState("");

  // Sync local form state whenever a different requirement opens.
  useEffect(() => {
    if (!requirement) return;
    setTitle(requirement.title);
    setBody(requirement.body);
    setPriority(requirement.priority);
    setType(requirement.type);
    setLabelsText(requirement.labels.join(", "));
  }, [requirement]);

  const open = requirement !== null;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit requirement</DialogTitle>
          <DialogDescription>
            Update the title, body, priority, type, or notes / labels. Changes are saved through the
            analysis API and the requirements list will refresh on success.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            const labels = labelsText
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            onSave({
              title: title.trim(),
              body: body.trim(),
              priority,
              type,
              labels,
            });
          }}
        >
          <div>
            <Label htmlFor="req-edit-title">Title</Label>
            <Input
              id="req-edit-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              maxLength={255}
            />
          </div>
          <div>
            <Label htmlFor="req-edit-body">Body / notes</Label>
            <textarea
              id="req-edit-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={6}
              className="w-full rounded border border-border bg-muted/40 p-2 text-sm"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="req-edit-type">Type</Label>
              <select
                id="req-edit-type"
                value={type}
                onChange={(e) => setType(e.target.value)}
                className="w-full rounded border border-border bg-muted/40 p-2 text-sm"
              >
                {REQ_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="req-edit-priority">Priority</Label>
              <select
                id="req-edit-priority"
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                className="w-full rounded border border-border bg-muted/40 p-2 text-sm"
              >
                {REQ_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <Label htmlFor="req-edit-labels">Labels (comma-separated)</Label>
            <Input
              id="req-edit-labels"
              value={labelsText}
              onChange={(e) => setLabelsText(e.target.value)}
              placeholder="security, billing"
            />
          </div>
          {errorMessage ? (
            <p className="text-sm text-destructive" role="alert">
              {errorMessage}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={isSaving}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSaving || title.trim().length === 0}>
              {isSaving ? "Saving\u2026" : "Save"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
