/**
 * Socket.IO event contracts — shared by the Node server and the browser UI so
 * the typed `socket.on(...)` / `io.emit(...)` surfaces line up at compile time.
 */
import type { AGENT_RESULT_STATUSES, ANALYSIS_AGENT_KEYS } from "./constants.js";
import type { AnalysisCapability, AnalysisSkippedRepo } from "./analysis.js";

export interface ProjectRoomEvent {
  projectId: string;
}
export interface AnalysisRoomEvent {
  analysisId: string;
}
export interface SessionRoomEvent {
  sessionId: string;
}
/** Epic #238 (#239) — per-job room for unified job-lifecycle events. */
export interface JobRoomEvent {
  jobId: string;
}
/** Epic #475 (Phase 2, #480) — per-discussion-thread room (`thread:{id}`). */
export interface ThreadRoomEvent {
  threadId: string;
}

export type AnalysisAgentEventType = "started" | "chunk" | "completed" | "failed" | "cancelled";

/** Per-agent progress event broadcast inside `analysis:{id}` rooms (Phase 7). */
export interface AnalysisAgentEvent {
  analysisId: string;
  agentKey: (typeof ANALYSIS_AGENT_KEYS)[number];
  status: (typeof AGENT_RESULT_STATUSES)[number];
  type: AnalysisAgentEventType;
  message?: string;
  findingCount?: number;
  errorMessage?: string;
  ts: number;
}

/**
 * Epic #202 follow-up (#256) — distinct promotion-blocked outcome payload.
 * Broadcast on the `analysis:{id}` room when promotion is gated on unresolved
 * approvals. Carries the blocking reason and outstanding approval counts so the
 * ApprovalsPanel / analysis page can react directly.
 */
export interface PromotionBlockedEvent {
  analysisId: string;
  /** Number of approval requests still pending. */
  pendingCount: number;
  /** Number of approval requests that were rejected. */
  rejectedCount: number;
  /** Human-readable blocking reason for the UI banner. */
  reason: string;
  ts: number;
}

/**
 * Issue #733 (Epic #725) — analysis-capability payload broadcast on the
 * `analysis:{id}` room. Carries the same structured record persisted on the
 * snapshot so the UI can render the degradation banner mid-run.
 */
export interface AnalysisCapabilityEvent {
  analysisId: string;
  capability: AnalysisCapability;
  ts: number;
}

/**
 * Issue #741 (Epic #727) — structured multi-repo budget-cap warning, emitted on
 * the `analysis:{id}` room the moment a run drops repos because the per-repo
 * token budget fell below the minimum. Carries the dropped connectors + reason
 * so the UI can name them and offer the "re-run remaining repos" action, rather
 * than the drop surviving only as a server `log.warn`.
 */
export interface AnalysisReposSkippedEvent {
  analysisId: string;
  /** The connectors dropped from this run for insufficient per-repo budget. */
  skipped: AnalysisSkippedRepo[];
  /** Machine reason (mirrors the capability record's `repos-skipped-budget`). */
  reason: "repos-skipped-budget";
  /** The floor (tokens) that the per-repo budget fell below. */
  minPerRepoTokenBudget: number;
  ts: number;
}

// ---- Epic #238 (#239): unified job-lifecycle events ------------------------

/**
 * The long-running flows that emit unified job-lifecycle events.
 *
 * This union is the single extension point for the realtime job-events bus
 * (Epic #406 / #419). Every kind here can publish `started`/`progress`/
 * `completed`/`failed` transitions on `job:{jobId}` + `project:{projectId}` via
 * the `jobEvents` emitter seam in `server/src/lib/socket/job-events.ts`.
 *
 * Adding a kind is intentionally a compile-time tripwire: the
 * `GENERIC_FAILURE_MESSAGE` record (server) must gain a user-safe failure
 * string for it (#254 invariant), and the UI consumer in
 * `ui/src/hooks/use-job-events.ts` handles new kinds generically.
 *
 * Original kinds (#238/#239): `analysis`, `doc-generation`, `impact-analysis`.
 * Added by #406/#419: `scan`, `pr-review`, `import-sync`, `embeddings-reindex`,
 * `spec-kit`, `overview-regenerate`.
 *
 * See `docs/ARCHITECTURE.md` § "Realtime job-events bus" for the full contract.
 */
