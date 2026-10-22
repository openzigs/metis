/**
 * Issue #30 — the Analysis page's sub-views.
 *
 * One completed run used to render its run form, run history, agent output,
 * every finding, every clarifying question and every approval card on a single
 * page (113,001 px measured). A run's results are now split into tabs, each
 * deep-linkable as `?tab=<value>`, and the long lists inside them are paged.
 *
 * Everything here is pure so the page — a thin wiring layer excluded from
 * coverage — keeps no logic of its own worth measuring.
 */
import { AGENT_DEGRADED_NOTE_PREFIX, type AnalysisLiveAgent } from "@metis/shared";
import type {
  AnalysisAgentStatus,
  AnalysisFinding,
  AnalysisSnapshot,
  AnalysisStatus,
  EnhancementMetadata,
  FindingVerificationStatus,
  TicketStatus,
} from "@/lib/analysis-api";

export const ANALYSIS_TABS = [
  { value: "summary", label: "Summary" },
  { value: "requirements", label: "Requirements" },
  { value: "findings", label: "Findings" },
  { value: "questions", label: "Questions" },
  { value: "approvals", label: "Approvals" },
  { value: "agents", label: "Agent output" },
  { value: "traceability", label: "Traceability" },
] as const;

export type AnalysisTab = (typeof ANALYSIS_TABS)[number]["value"];

export const DEFAULT_ANALYSIS_TAB: AnalysisTab = "summary";

/** Findings per page. 100+ findings stay responsive because only this many mount. */
export const FINDINGS_PAGE_SIZE = 20;
/** Requirements per page. Each card mounts its own traceability, links and mappings panels. */
export const REQUIREMENTS_PAGE_SIZE = 5;

/** Read `?tab=`; anything unknown falls back to the Summary. */
export function parseAnalysisTab(raw: string | null | undefined): AnalysisTab {
  return ANALYSIS_TABS.some((t) => t.value === raw) ? (raw as AnalysisTab) : DEFAULT_ANALYSIS_TAB;
}

/**
 * In-page anchors that predate the tabs, mapped to the tab that now holds their
 * target. "Go to approvals" (#1104, #362) and "Review questions" (#1135) keep
 * working without every panel learning about the tabs.
 */
const ANCHOR_TABS: Record<string, AnalysisTab> = {
  "#approvals": "approvals",
  "#clarifying-questions": "questions",
};

/** The tab an in-page `href` points into, or null when it is not one of ours. */
export function tabForAnchor(href: string | null | undefined): AnalysisTab | null {
  if (!href) return null;
  return ANCHOR_TABS[href] ?? null;
}

/**
 * The same URL with `patch` applied to its query string. A `null` value removes
 * the key. Other parameters are preserved, so a tab switch keeps `analysisId`.
 */
export function analysisViewHref(
  pathname: string,
  current: URLSearchParams | { toString(): string } | null,
  patch: Record<string, string | null>,
): string {
  const params = new URLSearchParams(current?.toString() ?? "");
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) params.delete(key);
    else params.set(key, value);
  }
  const qs = params.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

// ── Findings ────────────────────────────────────────────────────────────────

export type AgentFinding = AnalysisFinding & { agentKey: string };

export interface FindingFilters {
  severity: string | null;
  category: string | null;
  agentKey: string | null;
  verification: FindingVerificationStatus | null;
}

export const NO_FINDING_FILTERS: FindingFilters = {
  severity: null,
  category: null,
  agentKey: null,
  verification: null,
};

const VERIFICATION_VALUES: readonly FindingVerificationStatus[] = [
  "confirmed",
  "unverified",
  "ungrounded",
];

/**
 * Issue #424 — the findings filters as query-string keys, so a filtered view
 * can be shared. `agentKey` is written as `agent`.
 */
export function findingFiltersParams(f: FindingFilters): Record<string, string | null> {
  return {
    severity: f.severity,
    category: f.category,
    agent: f.agentKey,
    verification: f.verification,
  };
}

