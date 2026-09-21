/**
 * Epic #158 — typed wrappers around `/api/runs` (replay) and
 * `/api/projects/:id/agents-md` (interop) endpoints.
 */
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
  stepCount: number;
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