export type JobKind =
  | "analysis"
  | "doc-generation"
  | "impact-analysis"
  | "scan"
  | "pr-review"
  | "import-sync"
  | "embeddings-reindex"
  | "spec-kit"
  | "overview-regenerate";

/** Lifecycle phase of a job. */
export type JobStatus = "started" | "progress" | "completed" | "failed";

/**
 * Unified job-lifecycle event (#239). Broadcast on both the per-job room
 * (`job:{jobId}`) and, when known, the `project:{projectId}` room so clients
 * watching a project surface get updates without subscribing to every job id.
 *
 * Event name convention: `job:{status}` (e.g. `job:started`, `job:progress`).
 */
export interface JobLifecycleEvent {
  kind: JobKind;
  jobId: string;
  /** Null for cross-project jobs (e.g. multi-project impact analysis). */
  projectId: string | null;
  status: JobStatus;
  /** 0-100 completion percentage when known. */
  progress?: number;
  /** Short human-readable step/message for the current transition. */
  message?: string;
  /** Error text on `failed`. */
  error?: string;
  ts: number;
}

/**
 * Per-section document-generation progress event (#243). Extends the job
 * channel with section-level detail and degraded/failed-section warnings
 * (reuses the #204 DocWarning shape, flattened to avoid a cross-package import).
 */
export interface DocSectionProgressEvent {
  jobId: string;
  projectId: string;
  /** Section group label. */
  section: string;
  /** Section lifecycle: queued -> generating -> (done | degraded | failed). */
  status: "queued" | "generating" | "done" | "degraded" | "failed";
  /** 1-based index of this section within the document. */
  index?: number;
  /** Total number of sections, when known. */
  total?: number;
  /** Surfaceable warning for degraded/failed sections (matches #204 DocWarning). */
  warning?: {
    kind:
      | "section-failed"
      | "section-ungrounded"
      | "no-modules"
      | "source-unavailable"
      | "facts-truncated"
      // #1226 — the model was cut off by the output-token cap, or the section
      // never reached the assembled document.
      | "section-truncated"
      | "section-missing"
      // DOCS_GEN_GROUNDING=off / sample — the section was not, or only
      // partly, fact-checked.
      | "grounding-skipped"
      | "grounding-sampled";
    severity: "warning" | "error";
    message: string;
  };
  ts: number;
}

// ---- Epic #475 (Phase 2, #481): discussion message fan-out -----------------

/**
 * A discussion message as fanned out over the `thread:{id}` room. Mirrors the
 * `DiscussionMessage` columns the REST history endpoint selects, with full
 * attribution (`authorKind` discriminator + author identity) so the UI can
 * render a human vs AI message without a follow-up fetch. Dates are serialized
 * to ISO strings for transport.
 */
export interface DiscussionMessagePayload {
  id: string;
  threadId: string;
  /** `human` | `ai` — author discriminator. */
  authorKind: string;
  /** Set iff `authorKind === "human"`. */
  authorUserId: string | null;
  /** Set iff `authorKind === "ai"`. */
  aiProvider: string | null;
  aiModel: string | null;
  aiSessionId: string | null;
  body: string;
  createdAt: string;
  editedAt: string | null;
}

/** Epic #475 (#481) — a new message was posted to a discussion thread. */
export interface DiscussionMessageNewEvent {
  threadId: string;
  message: DiscussionMessagePayload;
  ts: number;
}

/**
 * Epic #475 (#481) — an incremental chunk of a streaming AI reply in a thread.
 * `messageId` ties chunks to the message row once persisted; `done` marks the
 * final chunk. Wired for Phase 3 LLM streaming; the emitter ships here so the
 * `thread:{id}` room is the single fan-out seam.
 */
export interface DiscussionMessageStreamEvent {
  threadId: string;
  /** The (eventual) DiscussionMessage id this stream belongs to, when known. */
  messageId?: string;
  /** Incremental text delta. */
  delta: string;
  /** True on the terminal chunk. */
  done: boolean;
  ts: number;
}