/**
 * Issue #476 — whether two filter sets select the same findings. The page
 * compares the URL's filters with the shown ones, so its own write echoing
 * back through the router is not taken for a navigation.
 */
export function sameFindingFilters(a: FindingFilters, b: FindingFilters): boolean {
  return (
    a.severity === b.severity &&
    a.category === b.category &&
    a.agentKey === b.agentKey &&
    a.verification === b.verification
  );
}

/**
 * Read the findings filters back from the query string. An empty value is no
 * filter; a verification value the filter bar has no button for is dropped,
 * since no control could show it as selected or clear it.
 */
export function parseFindingFilters(
  params: URLSearchParams | { get(key: string): string | null } | null | undefined,
): FindingFilters {
  const read = (key: string) => params?.get(key) || null;
  const verification = read("verification");
  return {
    severity: read("severity"),
    category: read("category"),
    agentKey: read("agent"),
    verification: VERIFICATION_VALUES.includes(verification as FindingVerificationStatus)
      ? (verification as FindingVerificationStatus)
      : null,
  };
}

/** Every non-synthesis finding, tagged with the agent that produced it. */
export function collectFindings(snapshot: Pick<AnalysisSnapshot, "agentResults">): AgentFinding[] {
  return snapshot.agentResults
    .filter((a) => a.agentKey !== "synthesis")
    .flatMap((a) => a.findings.map((f) => ({ ...f, agentKey: a.agentKey })));
}

export function filterFindings<T extends AgentFinding>(
  findings: readonly T[],
  f: FindingFilters,
): T[] {
  return findings.filter(
    (x) =>
      (f.severity === null || x.severity === f.severity) &&
      (f.category === null || x.category === f.category) &&
      (f.agentKey === null || x.agentKey === f.agentKey) &&
      (f.verification === null || (x.verificationStatus ?? null) === f.verification),
  );
}

const SEVERITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

function bySeverity(a: string, b: string): number {
  const ra = SEVERITY_RANK[a] ?? Number.MAX_SAFE_INTEGER;
  const rb = SEVERITY_RANK[b] ?? Number.MAX_SAFE_INTEGER;
  return ra !== rb ? ra - rb : a.localeCompare(b);
}

/** The values each filter can take, drawn from the run itself. */
export function findingFacets(findings: readonly AgentFinding[]): {
  severities: string[];
  categories: string[];
  agents: string[];
} {
  const severities = new Set<string>();
  const categories = new Set<string>();
  const agents = new Set<string>();
  for (const f of findings) {
    severities.add(f.severity);
    categories.add(f.category);
    agents.add(f.agentKey);
  }
  return {
    severities: [...severities].sort(bySeverity),
    categories: [...categories].sort((a, b) => a.localeCompare(b)),
    agents: [...agents].sort((a, b) => a.localeCompare(b)),
  };
}

// ── Paging ──────────────────────────────────────────────────────────────────

export interface Page<T> {
  items: T[];
  /** Zero-based, clamped into range. */
  page: number;
  pageCount: number;
  total: number;
  /** One-based index of the first item shown; 0 when empty. */
  from: number;
  /** One-based index of the last item shown; 0 when empty. */
  to: number;
}

export function paginate<T>(items: readonly T[], page: number, pageSize: number): Page<T> {
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(0, Math.floor(page)), pageCount - 1);
  const start = current * pageSize;
  const slice = items.slice(start, start + pageSize);
  return {
    items: slice,
    page: current,
    pageCount,
    total,
    from: slice.length > 0 ? start + 1 : 0,
    to: start + slice.length,
  };
}

/**
 * Issue #424 — the zero-based page of `items` that holds `id`, so a deep link
 * to a requirement opens the page it is on. `null` when the list lacks it.
 */
export function requirementPage(
  items: readonly { id: string }[],
  id: string,
  pageSize: number,
): number | null {
  const index = items.findIndex((item) => item.id === id);
  return index < 0 ? null : Math.floor(index / pageSize);
}

