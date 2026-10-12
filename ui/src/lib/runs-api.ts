/**
 * Epic #158 — typed wrappers around `/api/runs` (replay) and
 * `/api/projects/:id/agents-md` (interop) endpoints.
 */
import type { LedgerTokens } from "@metis/shared";
import { apiFetch } from "@/lib/api-client";

export type AgentRunStatus = "running" | "completed" | "failed" | "cancelled";

export interface AgentRunSummary {
  id: string;
  sessionId: string;
  projectId: string | null;
  kind: string;
  status: AgentRunStatus;
  startedAt: string;
  completedAt: string | null;
  latencyMs: number | null;
  totalTokens: number | null;
  costCents: number | null;
  /**
   * #977 — the run's cost in USD, unrounded: the ledger's STORED cost of its
   * priced calls (what each was priced at when recorded, never a re-price).
   * `null` or absent when the ledger could not be read; the view falls back to
   * `costCents`.
   */
  costUsd?: number | null;
  /**
   * Tokens of the run's calls the ledger holds UNPRICED (#22): their cost is
   * unknown and is in no cost figure. `null` or absent with `costUsd`.
   */
  unpricedTokens?: number | null;
  /**
   * #1007 — the run's tokens from the ledger, with and without cache; they
   * move while the run goes. `null` or absent when the ledger could not be
   * read. `totalTokens` is the total stored when the run finished.
   */
  tokens?: LedgerTokens | null;
  /**
   * The part of `tokens` recorded AFTER the run finished — an analysis run
   * also counts a later deep dive, regenerate or clarification round on its
   * analysis. Zero for a run that is going; `null` or absent with `tokens`.
   */
  tokensAfterRun?: LedgerTokens | null;
  stepCount: number;
}

/**
 * #1007 — a chat turn's own row in the usage ledger: the chat model's calls in
 * that turn. A chat turn is not a run (it has no replay timeline); this is
 * where its cost is read. A turn that used a sub-agent or `apply_diff`, or
 * that triggered a compaction, spent more than its row: those calls are
 * separate ledger rows tied only to the session — see {@link ChatSessionSpend}.
 * Only the caller's own chat sessions are listed.
 */
export interface ChatTurnSummary {
  id: string;
  sessionId: string | null;
  projectId: string;
  /** `chat`, `chat-estimated` or `chat-failed`. */
  step: string;
  provider: string;
  model: string;
  createdAt: string;
  /** The chat model's calls in the turn; more than one when it ran a tool loop. */
  requests: number;
  tokens: LedgerTokens;
  /** The ledger's stored cost, unrounded USD; `null` when the row was recorded unpriced. */
  costUsd: number | null;
}

/** A slice of one chat session's ledger rows, summed. */
export interface ChatSpend {
  /** Model calls. */
  calls: number;
  tokens: LedgerTokens;
  /** Stored cost of the priced rows; `null` when none was priced; `0` for no rows. */
  costUsd: number | null;
  /** Tokens of rows recorded unpriced. */
  unpricedTokens: number;
}

/**
 * One chat session's WHOLE chat spend in the ledger, whatever page of turns is
 * listed: its turn rows, the rows other writers billed to the session
 * (sub-agent calls, `apply_diff`, compaction summaries), and their sum.
 */
export interface ChatSessionSpend {
  sessionId: string;
  projectId: string;
  turnCount: number;
  turns: ChatSpend;
  other: ChatSpend;
  total: ChatSpend;
}

export interface ChatTurnPage {
  items: ChatTurnSummary[];
  /** One entry per session with a turn in `items`. Absent from an older server. */
  sessions?: ChatSessionSpend[];
}

export interface AgentRunStep {
  id: string;
  ord: number;
  kind: string;
  content: unknown;
  spanId: string | null;
  traceId: string | null;
  latencyMs: number | null;
  createdAt: string;
}

export interface AgentRunDetail {
  run: Omit<AgentRunSummary, "stepCount">;
  steps: AgentRunStep[];
}

export interface AgentRunListFilters {
  projectId?: string;
  sessionId?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export const runsApi = {
  list(filters: AgentRunListFilters = {}): Promise<{ items: AgentRunSummary[] }> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) {
      if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
    }
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return apiFetch<{ items: AgentRunSummary[] }>(`/runs${suffix}`);
  },
  /** #1007 — the caller's own chat turns from the usage ledger, under the same filters. */
  chatTurns(filters: AgentRunListFilters = {}): Promise<ChatTurnPage> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) {
      if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
    }
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return apiFetch<ChatTurnPage>(`/runs/chat-turns${suffix}`);
  },
  get(id: string): Promise<AgentRunDetail> {
    return apiFetch<AgentRunDetail>(`/runs/${encodeURIComponent(id)}`);
  },
  replay(id: string): Promise<AgentRunDetail> {
    return apiFetch<AgentRunDetail>(`/runs/${encodeURIComponent(id)}/replay`);
  },
  review(id: string): Promise<{ runId: string; review: PrReviewRecord | null }> {
    return apiFetch<{ runId: string; review: PrReviewRecord | null }>(
      `/run-reviews/${encodeURIComponent(id)}`,
    );
  },
  /** Epic #395 #419 — sandbox sessions linked to this run. */
  sandboxSessions(id: string): Promise<{ runId: string; sessions: SandboxSessionApi[] }> {
    return apiFetch<{ runId: string; sessions: SandboxSessionApi[] }>(
      `/runs/${encodeURIComponent(id)}/sandbox-sessions`,
    );
  },
};

/** Epic #395 #419 — wire shape returned by GET /api/runs/:id/sandbox-sessions. */
export interface SandboxSessionApi {
  id: string;
  provider: string;
  vendorSandboxId: string;
  templateId: string | null;
  vCpus: number;
  memMiB: number;
  createdAt: string;
  destroyedAt: string | null;
  wallClockMs: number | null;
  costMicroUsd: number | null;
  outcome: string | null;
  errorMessage: string | null;
}

// Epic #192 (A.4 + A.6) — PR-review record exposed to the UI.
export interface PrReviewVerdict {
  acId: string;
  verdict: "satisfied" | "not_satisfied" | "uncertain";
  reasoning: string;
  evidenceFiles: string[];
}

export interface PrReviewComment {
  filePath: string;
  line: number;
  body: string;
  severity: "info" | "warning" | "risk";
}

export interface PrReviewSandboxResult {
  acId: string;
  exitCode: number;
  durationMs: number;
  truncated: boolean;
  stdout: string;
  stderr: string;
}

export interface PrReviewRecord {
  judge: {
    verdicts: PrReviewVerdict[];
    comments: PrReviewComment[];
    overallVerdict: "approve" | "request_changes" | "comment";
    summary: string;
  };
  sandboxResults: PrReviewSandboxResult[];
  reviewId: number | null;
  reviewUrl: string | null;
  postedAt: string | null;
}

// AGENTS.md API
export interface AgentsMdAgent {
  source: "builtin" | "agents-md" | "skill";
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  model?: string;
}

export interface AgentsMdPreview {
  title: string;
  preface: string;
  agents: AgentsMdAgent[];
  mcpServers: { label: string; tools: string[] }[];
}

export const agentsMdApi = {
  async getMarkdown(projectId: string): Promise<string> {
    const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/agents-md`, {
      credentials: "include",
    });
    if (!res.ok) throw new Error(`Failed to fetch AGENTS.md (${res.status})`);
    return res.text();
  },
  preview(projectId: string): Promise<AgentsMdPreview> {
    return apiFetch<AgentsMdPreview>(
      `/projects/${encodeURIComponent(projectId)}/agents-md/preview`,
    );
  },
};