/** Events the server emits to clients. */
export interface ServerToClientEvents {
  /** Epic #475 (#481) — a new discussion message was posted to `thread:{id}`. */
  "message:new": (data: DiscussionMessageNewEvent) => void;
  /** Epic #475 (#481) — a streaming AI-reply chunk for a thread message. */
  "message:stream": (data: DiscussionMessageStreamEvent) => void;
  /** Epic #238 (#239) — unified job-lifecycle event. */
  "job:lifecycle": (data: JobLifecycleEvent) => void;
  /** Epic #238 (#243) — per-section doc-generation progress + warnings. */
  "job:doc-section": (data: DocSectionProgressEvent) => void;
  "auth:ok": (data: { userId: string; username: string }) => void;
  "auth:error": (data: { message: string }) => void;
  "analysis:agent": (data: AnalysisAgentEvent) => void;
  /**
   * Epic #202 follow-up (#256) — distinct promotion-blocked outcome. Emitted
   * when synthesis succeeds but artifact promotion is gated on unresolved
   * approvals, so the UI can show a precise "promotion blocked" indicator from
   * the socket stream alone instead of inferring it from metadata.
   */
  "analysis:promotion-blocked": (data: PromotionBlockedEvent) => void;
  /**
   * Issue #733 (Epic #725) — structured analysis-capability record, emitted
   * once the run has resolved the code agent's mode so the UI can warn about
   * degraded modes during the run (not only after it completes).
   */
  "analysis:capability": (data: AnalysisCapabilityEvent) => void;
  /**
   * Issue #741 (Epic #727) — multi-repo budget cap dropped one or more repos.
   * Emitted at the cap point (mid-run) alongside the capability record so the UI
   * can surface a "re-run remaining repos" action immediately.
   */
  "analysis:repos-skipped": (data: AnalysisReposSkippedEvent) => void;
  "analysis:completed": (data: { analysisId: string }) => void;
  "analysis:failed": (data: { analysisId: string; errorMessage: string }) => void;
  "analysis:cancelled": (data: { analysisId: string }) => void;
  /**
   * Issue #78 (Epic #739) — a new pending drift event was reconciled for a
   * project. IDENTIFIER-ONLY by design: the drift badge re-reads the
   * permission-checked `GET /sync/drift/count` rather than rendering anything
   * from this payload, so the socket carries no issue content.
   */
  "drift:detected": (data: {
    projectId: string;
    driftEventId: string;
    requirementId: string | null;
    status: string;
    ts: number;
  }) => void;
  "document:status": (data: {
    projectId: string;
    documentId: string;
    status: "pending" | "queued" | "processing" | "ready" | "failed";
    chunkCount?: number;
    errorMessage?: string | null;
    /** Issue #133 — current attempt for queued/retry transitions. */
    attempt?: number;
  }) => void;
  "mcp:status": (data: {
    serverId: string;
    label: string;
    scope: "global" | "project" | "user";
    projectId: string | null;
    status: "idle" | "starting" | "ready" | "error" | "disabled";
    latencyMs?: number | null;
    failureCount?: number;
    lastError?: string | null;
    ts: number;
  }) => void;
  // Epic #162 — per-session approval prompt + decision broadcast.
  "mcp:approval:requested": (data: {
    approvalId: string;
    sessionId: string;
    serverId: string;
    serverLabel: string;
    toolName: string;
    risk: "low" | "medium" | "high";
    args: unknown;
    /** Hidden-char ranges precomputed on the server so the UI can highlight them. */
    hiddenCharRanges: Array<{ start: number; end: number; code: number; label: string }>;
    timeoutMs: number;
    ts: number;
  }) => void;
  "mcp:approval:decided": (data: {
    approvalId: string;
    sessionId: string;
    decision: "approved" | "denied" | "timeout";
    ts: number;
  }) => void;
  "connector:status": (data: ConnectorStatusEvent) => void;
  "connector:progress": (data: ConnectorProgressEvent) => void;
  "connector:discovery": (data: ConnectorDiscoveryEvent) => void;
  "publish:status": (data: PublishStatusEvent) => void;
  "publish:progress": (data: PublishProgressEvent) => void;
  "publish:completed": (data: PublishCompletedEvent) => void;
  "scheduler:status": (data: SchedulerStatusEvent) => void;
  "task:status": (data: TaskStatusEvent) => void;
  "task:progress": (data: TaskProgressEvent) => void;
  /** Epic #164 — per-call FinOps tick broadcast on `project:{id}`. */
  "usage:tick": (data: {
    projectId: string;
    sessionId: string;
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    /** `null` = the model is unpriced (#22). */
    costCents: number | null;
    ts: number;
  }) => void;
  /** Epic #156 — async background run lifecycle event. */
  "bg-run:status": (data: {
    id: string;
    projectId: string;
    status: "queued" | "running" | "paused" | "cancelled" | "failed" | "succeeded";
    error?: string | null;
    ts: number;
  }) => void;
  /** Epic #156 — per-step progress event for an active background run. */
  "bg-run:step": (data: { runId: string; kind: string; content: string; ts: number }) => void;
  /** Epic #856/#880 — test-coverage run progress (queued/started/progress). */
  "testcoverage:run-update": (data: TestCoverageRunSocketEvent) => void;
  /** Epic #856/#880 — test-coverage run terminal state (completed/failed). */
  "testcoverage:run-finished": (data: TestCoverageRunSocketEvent) => void;
  heartbeat: (data: { ts: number }) => void;
  /** Epic #728 — presence update for an artifact room. */
  "presence:update": (data: {
    room: string;
    users: Array<{ userId: string; username: string; displayName: string }>;
    ts: number;
  }) => void;
  /**
   * Epic #475 (Phase 2, #482) — ephemeral typing indicator for a discussion
   * thread, broadcast to OTHER room members (never echoed to the sender).
   */
  "typing:update": (data: {
    threadId: string;
    userId: string;
    username: string;
    isTyping: boolean;
    ts: number;
  }) => void;
  /** Epic #728 — a user was @mentioned in a comment. */
  "comment:mention": (data: { commentId: string; mentionedUserId: string; ts: number }) => void;
  /** Epic #475 (#489) — a project member was @mentioned in a discussion message. */
  "discussion:mention": (data: {
    kind: "discussion_mention";
    threadId: string;
    messageId: string;
    mentionedUserId: string;
    ts: number;
  }) => void;
  /**
   * Epic #609 (#621) — a review lifecycle event for the recipient: reviewers
   * on submit (`review_requested`); the requester on each decision
   * (`review_decided`) and on the terminal outcome (`review_approved` /
   * `review_rejected`, with the auto-created baselineId when one exists).
   * Delivered to the recipient's personal `user:{id}` room only.
   */
  "review:notification": (data: {
    kind: "review_requested" | "review_decided" | "review_approved" | "review_rejected";
    reviewId: string;
    userId: string;
    ts: number;
    projectId?: string;
    reviewerId?: string;
    decision?: "approved" | "rejected";
    baselineId?: string | null;
  }) => void;
  /** Epic #728 — client exceeded the per-socket presence room cap. */
  "presence:error": (data: { message: string }) => void;
  /** Epic #728 — SLA deadline has passed for an assignment. */
  "sla:deadline_expired": (data: {
    assignmentId: string;
    requirementId: string;
    requirementTitle: string;
    slaDeadline: string | undefined;
    ts: number;
  }) => void;
}