/**
 * Issue #424 — why the Traceability tab is empty. Its panels are built from a
 * completed run, so anything else would render a blank pane. `null` = the run
 * completed and the panels speak for themselves.
 */
export function traceabilityPendingMessage(status: AnalysisStatus): string | null {
  if (status === "completed") return null;
  if (status === "pending" || status === "running")
    return "Traceability is built when the run completes. Check back once it finishes.";
  return "This run did not complete, so there is no traceability to show.";
}

/**
 * Issue #766 — the badge an agent card shows. A row that completed DEGRADED
 * (the server's `AGENT_DEGRADED_NOTE_PREFIX` note on its output) reads
 * `degraded`, not a green `completed`: the code agent that exhausted its budget
 * and recovered 0 findings looked like a clean run everywhere but the Summary.
 */
export function agentDisplayStatus(
  agent: {
    status: AnalysisAgentStatus;
    notes?: readonly string[] | null;
  },
  /**
   * #766 — the agent's live entry, when it is running right now. A Regenerate
   * leaves the old row `completed` until the new result replaces it, so the
   * live entry wins over the stored status.
   */
  live?: AnalysisLiveAgent | null,
): AnalysisAgentStatus | "degraded" {
  if (live) return "running";
  if (
    agent.status === "completed" &&
    (agent.notes ?? []).some((n) => n.startsWith(AGENT_DEGRADED_NOTE_PREFIX))
  ) {
    return "degraded";
  }
  return agent.status;
}