/** Epic #856/#880 — test-coverage run lifecycle socket payload. */
export interface TestCoverageRunSocketEvent {
  type: "run:queued" | "run:started" | "run:progress" | "run:completed" | "run:failed";
  runId: string;
  projectId: string;
  phase?: string;
  detail?: Record<string, unknown>;
  error?: string;
}

export interface ConnectorRoomEvent {
  connectorId: string;
}

export interface ConnectorStatusEvent {
  connectorId: string;
  kind: "repo" | "db";
  status: "pending" | "connected" | "error" | "disabled";
  message?: string;
  errorMessage?: string | null;
  ts: number;
}

export interface ConnectorProgressEvent {
  connectorId: string;
  projectId?: string;
  kind: "repo" | "db";
  phase: "test" | "metadata" | "introspect" | "ingest" | "deep-ingest";
  step: string;
  current?: number;
  total?: number;
  status?: "running" | "error";
  errorMessage?: string;
  ts: number;
}

/** Epic #663/#669 — discovery notification after deep-ingest finds DB connections. */
export interface ConnectorDiscoveryEvent {
  projectId: string;
  connectorId: string;
  repoLabel: string;
  connectionsFound: number;
  ts: number;
}

export interface PublishRoomEvent {
  batchId: string;
}

export interface PublishStatusEvent {
  batchId: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  message?: string;
  errorMessage?: string | null;
  dryRun: boolean;
  ts: number;
}

export interface PublishProgressEvent {
  batchId: string;
  phase:
    | "prepare"
    | "sync-labels"
    | "dedup-scan"
    | "create-issue"
    | "link-sub-issue"
    | "rate-limit-pause"
    | "rollback";
  step: string;
  current?: number;
  total?: number;
  draftId?: string;
  issueNumber?: number;
  retryAfterMs?: number;
  ts: number;
}

export interface PublishCompletedEvent {
  batchId: string;
  status: "completed" | "failed" | "cancelled";
  publishedCount: number;
  failedCount: number;
  dedupSkipped: number;
  dryRun: boolean;
  ts: number;
}

/** Events the client sends to the server. */
export interface ClientToServerEvents {
  "subscribe:project": (data: ProjectRoomEvent) => void;
  "unsubscribe:project": (data: ProjectRoomEvent) => void;
  "subscribe:analysis": (data: AnalysisRoomEvent) => void;
  "unsubscribe:analysis": (data: AnalysisRoomEvent) => void;
  "subscribe:session": (data: SessionRoomEvent) => void;
  "unsubscribe:session": (data: SessionRoomEvent) => void;
  "subscribe:mcp": () => void;
  "unsubscribe:mcp": () => void;
  "subscribe:connector": (data: ConnectorRoomEvent) => void;
  "unsubscribe:connector": (data: ConnectorRoomEvent) => void;
  "subscribe:publish": (data: PublishRoomEvent) => void;
  "unsubscribe:publish": (data: PublishRoomEvent) => void;
  "subscribe:scheduler": () => void;
  "unsubscribe:scheduler": () => void;
  "subscribe:task": (data: TaskRoomEvent) => void;
  "unsubscribe:task": (data: TaskRoomEvent) => void;
  /** Epic #156 — subscribe to per-run step events. */
  "subscribe:bg-run": (data: { runId: string }) => void;
  "unsubscribe:bg-run": (data: { runId: string }) => void;
  /** Epic #238 (#239) — subscribe to per-job lifecycle events. */
  "subscribe:job": (data: JobRoomEvent) => void;
  "unsubscribe:job": (data: JobRoomEvent) => void;
  /**
   * Epic #475 (Phase 2, #480) — subscribe to a discussion thread's realtime
   * room (`thread:{id}`). Authz-gated server-side via `canAccessThread`:
   * non-members get `auth:error` and never join, so no thread events leak.
   */
  "subscribe:thread": (data: ThreadRoomEvent) => void;
  "unsubscribe:thread": (data: ThreadRoomEvent) => void;
  /**
   * Epic #475 (Phase 2, #482) — per-thread presence. Joining (authz-gated via
   * `canAccessThread`) adds the user to the thread's presence set and broadcasts
   * a `presence:update`; leaving / disconnecting removes them and rebroadcasts.
   */
  "presence:thread:join": (data: ThreadRoomEvent) => void;
  "presence:thread:leave": (data: ThreadRoomEvent) => void;
  /**
   * Epic #475 (Phase 2, #482) — ephemeral typing indicators scoped to a thread.
   * Broadcast to OTHER room members as `typing:update` (not persisted, not
   * echoed to the sender). Only honored for members of the thread room.
   */
  "typing:start": (data: ThreadRoomEvent) => void;
  "typing:stop": (data: ThreadRoomEvent) => void;
  /** Epic #728 — presence rooms per artifact. */
  "presence:join": (data: { artifactType: string; artifactId: string }) => void;
  "presence:leave": (data: { artifactType: string; artifactId: string }) => void;
}

// ---- Phase 11: Scheduler + Tasks -------------------------------------------

export interface TaskRoomEvent {
  taskId: string;
}

export interface SchedulerStatusEvent {
  jobId: string;
  key: string;
  status: "registered" | "updated" | "removed" | "fired" | "skipped" | "paused" | "resumed";
  enabled: boolean;
  nextRunAt?: string | null;
  message?: string;
  ts: number;
}

export interface TaskStatusEvent {
  taskId: string;
  scheduledJobId?: string | null;
  projectId?: string | null;
  type: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  attempts: number;
  maxAttempts: number;
  errorMessage?: string | null;
  ts: number;
}

export interface TaskProgressEvent {
  taskId: string;
  step: string;
  current?: number;
  total?: number;
  progress?: number; // 0-100
  ts: number;
}