/** Whole minutes and seconds since `startedAt`, e.g. `4m 12s`; `0s` for a future time. */
function elapsedLabel(startedAt: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  if (!Number.isFinite(seconds)) return "";
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

/**
 * Issue #766 — the line an agent card shows while the agent runs: whether it is
 * a re-run, what it is doing, the code agent's steps (tool calls) so far, and for how
 * long. A 23-minute "Continue" used to show nothing but the run header's
 * `running` (#706 run 8).
 */
export function liveAgentLine(live: AnalysisLiveAgent, now: number = Date.now()): string {
  const parts = [live.rerun ? "Re-running" : "Running"];
  if (live.phase === "synthesizing") {
    parts.push("updating the run summary with the new findings");
  } else if (live.toolCalls > 0) {
    parts.push(`${live.toolCalls} step${live.toolCalls === 1 ? "" : "s"} so far`);
  }
  const elapsed = elapsedLabel(live.startedAt, now);
  if (elapsed) parts.push(elapsed);
  return parts.join(" · ");
}

/**
 * Issue #766 review — how long an agent seen running keeps showing as running
 * across polls that do not carry it. Polls run every 2.5 s; with two replicas
 * and no session affinity every other poll can land on the pod that is not
 * running the agent, so a sighting is normally refreshed within a few seconds.
 */
export const LIVE_AGENT_STICKY_MS = 60_000;

/** What the page remembers about an agent it has seen running. */
export interface StickyLiveAgent {
  live: AnalysisLiveAgent;
  /** {@link agentRowSignature} of the agent's stored rows when it was last seen running. */
  rowSignature: string;
  lastSeenAt: number;
}

export interface StickyLiveState {
  analysisId: string | null;
  entries: ReadonlyMap<string, StickyLiveAgent>;
}

export const EMPTY_STICKY_LIVE_STATE: StickyLiveState = { analysisId: null, entries: new Map() };

/**
 * The stored rows of one agent, reduced to what changes when a re-run replaces
 * them. The snapshot's agent rows carry no id of their own, so the row's
 * status, times and finding count stand for it.
 */
export function agentRowSignature(
  rows: ReadonlyArray<{
    agentKey: string;
    status: string;
    startedAt: string | null;
    completedAt: string | null;
    findings?: readonly unknown[];
  }>,
  agentKey: string,
): string {
  return rows
    .filter((r) => r.agentKey === agentKey)
    .map(
      (r) => `${r.status}|${r.startedAt ?? ""}|${r.completedAt ?? ""}|${r.findings?.length ?? 0}`,
    )
    .sort()
    .join(";");
}

/**
 * Issue #766 review — the live agents to show, given the previous state and a
 * new snapshot. The server's live registry is per process (see
 * `server/src/lib/analysis/live-agent-progress.ts`): on a multi-replica
 * deployment a poll served by another pod carries no entry, and the card would
 * flip between "running" and its stale `completed` row. So an agent seen
 * running stays running until its stored rows change (the re-run replaced
 * them), the run stops `running`, or {@link LIVE_AGENT_STICKY_MS} passes with
 * no sighting. A kept entry shows its last-seen step count.
 */
export function stickyLiveAgents(
  prev: StickyLiveState,
  snapshot: {
    id: string;
    status: string;
    agentResults: Parameters<typeof agentRowSignature>[0];
    liveAgents?: readonly AnalysisLiveAgent[];
  },
  now: number,
): { state: StickyLiveState; live: AnalysisLiveAgent[] } {
  const fresh = snapshot.liveAgents ?? [];
  const running = snapshot.status === "running" || snapshot.status === "pending";
  if (!running) {
    return { state: { analysisId: snapshot.id, entries: new Map() }, live: [...fresh] };
  }
  const entries = new Map<string, StickyLiveAgent>();
  for (const live of fresh) {
    entries.set(live.agentKey, {
      live,
      rowSignature: agentRowSignature(snapshot.agentResults, live.agentKey),
      lastSeenAt: now,
    });
  }
  if (prev.analysisId === snapshot.id) {
    for (const [agentKey, entry] of prev.entries) {
      if (entries.has(agentKey)) continue;
      if (now - entry.lastSeenAt >= LIVE_AGENT_STICKY_MS) continue;
      if (agentRowSignature(snapshot.agentResults, agentKey) !== entry.rowSignature) continue;
      entries.set(agentKey, entry);
    }
  }
  return {
    state: { analysisId: snapshot.id, entries },
    live: [...entries.values()].map((e) => e.live),
  };
}

/**
 * Issue #766 — the cards the Agent output tab renders: every stored result,
 * plus a placeholder for an agent running with no stored result yet (the code
 * agent mid-investigation in a normal run), so a running agent is never
 * invisible. Each card carries its live entry, or `null`.
 */
export function agentCards<T extends { agentKey: string }>(
  results: readonly T[],
  live: readonly AnalysisLiveAgent[],
): Array<{ result: T | null; agentKey: string; live: AnalysisLiveAgent | null }> {
  const byKey = new Map(live.map((l) => [l.agentKey, l]));
  const cards: Array<{ result: T | null; agentKey: string; live: AnalysisLiveAgent | null }> =
    results.map((result) => ({
      result,
      agentKey: result.agentKey,
      live: byKey.get(result.agentKey) ?? null,
    }));
  const shown = new Set(results.map((r) => r.agentKey));
  for (const l of live) {
    if (!shown.has(l.agentKey)) cards.push({ result: null, agentKey: l.agentKey, live: l });
  }
  return cards;
}

// ── Tab counts ──────────────────────────────────────────────────────────────

// Type-only narrowing (the same cast `readEnhancementMetadata` makes), kept
// local so this module has no runtime dependency on the API client.
function enhancementOf(metadata: Record<string, unknown> | null | undefined): EnhancementMetadata {
  return metadata && typeof metadata === "object" ? (metadata as EnhancementMetadata) : {};
}

/** True when the run asked for either enhancement the Questions tab shows. */
export function runHasQuestionsView(metadata: Record<string, unknown> | null | undefined): boolean {
  const flags = enhancementOf(metadata).enhancement;
  return Boolean(flags?.enableClarification || flags?.enableWebResearch);
}

/**
 * Issue #1355 — what the Approvals tab says when the run has no approval
 * checkpoints. A run whose requirements-extraction step failed creates none,
 * so nothing holds its requirements back: synthesis saves them unreviewed. The
 * plain "no approval checkpoints" line read as though review was not needed;
 * this says why there is nothing to approve and what it means for the
 * requirements already on screen.
 */
export function approvalsNoneMessage(
  metadata: Record<string, unknown> | null | undefined,
  requirementCount: number,
  analysisStatus: AnalysisStatus,
): { testId: string; text: string } {
  const failure = enhancementOf(metadata).structuredExtractionFailure;
  if (!failure) {
    return { testId: "approvals-none", text: "This run has no approval checkpoints." };
  }
  // PR #1409 review — a provider failure means no answer came back at all, so
  // it must not be worded as an answer METIS could not read.
  const why =
    failure.reason === "provider-error"
      ? "the request to the AI model failed and no requirements came back"
      : failure.reason === "empty-response"
        ? "the AI model returned an empty answer"
        : "METIS could not read the requirements out of the AI model’s answer";
  const cause = `No approval checkpoints were created for this run: ${why}, so nothing was put up for approval.`;
  // While the run is still going, "run it again" is premature advice and no
  // requirement has been saved yet.
  if (analysisStatus === "pending" || analysisStatus === "running") {
    return {
      testId: "approvals-none-extraction-failed",
      text: `${cause} Requirements this run saves will not have been reviewed.`,
    };
  }
  const consequence =
    requirementCount > 0
      ? ` The ${requirementCount === 1 ? "requirement" : `${requirementCount} requirements`} ` +
        `on the Requirements tab ${requirementCount === 1 ? "was" : "were"} saved without ` +
        "review. Run the analysis again to review requirements before they are saved."
      : " Run the analysis again to review requirements before they are saved.";
  return { testId: "approvals-none-extraction-failed", text: cause + consequence };
}

/**
 * The number shown on each tab. Questions and Approvals count what is still
 * OUTSTANDING (open ambiguities, pending approvals) rather than a total, since
 * that is what a reader goes there to clear. `undefined` = no count to show.
 */
export function analysisTabCounts(
  snapshot: Pick<AnalysisSnapshot, "agentResults" | "requirements" | "metadata">,
  ticketStatus: TicketStatus | undefined,
): Partial<Record<AnalysisTab, number>> {
  const enhancement = enhancementOf(snapshot.metadata);
  const clarification = enhancement.enhancement?.enableClarification ?? false;
  // Issue #1081 (from the #1084 review) — when extraction failed there is no
  // count of open questions to show: "0" read as "nothing to clarify". The tab
  // shows no number and its content says the step failed.
  const extractionFailed = Boolean(enhancement.structuredExtractionFailure);
  return {
    requirements: snapshot.requirements.length,
    findings: collectFindings(snapshot).length,
    questions:
      clarification && !extractionFailed
        ? (enhancement.structuredRequirements?.totalAmbiguities ?? 0)
        : undefined,
    approvals: ticketStatus?.pendingCount,
    agents: snapshot.agentResults.length,
  };
}

/**
 * Issue #909 — the Deep Dive button's state. While the approvals were loading
 * the button read "blocked until 0 pending approval(s) are resolved" (or was
 * enabled before the gate was known); say it is checking instead, and wait.
 */
export function deepDiveGate(input: {
  loading: boolean;
  failed?: boolean;
  ticketStatus: TicketStatus | undefined;
}): {
  disabled: boolean;
  title: string;
} {
  if (input.loading) return { disabled: true, title: "Checking approvals…" };
  // A failed lookup must not read as an open gate (the server still enforces it).
  if (input.failed) return { disabled: true, title: "Could not check approvals" };
  if (input.ticketStatus && !input.ticketStatus.allowed) {
    // #723 — name the real reason: only PENDING approvals hold the gate.
    return {
      disabled: true,
      title: `Ticket creation is blocked until ${input.ticketStatus.pendingCount} pending approval(s) are resolved`,
    };
  }
  return { disabled: false, title: "Expand this finding into a publishable issue draft" };
}

/** Accessible wording for a tab's count badge. */
export function tabCountLabel(tab: AnalysisTab, count: number): string {
  if (tab === "questions") return `${count} open`;
  if (tab === "approvals") return `${count} pending`;
  return String(count);
}
