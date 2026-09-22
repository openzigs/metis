/**
 * Orchestrator tests \u2014 covers the parallel pipeline shape, abort/cancel
 * propagation, partial persistence on failure, single-agent regenerate, and
 * Socket.IO event ordering.
 *
 * Prisma is mocked in-memory; the AIProvider is a deterministic stub keyed on
 * the agent that produces the request (we read the agentKey out of the system
 * message because that's the only place it is mentioned by name).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface AnalysisRow {
  id: string;
  projectId: string;
  startedById: string;
  status: string;
  startedAt: Date;
  completedAt: Date | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  errorMessage: string | null;
  metadata: string | null;
  deletedAt: Date | null;
  project: { id: string; name: string; description: string; status: string };
}
interface AgentResultRow {
  id: string;
  analysisId: string;
  agentKey: string;
  // Issue #763 — the RepoConnection a multi-repo `code` result was produced for.
  connectorId: string | null;
  status: string;
  startedAt: Date;
  completedAt: Date | null;
  output: string | null;
  errorMessage: string | null;
  findings: Array<{
    id: string;
    category: string;
    severity: string;
    title: string;
    body: string;
    evidence: string | null;
  }>;
}

const projects = new Map<string, AnalysisRow["project"] & { deletedAt: Date | null }>();
const analyses = new Map<string, AnalysisRow>();
const agentResults = new Map<string, AgentResultRow>();
const requirements = new Map<string, { id: string; analysisId: string; deletedAt: Date | null }>();
// Epic #202 (#214/#215/#216) — durable approval requests created by the
// enhancement pipeline and read by the promotion gate.
interface ApprovalRow {
  id: string;
  analysisId: string;
  type: string;
  itemId: string;
  status: string;
  reviewerId: string | null;
  reviewNote: string | null;
  createdAt: Date;
  reviewedAt: Date | null;
}
const approvalRequests = new Map<string, ApprovalRow>();
// Epic #203 (#221) — cross-doc detection findings persisted by the pipeline.
const crossDocFindings = new Map<string, { id: string; analysisId: string; kind: string }>();
let id = 0;
const nid = (p: string) => `${p}_${++id}`;
// Epic #912 (#916) — toggles for the requirement-grounded path mocks.
let codeGraphExists = false;
let uploadedDocs: string[] = [];
// Issue #733 — toggle for repo-source-ingested detection (connector:repo:* docs).
let repoSourceExists = false;
// Issue #733 — repo connectors returned by prisma.repoConnection.findMany.
let repoConnectors: Array<{ id: string; label: string }> = [];

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    project: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; deletedAt: null } }) => {
        const p = projects.get(where.id);
        if (!p || p.deletedAt) return null;
        return p;
      }),
    },
    analysis: {
      create: vi.fn(async ({ data }: { data: Partial<AnalysisRow> }) => {
        const row: AnalysisRow = {
          id: nid("ana"),
          projectId: data.projectId!,
          startedById: data.startedById!,
          status: data.status ?? "running",
          startedAt: new Date(),
          completedAt: null,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          errorMessage: null,
          metadata: data.metadata ?? null,
          deletedAt: null,
          project: projects.get(data.projectId!) as AnalysisRow["project"],
        };
        analyses.set(row.id, row);
        return row;
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = analyses.get(where.id) as unknown as Record<string, unknown>;
          if (!row) throw new Error("not found");
          // Honour Prisma's `{ increment: n }` so finalizeAnalysisDelta works.
          for (const [k, v] of Object.entries(data)) {
            if (
              v &&
              typeof v === "object" &&
              "increment" in (v as Record<string, unknown>) &&
              typeof (v as { increment: unknown }).increment === "number"
            ) {
              const cur = typeof row[k] === "number" ? (row[k] as number) : 0;
              row[k] = cur + (v as { increment: number }).increment;
            } else {
              row[k] = v;
            }
          }
          return row;
        },
      ),
      findFirst: vi.fn(async ({ where }: { where: { id?: string } }) => {
        if (!where.id) return null;
        return analyses.get(where.id) ?? null;
      }),
      findMany: vi.fn(async () => [...analyses.values()].filter((a) => a.deletedAt === null)),
    },
    agentResult: {
      findFirst: vi.fn(
        // Issue #763 — mirror real Prisma: when the caller scopes the query by
        // `connectorId`, only a row for THAT connector matches. On unscoped
        // (legacy / non-code agent) callers, `connectorId` is undefined and the
        // match falls back to (analysisId, agentKey) — the pre-#763 behaviour that
        // makes the multi-repo clobber reproducible.
        async ({
          where,
        }: {
          where: { analysisId: string; agentKey: string; connectorId?: string };
        }) =>
          [...agentResults.values()].find(
            (a) =>
              a.analysisId === where.analysisId &&
              a.agentKey === where.agentKey &&
              (where.connectorId === undefined || a.connectorId === where.connectorId),
          ) ?? null,
      ),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        agentResults.delete(where.id);
        return null;
      }),
      create: vi.fn(async ({ data }: { data: Partial<AgentResultRow> }) => {
        const row: AgentResultRow = {
          id: nid("agr"),
          analysisId: data.analysisId!,
          agentKey: data.agentKey!,
          connectorId: data.connectorId ?? null,
          status: data.status ?? "completed",
          startedAt: data.startedAt ?? new Date(),
          completedAt: data.completedAt ?? null,
          output: data.output ?? null,
          errorMessage: data.errorMessage ?? null,
          findings: [],
        };
        agentResults.set(row.id, row);
        return row;
      }),
      findMany: vi.fn(async ({ where }: { where: { analysisId: string } }) =>
        [...agentResults.values()]
          .filter((a) => a.analysisId === where.analysisId)
          .map((a) => ({ ...a })),
      ),
    },
    finding: {
      create: vi.fn(
        async ({ data }: { data: { agentResultId: string } & Record<string, unknown> }) => {
          const ar = agentResults.get(data.agentResultId);
          const row = {
            id: nid("fnd"),
            agentResultId: data.agentResultId,
            category: String(data.category),
            severity: String(data.severity),
            title: String(data.title),
            body: String(data.body),
            evidence: data.evidence === undefined ? null : String(data.evidence),
          };
          if (ar) ar.findings.push(row);
          return row;
        },
      ),
    },
    requirement: {
      deleteMany: vi.fn(async ({ where }: { where: { analysisId: string } }) => {
        for (const [k, v] of requirements)
          if (v.analysisId === where.analysisId) requirements.delete(k);
        return { count: 0 };
      }),
      create: vi.fn(async ({ data }: { data: { analysisId: string } }) => {
        const row = { id: nid("req"), analysisId: data.analysisId, deletedAt: null };
        requirements.set(row.id, row);
        return row;
      }),
    },
    // Epic #203 (#221) — cross-document detection findings persisted
    // post-synthesis. In-memory so we can assert the pass ran.
    crossDocFinding: {
      deleteMany: vi.fn(async ({ where }: { where: { analysisId: string } }) => {
        for (const [k, v] of crossDocFindings)
          if (v.analysisId === where.analysisId) crossDocFindings.delete(k);
        return { count: 0 };
      }),
      create: vi.fn(async ({ data }: { data: { analysisId: string; kind: string } }) => {
        const row = { id: nid("cdf"), analysisId: data.analysisId, kind: data.kind };
        crossDocFindings.set(row.id, row);
        return row;
      }),
      findMany: vi.fn(async ({ where }: { where: { analysisId: string } }) =>
        [...crossDocFindings.values()].filter((r) => r.analysisId === where.analysisId),
      ),
    },
    // Epic #912 (#916) — requirement-grounded path probes for a code graph
    // (absent ⇒ requirement-grounded mode) and resolves the document set.
    codeGraph: {
      findFirst: vi.fn(async () => (codeGraphExists ? { id: "cg-1" } : null)),
    },
    // Issue #773 — the agentic code agent's `search_code_graph` tool runs against
    // this. A "clean" agentic run is one whose searches actually WORK, so the
    // fixture has to be able to answer one: a run that never retrieves anything is
    // (correctly) reported as `code-retrieval-degraded`.
    codeSymbol: {
      findMany: vi.fn(async () => [
        {
          qualifiedName: "AuthService.resetPassword",
          kind: "method",
          filePath: "server/src/auth/auth-service.ts",
          startLine: 10,
          endLine: 42,
          language: "typescript",
        },
      ]),
      findFirst: vi.fn(async () => null),
    },
    document: {
      findMany: vi.fn(async () => uploadedDocs.map((id) => ({ id }))),
      // Issue #733 — repo-source detection: a `connector:repo:*` document exists
      // only when the test toggles `repoSourceExists`.
      findFirst: vi.fn(async ({ where }: { where: { filename?: { startsWith?: string } } }) => {
        const wantsRepoSource = where.filename?.startsWith === "connector:repo:";
        if (wantsRepoSource) return repoSourceExists ? { id: "repo-doc-1" } : null;
        return null;
      }),
    },
    repoConnection: {
      findMany: vi.fn(async () => repoConnectors),
    },
    approvalRequest: {
      create: vi.fn(async ({ data }: { data: Partial<ApprovalRow> }) => {
        const row: ApprovalRow = {
          id: nid("ap"),
          analysisId: data.analysisId!,
          type: data.type!,
          itemId: data.itemId!,
          status: data.status ?? "pending",
          reviewerId: null,
          reviewNote: null,
          createdAt: new Date(),
          reviewedAt: null,
        };
        approvalRequests.set(row.id, row);
        return row;
      }),
      findMany: vi.fn(async ({ where }: { where: { analysisId: string; status?: string } }) =>
        [...approvalRequests.values()].filter(
          (r) => r.analysisId === where.analysisId && (!where.status || r.status === where.status),
        ),
      ),
      count: vi.fn(
        async ({ where }: { where: { analysisId: string; status?: string } }) =>
          [...approvalRequests.values()].filter(
            (r) =>
              r.analysisId === where.analysisId && (!where.status || r.status === where.status),
          ).length,
      ),
    },
  },
}));

vi.mock("../src/lib/audit/audit-service.js", () => ({
  audit: vi.fn(),
  getAuditService: vi.fn(),
}));

import type { AIProvider, ChatMessage, ChatResponse } from "../src/lib/ai/types.js";
import { runAgent } from "../src/lib/analysis/agent-runner.js";
import { persistAgentResult } from "../src/lib/analysis/analysis-service.js";
import { AnalysisOrchestrator } from "../src/lib/analysis/orchestrator.js";
import { RETRIEVAL_QUERIES } from "../src/lib/analysis/retrieval.js";
import { __resetConfigSingleton } from "../src/lib/config/config-service.js";
import { genericFailureMessage } from "../src/lib/socket/job-events.js";
import type { KnowledgeService } from "../src/lib/rag/knowledge-service.js";
import { isAnalysisDegraded, type DbTableInfo } from "@metis/shared";

/**
 * #750 — a no-op knowledge service so the agentic code path can assemble its
 * tools without constructing the real (LanceDB-backed) singleton. The stub is
 * never invoked: the offline provider returns a final answer on turn 1, so no
 * tool ever executes.
 */
const stubKnowledge = (): KnowledgeService =>
  ({ search: async () => [] }) as unknown as KnowledgeService;

interface FakeIO {
  events: Array<{ room: string; event: string; data: unknown }>;
  to(room: string): { emit(event: string, data: unknown): void };
}

const makeIO = (): FakeIO => {
  const events: FakeIO["events"] = [];
  return {
    events,
    to(room: string) {
      return {
        emit(event: string, data: unknown) {
          events.push({ room, event, data });
        },
      };
    },
  };
};

const stubResponse = (content: string): ChatResponse => ({
  content,
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  model: "stub",
  provider: "offline-stub",
});

const buildAgentJson = (agentKey: string, requirements?: Array<{ id: string; text: string }>) =>
  JSON.stringify({
    agentKey,
    summary: `summary from ${agentKey}`,
    findings: [
      {
        category: "architecture",
        severity: "medium",
        title: `${agentKey} title`,
        body: `${agentKey} body`,
        tags: ["t"],
        citations: [{ documentId: "doc-1234567890", chunkIndex: 0 }],
      },
    ],
    notes: [],
    // #750 — the document specialist now emits `requirements` in its normal
    // structured output. Only injected when the test opts in via `docRequirements`.
    ...(requirements ? { requirements } : {}),
  });

/**
 * #734 — a code-agent response whose findings carry code citations. Used to
 * prove the orchestrator grounds them: a retrieved `filePath` survives, a
 * fabricated one is dropped, and document citations pass through.
 */
const buildCodeAgentJson = (citations: unknown[], verdict?: string) =>
  JSON.stringify({
    agentKey: "code",
    summary: "summary from code",
    findings: [
      {
        requirementId: "REQ-001",
        // #19 — a CLEAN run verifies its requirement; with no verdict the page
        // (and the run's health report) shows it `could-not-verify`.
        ...(verdict ? { verdict } : {}),
        category: "architecture",
        severity: "medium",
        title: "code title",
        body: "code body",
        tags: ["t"],
        citations,
      },
    ],
    notes: [],
  });

const buildSynthesisJson = () =>
  JSON.stringify({
    summary: "merged",
    requirements: [
      {
        type: "feature",
        title: "Implement",
        body: "Body",
        priority: "high",
        labels: ["x"],
        evidenceFindingIndexes: [0],
      },
    ],
  });

function makeProvider(opts: {
  failAgent?: string;
  /** Fail EVERY specialist agent (document/code/database/web) with this message. */
  failAllAgents?: string;
  delayMs?: number;
  abortDuringFirst?: AbortController;
  /** Epic #203 (#221) — cross-doc detector replies. */
  nliReply?: string;
  completenessReply?: string;
  consistencyReply?: string;
  /**
   * #750 — requirements the DOCUMENT agent emits in its structured output.
   * When set, the doc agent yields these so `detectAgentMode` can route the
   * code agent into agentic / requirement-grounded mode.
   */
  docRequirements?: Array<{ id: string; text: string }>;
  /**
   * #734 — when set, the CODE agent (Winston) returns a finding carrying these
   * citations (raw, pre-grounding). Lets a test drive a real code-agent run and
   * assert on the grounded, persisted citations.
   */
  codeFindingCitations?: unknown[];
  /**
   * #734 — when set, the agentic CODE agent first emits a `search_code_symbols`
   * tool call, then (after the loop feeds the tool result back) emits findings
   * citing `codeFindingCitations`. Drives the "file surfaced ONLY by a search
   * tool, never read" grounding path end-to-end.
   */
  codeAgentSearchThenCite?: { toolCall: object; citations: unknown[] };
  /**
   * #763 — when set, the agentic CODE agent emits ONE finding whose title is
   * keyed on the per-connector repo label the multi-repo loop injects into the
   * prompt (`… [repo: <label>]`). Lets a 2-connector run produce two DISTINCT
   * findings, so the test can assert BOTH survive persistence (they don't on
   * `main`: connector 2's replace-delete drops connector 1's `code` row).
   */
  codeFindingPerRepo?: boolean;
  /**
   * P0 #769 — full control of what the CODE persona (Winston) returns on each
   * call, so a test can drive the REAL agent loop to turn/token exhaustion (a
   * stub that keeps emitting tool calls) or answer in prose. `call` is 1-based
   * per code-agent call; `messages` is the live conversation.
   */
  codeAgentScript?: (ctx: { messages: ChatMessage[]; call: number }) => string;
}): AIProvider {
  const callOrder: string[] = [];
  // #750 — every system message the provider is handed, so tests can assert on
  // observable behaviour (which mode's prompt was built) instead of poking a
  // private method. The agentic loop's system prompt reaches us via chatOpts too.
  const systemMessages: string[] = [];
  // #735 — every user-role message the provider is handed, so tests can assert
  // the affected-code block reached the executing code-agent prompt.
  const userMessages: string[] = [];
  // #769 — how many calls the CODE persona has taken (drives `codeAgentScript`).
  let codeCalls = 0;
  const provider = {
    key: "offline-stub" as const,
    model: "stub",
    offline: true,
    async chat(
      messages: ChatMessage[],
      chatOpts?: { signal?: AbortSignal; systemMessage?: string },
    ): Promise<ChatResponse> {
      // Detect which persona is on stage by reading the system message.
      // System message can be passed via opts OR as a leading system-role
      // message (the cross-doc detectors use the latter).
      const sysMsg = messages.find((m) => m.role === "system")?.content;
      const sys = chatOpts?.systemMessage ?? sysMsg ?? messages[0]?.content ?? "";
      const sysStr = typeof sys === "string" ? sys : "";
      systemMessages.push(sysStr);
      for (const m of messages) {
        if (m.role === "user" && typeof m.content === "string") userMessages.push(m.content);
      }

      // Epic #203 (#221) — cross-doc detection passes. Keyed off the detector
      // system prompts so the pipeline test exercises real detection output.
      if (sysStr.includes("Natural Language Inference")) {
        return stubResponse(opts.nliReply ?? '{"verdicts":[]}');
      }
      if (sysStr.includes("auditing a set of requirement documents")) {
        return stubResponse(opts.completenessReply ?? '{"gaps":[]}');
      }
      if (sysStr.includes("cross-document consistency check")) {
        return stubResponse(opts.consistencyReply ?? "## Summary\nOK\n\n## Contradictions\n- none");
      }

      let detected = "synthesis";
      if (sysStr.includes("Mary")) detected = "document";
      else if (sysStr.includes("Winston")) detected = "code";
      else if (sysStr.includes("Sally")) detected = "database";
      else if (sysStr.includes("Quinn")) detected = "web";
      else if (sysStr.includes("reviewer/synthesis")) detected = "synthesis";

      callOrder.push(detected);
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (opts.abortDuringFirst && callOrder.length === 1) {
        opts.abortDuringFirst.abort();
      }
      if (chatOpts?.signal?.aborted) {
        const e = new Error("aborted");
        e.name = "AbortError";
        throw e;
      }
      if (opts.failAllAgents && detected !== "synthesis") {
        throw new Error(opts.failAllAgents);
      }
      if (opts.failAgent && opts.failAgent === detected) {
        throw new Error(`forced failure for ${detected}`);
      }
      if (detected === "synthesis") return stubResponse(buildSynthesisJson());
      if (detected === "document")
        return stubResponse(buildAgentJson(detected, opts.docRequirements));
      // #769 — scripted code persona: drives the real loop to exhaustion / prose.
      if (detected === "code" && opts.codeAgentScript) {
        codeCalls += 1;
        return stubResponse(opts.codeAgentScript({ messages, call: codeCalls }));
      }
      // #763 — emit a per-connector code finding keyed on the repo label the
      // multi-repo loop injects into the project name (`… [repo: <label>]`).
      if (detected === "code" && opts.codeFindingPerRepo) {
        const joined = messages
          .map((m) => (typeof m.content === "string" ? m.content : ""))
          .join("\n");
        const repo = joined.match(/\[repo:\s*([^\]]+)\]/)?.[1]?.trim() ?? "unknown";
        return stubResponse(
          JSON.stringify({
            agentKey: "code",
            summary: `code summary for ${repo}`,
            findings: [
              {
                category: "architecture",
                severity: "medium",
                title: `code finding for ${repo}`,
                body: `body for ${repo}`,
                tags: [],
                citations: [],
              },
            ],
            notes: [],
          }),
        );
      }
      // #734 — the agentic code agent first calls search_code_symbols, then (once
      // the loop feeds the tool result back) emits its findings.
      if (detected === "code" && opts.codeAgentSearchThenCite) {
        const sawToolResult = messages.some(
          (m) => typeof m.content === "string" && m.content.includes("Tool result for"),
        );
        return stubResponse(
          sawToolResult
            ? buildCodeAgentJson(opts.codeAgentSearchThenCite.citations)
            : JSON.stringify(opts.codeAgentSearchThenCite.toolCall),
        );
      }
      // #734 — the code agent emits citations to be grounded when the test asks.
      if (detected === "code" && opts.codeFindingCitations)
        return stubResponse(buildCodeAgentJson(opts.codeFindingCitations));
      return stubResponse(buildAgentJson(detected));
    },
    async *stream() {
      yield { type: "done" } as const;
    },
    async embed() {
      return { vectors: [], dimension: 0, model: "stub" };
    },
    async models() {
      return ["stub"];
    },
    async ping() {
      return true;
    },
  };
  // #750 — expose the captured system messages for mode-detection assertions.
  (provider as unknown as { __systemMessages: string[] }).__systemMessages = systemMessages;
  // #735 — expose the captured user messages for prompt-content assertions.
  (provider as unknown as { __userMessages: string[] }).__userMessages = userMessages;
  return provider as unknown as AIProvider;
}

/** #750 — the system messages a `makeProvider` provider has been handed. */
const systemMessagesOf = (provider: AIProvider): string[] =>
  (provider as unknown as { __systemMessages: string[] }).__systemMessages;

/** #735 — the user messages a `makeProvider` provider has been handed. */
const userMessagesOf = (provider: AIProvider): string[] =>
  (provider as unknown as { __userMessages: string[] }).__userMessages;

beforeEach(() => {
  projects.clear();
  analyses.clear();
  agentResults.clear();
  requirements.clear();
  approvalRequests.clear();
  id = 0;
  codeGraphExists = false;
  uploadedDocs = [];
  repoSourceExists = false;
  repoConnectors = [];
  projects.set("proj-abcdefghij", {
    id: "proj-abcdefghij",
    name: "Acme",
    description: "monolith with billing",
    status: "active",
    deletedAt: null,
  });
});

afterEach(() => {
  vi.clearAllMocks();
  // #734 — some tests opt into fused code retrieval; never let the flag leak
  // into the flag-off tests (which assert the searcher is untouched).
  delete process.env.ANALYSIS_FUSED_CODE_RETRIEVAL;
  __resetConfigSingleton();
});

describe("AnalysisOrchestrator.start", () => {
  it("runs all four specialists in parallel + synthesis and persists results", async () => {
    const io = makeIO();
    const provider = makeProvider({});
    const orch = new AnalysisOrchestrator({
      provider,
      io: io as unknown as import("../src/lib/socket/server.js").MetisIOServer,
      retrieve: async () => [
        {
          documentId: "doc-1234567890",
          chunkIndex: 0,
          filename: "spec.md",
          text: "context",
          score: 0.8,
        },
      ],
    });
    const { id: analysisId } = await orch.start({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
    });

    // Drain any pending microtasks until the analysis settles.
    for (let i = 0; i < 200 && analyses.get(analysisId)!.status === "running"; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const final = analyses.get(analysisId)!;
    expect(final.status).toBe("completed");
    expect(final.totalTokens).toBeGreaterThan(0);

    // Five AgentResult rows: 4 specialists + 1 synthesis.
    const rows = [...agentResults.values()].filter((a) => a.analysisId === analysisId);
    const keys = rows.map((r) => r.agentKey).sort();
    expect(keys).toEqual(["code", "database", "document", "synthesis", "web"]);

    // Each specialist persisted one finding; synthesis persisted one requirement.
    const findings = rows.filter((r) => r.agentKey !== "synthesis").flatMap((r) => r.findings);
    expect(findings).toHaveLength(4);
    expect([...requirements.values()].length).toBe(1);

    // Socket events: started + completed for each specialist + synthesis,
    // ending with analysis:completed.
    const evtTypes = io.events.map((e) => `${e.event}/${(e.data as { type?: string }).type ?? ""}`);
    expect(evtTypes.filter((t) => t.startsWith("analysis:agent/started"))).toHaveLength(5);
    expect(evtTypes.filter((t) => t.startsWith("analysis:agent/completed"))).toHaveLength(5);
    expect(evtTypes).toContain("analysis:completed/");
  });

  it("runs cross-doc detection post-synthesis and persists findings (#203/#221)", async () => {
    const io = makeIO();
    const provider = makeProvider({
      nliReply: JSON.stringify({
        verdicts: [
          {
            premise: "Payments settle within 24 hours.",
            hypothesis: "Payments settle in 3 business days.",
            label: "contradiction",
            evidenceIds: [],
            scope: "pairwise",
          },
        ],
      }),
      completenessReply: JSON.stringify({
        gaps: [
          { kind: "missing-nfr", title: "No availability NFR", rationale: "No uptime target." },
        ],
      }),
    });
    const orch = new AnalysisOrchestrator({
      provider,
      io: io as unknown as import("../src/lib/socket/server.js").MetisIOServer,
      retrieve: async () => [
        {
          documentId: "doc-1234567890",
          chunkIndex: 0,
          filename: "spec.md",
          text: "context",
          score: 0.8,
        },
      ],
    });
    const { id: analysisId } = await orch.start({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
    });
    for (let i = 0; i < 200 && analyses.get(analysisId)!.status === "running"; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(analyses.get(analysisId)!.status).toBe("completed");

    // Cross-doc findings were persisted (contradiction + completeness gap).
    const cdf = [...crossDocFindings.values()].filter((r) => r.analysisId === analysisId);
    expect(cdf.length).toBeGreaterThanOrEqual(2);
    expect(cdf.some((r) => r.kind === "contradiction")).toBe(true);
    expect(cdf.some((r) => r.kind === "missing-nfr")).toBe(true);

    // Requirements were still persisted (detection runs BEFORE persistRequirements).
    expect([...requirements.values()].length).toBe(1);
  });

  it("never fails the analysis when cross-doc detection yields no parseable output", async () => {
    const io = makeIO();
    // Default detector replies are empty/none — emulates an offline provider.
    const provider = makeProvider({});
    const orch = new AnalysisOrchestrator({
      provider,
      io: io as unknown as import("../src/lib/socket/server.js").MetisIOServer,
      retrieve: async () => [
        { documentId: "doc-1", chunkIndex: 0, filename: "s.md", text: "c", score: 0.5 },
      ],
    });
    const { id: analysisId } = await orch.start({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
    });
    for (let i = 0; i < 200 && analyses.get(analysisId)!.status === "running"; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(analyses.get(analysisId)!.status).toBe("completed");
    expect([...crossDocFindings.values()].filter((r) => r.analysisId === analysisId)).toHaveLength(
      0,
    );
  });

  it("persists all specialist findings even when synthesis falls back to deterministic merge", async () => {
    const provider = makeProvider({ failAgent: "synthesis" });
    const io = makeIO();
    const orch = new AnalysisOrchestrator({
      provider,
      io: io as unknown as import("../src/lib/socket/server.js").MetisIOServer,
      retrieve: async () => [],
    });
    const { id: analysisId } = await orch.start({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
    });
    for (let i = 0; i < 200 && analyses.get(analysisId)!.status === "running"; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(analyses.get(analysisId)!.status).toBe("completed");
    const specialistRows = [...agentResults.values()].filter(
      (a) => a.analysisId === analysisId && a.agentKey !== "synthesis",
    );
    expect(specialistRows).toHaveLength(4);
    expect(specialistRows.every((r) => r.findings.length > 0)).toBe(true);
    // Synthesis should have produced at least one fallback requirement.
    expect([...requirements.values()].length).toBeGreaterThan(0);
  });

  it("marks the analysis FAILED (not completed) when every specialist agent fails", async () => {
    const io = makeIO();
    // A bad-model-id 404 on every agent: the historical silent-green bug.
    const provider = makeProvider({
      failAllAgents: "404 not_found_error model: us.anthropic.claude-sonnet-4-6",
    });
    const orch = new AnalysisOrchestrator({
      provider,
      io: io as unknown as import("../src/lib/socket/server.js").MetisIOServer,
      retrieve: async () => [
        { documentId: "doc-1", chunkIndex: 0, filename: "s.md", text: "c", score: 0.5 },
      ],
    });
    const { id: analysisId } = await orch.start({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
    });
    for (let i = 0; i < 400 && analyses.get(analysisId)!.status === "running"; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const final = analyses.get(analysisId)!;
    // Honesty: an all-agents-failed run must NOT report completed.
    expect(final.status).toBe("failed");
    // The first agent error is surfaced on the persisted row (server-side only).
    expect(final.errorMessage).toContain("404 not_found_error");
    expect(final.errorMessage).toContain("specialist agent");
    // No requirements were produced — synthesis never ran on zero findings.
    expect([...requirements.values()].length).toBe(0);
    // The client-facing failed event carries ONLY the generic message (#254).
    const failedEvents = io.events.filter((e) => e.event === "analysis:failed");
    expect(failedEvents).toHaveLength(1);
    expect((failedEvents[0]!.data as { errorMessage: string }).errorMessage).toBe(
      "Analysis failed",
    );
  });

  it("stays COMPLETED when only SOME specialists fail (partial success is fine)", async () => {
    const io = makeIO();
    // Only the document agent fails; the others succeed.
    const provider = makeProvider({ failAgent: "document" });
    const orch = new AnalysisOrchestrator({
      provider,
      io: io as unknown as import("../src/lib/socket/server.js").MetisIOServer,
      retrieve: async () => [
        { documentId: "doc-1", chunkIndex: 0, filename: "s.md", text: "c", score: 0.5 },
      ],
    });
    const { id: analysisId } = await orch.start({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
    });
    for (let i = 0; i < 400 && analyses.get(analysisId)!.status === "running"; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(analyses.get(analysisId)!.status).toBe("completed");
    // Synthesis still ran and produced requirements from the surviving agents.
    expect([...requirements.values()].length).toBeGreaterThan(0);
  });

  // Follow-up to the honesty gate (#anthropic-model-id-and-analysis-status):
  // the agentic / requirement-grounded code-agent branches catch their own
  // errors internally. The follow-up adds a `recordAgentOutcome` call in each
  // catch so a failing code agent is counted in `specialistFailed` instead of
  // being silently swallowed.
  //
  // #750 REFACTOR: these two tests previously set `codeGraphExists` and failed
  // the code agent but did NOT make the document agent emit requirements, so
  // `detectAgentMode` collapsed to single-shot and the code agent NEVER entered
  // the agentic / requirement-grounded branch — the `code:failed` row came from
  // the single-shot `runOneAgent` path, and the comment claiming otherwise was
  // wrong. Now that #750 wires requirement extraction, we supply
  // `docRequirements` so the document agent genuinely yields requirements and
  // the code agent actually enters the intended branch. We additionally assert
  // the mode's prompt was built (observable proof of the branch), then keep the
  // original catch-path assertions (exactly one `code:failed` row; run stays
  // `completed` on partial success).
  it("records an agentic code-agent failure in the catch path (partial success stays completed)", async () => {
    const io = makeIO();
    codeGraphExists = true; // requirements + code graph ⇒ AGENTIC mode
    uploadedDocs = ["doc-1"];
    // The document agent succeeds AND emits requirements (#750); only the code
    // persona (Winston) fails — this is what genuinely routes it into agentic.
    const provider = makeProvider({
      failAgent: "code",
      docRequirements: [{ id: "REQ-001", text: "Users can reset their password" }],
    });
    const orch = new AnalysisOrchestrator({
      provider,
      knowledge: stubKnowledge(),
      io: io as unknown as import("../src/lib/socket/server.js").MetisIOServer,
      retrieve: async () => [
        { documentId: "doc-1", chunkIndex: 0, filename: "s.md", text: "c", score: 0.5 },
      ],
    });
    const { id: analysisId } = await orch.start({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
      agentKeys: ["document", "code"],
    });
    for (let i = 0; i < 400 && analyses.get(analysisId)!.status === "running"; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const final = analyses.get(analysisId)!;
    const rows = [...agentResults.values()].filter((a) => a.analysisId === analysisId);
    const codeRows = rows.filter((r) => r.agentKey === "code");
    const doc = rows.find((r) => r.agentKey === "document");
    // Observable proof the code agent ENTERED agentic mode (not single-shot):
    // the agentic prompt was built and handed to the provider before it failed.
    expect(systemMessagesOf(provider).some((s) => s.includes("MODE: AGENTIC"))).toBe(true);
    // Exactly ONE code row, and it is `failed` — the agentic code agent threw,
    // persisted a single failed row, and re-threw into the orchestrator catch
    // (where the new `recordAgentOutcome` fires exactly once: no double-count).
    expect(codeRows).toHaveLength(1);
    expect(codeRows[0]!.status).toBe("failed");
    // The document agent succeeded (the recorded success the gate reads).
    expect(doc?.status).toBe("completed");
    // Partial success: ≥1 specialist succeeded, so the run stays completed even
    // though the code failure is now counted in `specialistFailed`. The new
    // recordAgentOutcome call must NOT wrongly flip a partial-success run.
    expect(final.status).toBe("completed");
    expect(final.errorMessage).toBeNull();
  });

  // Sibling of the agentic case for the OTHER patched catch block — the
  // requirement-grounded code-agent branch (requirements but no code graph).
  it("records a requirement-grounded code-agent failure in the catch path (partial success stays completed)", async () => {
    const io = makeIO();
    codeGraphExists = false; // requirements + no code graph ⇒ REQUIREMENT-GROUNDED
    uploadedDocs = ["doc-1"];
    const provider = makeProvider({
      failAgent: "code",
      docRequirements: [{ id: "REQ-001", text: "Users can reset their password" }],
    });
    const orch = new AnalysisOrchestrator({
      provider,
      io: io as unknown as import("../src/lib/socket/server.js").MetisIOServer,
      retrieve: async () => [
        { documentId: "doc-1", chunkIndex: 0, filename: "s.md", text: "c", score: 0.5 },
      ],
    });
    const { id: analysisId } = await orch.start({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
      agentKeys: ["document", "code"],
    });
    for (let i = 0; i < 400 && analyses.get(analysisId)!.status === "running"; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    // Observable proof the code agent ENTERED requirement-grounded mode.
    expect(systemMessagesOf(provider).some((s) => s.includes("MODE: REQUIREMENT-GROUNDED"))).toBe(
      true,
    );
    const final = analyses.get(analysisId)!;
    const rows = [...agentResults.values()].filter((a) => a.analysisId === analysisId);
    const codeRows = rows.filter((r) => r.agentKey === "code");
    const doc = rows.find((r) => r.agentKey === "document");
    expect(codeRows).toHaveLength(1);
    expect(codeRows[0]!.status).toBe("failed");
    expect(doc?.status).toBe("completed");
    expect(final.status).toBe("completed");
    expect(final.errorMessage).toBeNull();
  });

  // ── #763 — multi-repo code findings survive per connector ────────────────
  //
  // Regression for the silent multi-repo data-loss bug: the agentic `code`
  // agent runs once per connector with `agentKey:"code"`, and the default
  // `replace` persist deleted the prior connector's row (scoped by agentKey
  // only). Only the LAST connector's findings survived. The fix scopes the
  // replace-delete by `connectorId`, so EVERY connector's findings persist.
  //
  // Drives the real pipeline (orch.start → runPipeline → per-connector
  // runAgenticCodeAgent → persistAgentResult) and asserts observable persisted
  // state — no private method is stubbed. FAILS on `main` (one code row, one
  // finding); PASSES after the fix (two code rows, both findings).
  it("persists code findings from EVERY connector in a multi-repo run (#763)", async () => {
    const io = makeIO();
    codeGraphExists = true; // requirements + code graph ⇒ AGENTIC mode
    uploadedDocs = ["doc-1"];
    // Two connected repos — each yields a DISTINCT code finding keyed on its label.
    repoConnectors = [
      { id: "repo-backend", label: "backend" },
      { id: "repo-frontend", label: "frontend" },
    ];
    const provider = makeProvider({
      codeFindingPerRepo: true,
      docRequirements: [{ id: "REQ-001", text: "Users can reset their password" }],
    });
    const orch = new AnalysisOrchestrator({
      provider,
      knowledge: stubKnowledge(),
      io: io as unknown as import("../src/lib/socket/server.js").MetisIOServer,
      retrieve: async () => [
        { documentId: "doc-1", chunkIndex: 0, filename: "s.md", text: "c", score: 0.5 },
      ],
    });
    const { id: analysisId } = await orch.start({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
      agentKeys: ["document", "code"],
    });
    for (let i = 0; i < 400 && analyses.get(analysisId)!.status === "running"; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const final = analyses.get(analysisId)!;
    expect(final.status).toBe("completed");

    const rows = [...agentResults.values()].filter((a) => a.analysisId === analysisId);
    const codeRows = rows.filter((r) => r.agentKey === "code");
    // One persisted `code` AgentResult per connector — the last no longer
    // clobbers the first (they carry distinct connectorIds).
    expect(codeRows).toHaveLength(2);
    expect(codeRows.map((r) => r.connectorId).sort()).toEqual(["repo-backend", "repo-frontend"]);

    // BOTH connectors' code findings are present in the persisted snapshot.
    const codeTitles = codeRows.flatMap((r) => r.findings.map((f) => f.title)).sort();
    expect(codeTitles).toEqual(["code finding for backend", "code finding for frontend"]);
  });

  // ── #734 — code citations on findings ────────────────────────────────────
  //
  // These drive a REAL code-agent run (agentic + requirement-grounded) with the
  // fused code-graph seed enabled, have Winston emit a valid + a hallucinated +
  // a document citation, and assert on the grounded, PERSISTED citations. This
  // is observable output, not a stubbed private method (PR #751 pattern).

  /** A fused searcher/line-lookup that surfaces exactly `session.ts:10-42`. */
  const fusedCodeDepsFixture = () => ({
    searcher: {
      async search() {
        return [
          {
            symbolId: "sym-1",
            filePath: "server/src/auth/session.ts",
            name: "createSession",
            kind: "function",
            score: 0.9,
            snippet: "export function createSession() {}",
          },
        ];
      },
    },
    lineLookup: {
      async resolve(ids: string[]) {
        return new Map(
          ids.map((sid) => [
            sid,
            { filePath: "server/src/auth/session.ts", startLine: 10, endLine: 42 },
          ]),
        );
      },
    },
  });

  /** Parse the code agent's single finding's persisted citations. */
  const codeFindingCitationsOf = (analysisId: string): Array<Record<string, unknown>> => {
    const codeRow = [...agentResults.values()].find(
      (a) => a.analysisId === analysisId && a.agentKey === "code",
    );
    const evidence = codeRow?.findings[0]?.evidence;
    if (!evidence) return [];
    return (JSON.parse(evidence).citations ?? []) as Array<Record<string, unknown>>;
  };

  const rawCitationsForTest = () => [
    // grounded — session.ts IS in the fused seed
    { filePath: "server/src/auth/session.ts", startLine: 12, endLine: 20 },
    // hallucinated — never retrieved
    { filePath: "totally/made-up.ts", startLine: 1, endLine: 5 },
    // a document citation — must survive unchanged (regression)
    { documentId: "doc-1234567890", chunkIndex: 0 },
  ];

  it("grounds code citations on the AGENTIC path (drops the hallucinated file:line)", async () => {
    process.env.ANALYSIS_FUSED_CODE_RETRIEVAL = "true";
    __resetConfigSingleton();
    const io = makeIO();
    codeGraphExists = true; // requirements + code graph ⇒ AGENTIC
    uploadedDocs = ["doc-1"];
    const provider = makeProvider({
      docRequirements: [{ id: "REQ-001", text: "Users can reset their password" }],
      codeFindingCitations: rawCitationsForTest(),
    });
    const orch = new AnalysisOrchestrator({
      provider,
      knowledge: stubKnowledge(),
      fusedCode: fusedCodeDepsFixture(),
      io: io as unknown as import("../src/lib/socket/server.js").MetisIOServer,
      retrieve: async () => [
        { documentId: "doc-1", chunkIndex: 0, filename: "s.md", text: "c", score: 0.5 },
      ],
    });
    const { id: analysisId } = await orch.start({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
      agentKeys: ["document", "code"],
    });
    for (let i = 0; i < 400 && analyses.get(analysisId)!.status === "running"; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(systemMessagesOf(provider).some((s) => s.includes("MODE: AGENTIC"))).toBe(true);
    const citations = codeFindingCitationsOf(analysisId);
    // The grounded code citation survives, enriched with the symbol id.
    expect(citations).toContainEqual(
      expect.objectContaining({
        filePath: "server/src/auth/session.ts",
        startLine: 12,
        endLine: 20,
        symbolId: "sym-1",
      }),
    );
    // The hallucinated file:line is GONE.
    expect(citations.some((c) => c.filePath === "totally/made-up.ts")).toBe(false);
    // The document citation is untouched (regression).
    expect(citations).toContainEqual(
      expect.objectContaining({ documentId: "doc-1234567890", chunkIndex: 0 }),
    );
    delete process.env.ANALYSIS_FUSED_CODE_RETRIEVAL;
    __resetConfigSingleton();
  });

  it("grounds code citations on the REQUIREMENT-GROUNDED path", async () => {
    process.env.ANALYSIS_FUSED_CODE_RETRIEVAL = "true";
    __resetConfigSingleton();
    const io = makeIO();
    codeGraphExists = false; // requirements + no code graph ⇒ REQUIREMENT-GROUNDED
    uploadedDocs = ["doc-1"];
    const provider = makeProvider({
      docRequirements: [{ id: "REQ-001", text: "Users can reset their password" }],
      codeFindingCitations: rawCitationsForTest(),
    });
    const orch = new AnalysisOrchestrator({
      provider,
      // The requirement-grounded path calls knowledge.search per requirement;
      // return an empty hit set (fused symbols supply the code provenance).
      knowledge: { search: async () => ({ hits: [] }) } as unknown as KnowledgeService,
      fusedCode: fusedCodeDepsFixture(),
      io: io as unknown as import("../src/lib/socket/server.js").MetisIOServer,
      retrieve: async () => [
        { documentId: "doc-1", chunkIndex: 0, filename: "s.md", text: "c", score: 0.5 },
      ],
    });
    const { id: analysisId } = await orch.start({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
      agentKeys: ["document", "code"],
    });
    for (let i = 0; i < 400 && analyses.get(analysisId)!.status === "running"; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(systemMessagesOf(provider).some((s) => s.includes("MODE: REQUIREMENT-GROUNDED"))).toBe(
      true,
    );
    const citations = codeFindingCitationsOf(analysisId);
    expect(citations).toContainEqual(
      expect.objectContaining({ filePath: "server/src/auth/session.ts", startLine: 12 }),
    );
    expect(citations.some((c) => c.filePath === "totally/made-up.ts")).toBe(false);
    expect(citations).toContainEqual(
      expect.objectContaining({ documentId: "doc-1234567890", chunkIndex: 0 }),
    );
    delete process.env.ANALYSIS_FUSED_CODE_RETRIEVAL;
    __resetConfigSingleton();
  });

  it("keeps a code citation to a file surfaced ONLY by search_code_symbols (never read)", async () => {
    // Passive fused seed OFF so the ONLY provenance is the tool RESULT locator —
    // proving results (not just read_file_slice args) ground a citation. Fails
    // before the collectToolProvenance fix (the citation would be dropped).
    process.env.ANALYSIS_FUSED_CODE_RETRIEVAL = "false";
    __resetConfigSingleton();
    const io = makeIO();
    codeGraphExists = true; // requirements + code graph ⇒ AGENTIC
    uploadedDocs = ["doc-1"];
    const provider = makeProvider({
      docRequirements: [{ id: "REQ-001", text: "Users can reset their password" }],
      codeAgentSearchThenCite: {
        toolCall: { tool: "search_code_symbols", args: { query: "session" } },
        citations: [
          { filePath: "server/src/auth/session.ts", startLine: 12, endLine: 20 },
          { filePath: "totally/made-up.ts", startLine: 1, endLine: 5 },
        ],
      },
    });
    const orch = new AnalysisOrchestrator({
      provider,
      knowledge: stubKnowledge(),
      fusedCode: fusedCodeDepsFixture(),
      io: io as unknown as import("../src/lib/socket/server.js").MetisIOServer,
      retrieve: async () => [
        { documentId: "doc-1", chunkIndex: 0, filename: "s.md", text: "c", score: 0.5 },
      ],
    });
    const { id: analysisId } = await orch.start({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
      agentKeys: ["document", "code"],
    });
    for (let i = 0; i < 400 && analyses.get(analysisId)!.status === "running"; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(systemMessagesOf(provider).some((s) => s.includes("MODE: AGENTIC"))).toBe(true);
    const citations = codeFindingCitationsOf(analysisId);
    // Grounded purely by the search_code_symbols RESULT locator — kept.
    expect(citations).toContainEqual(
      expect.objectContaining({ filePath: "server/src/auth/session.ts", startLine: 12 }),
    );
    // The hallucinated file (in no provenance source) is still dropped.
    expect(citations.some((c) => c.filePath === "totally/made-up.ts")).toBe(false);
    delete process.env.ANALYSIS_FUSED_CODE_RETRIEVAL;
    __resetConfigSingleton();
  });

  // ── #735 — deterministic requirement→code mapping ────────────────────────
  //
  // Drive a REAL agentic / requirement-grounded code run with an injected
  // requirement→code mapper (no DB/graph) and assert the affected-code block
  // reaches the EXECUTING code-agent prompt, is persisted, degrades cleanly with
  // no graph, and leaves plain runs untouched.

  /** A mapper that maps every candidate to one symbol in `invoice.ts`. */
  const affectedCodeDepsFixture = () => ({
    mapRequirement: async () => [
      {
        codeSymbolId: "sym-9",
        filePath: "server/src/billing/invoice.ts",
        qualifiedName: "InvoiceService.charge",
        startLine: 20,
        endLine: 40,
        confidence: 0.9,
      },
    ],
    // Empty graph ⇒ no blast radius (direct mapper hits only).
    dataSourceFor: () =>
      ({
        getSymbol: async () => null,
        getEdgesFrom: async () => [],
        getEdgesTo: async () => [],
        getSymbolsByFile: async () => [],
        getSymbolsByIds: async () => [],
      }) as unknown as import("../src/lib/code-graph/query-service.js").CodeGraphDataSource,
  });

  // ── P0 #769 — the agentic loop must never discard its investigation ───────
  //
  // These drive the REAL loop (orch.start ⇒ runPipeline ⇒ runAgentLoop) with a
  // provider that keeps emitting tool calls until the turn cap — exactly what
  // the live 40,872-token run did. Before #769 the loop's prose fallback hit
  // `extractJsonObject`, the code agent was marked `failed`, and every finding
  // was lost. Nothing here stubs a private method.

  /** The persisted capability record (#733) for a run. */
  const capabilityOf = (analysisId: string) => {
    const raw = analyses.get(analysisId)?.metadata;
    return raw
      ? (JSON.parse(raw).capability as import("@metis/shared").AnalysisCapability | undefined)
      : undefined;
  };
  /** The persisted code-agent row for a run. */
  const codeRowOf = (analysisId: string) =>
    [...agentResults.values()].find((a) => a.analysisId === analysisId && a.agentKey === "code");

  const SEARCH_TOOL_CALL = JSON.stringify({
    tool: "search_code_symbols",
    args: { query: "password reset" },
  });
  const askedForFinalJson = (messages: ChatMessage[]): boolean =>
    messages.some((m) => typeof m.content === "string" && m.content.includes("STOP INVESTIGATING"));

  /** Run an agentic analysis with a scripted code persona and a 3-turn cap. */
  const runAgenticWith = async (
    codeAgentScript: (ctx: { messages: ChatMessage[]; call: number }) => string,
  ) => {
    process.env.ANALYSIS_FUSED_CODE_RETRIEVAL = "true";
    // #769 — the loop's turn cap is now an operator-tunable key; a low cap keeps
    // this test fast AND exercises the knob.
    process.env.ANALYSIS_AGENTIC_MAX_TURNS = "3";
    __resetConfigSingleton();
    codeGraphExists = true; // requirements + code graph ⇒ AGENTIC
    uploadedDocs = ["doc-1"];
    const provider = makeProvider({
      docRequirements: [{ id: "REQ-001", text: "Users can reset their password" }],
      codeAgentScript,
    });
    const orch = new AnalysisOrchestrator({
      provider,
      knowledge: stubKnowledge(),
      fusedCode: fusedCodeDepsFixture(),
      io: makeIO() as unknown as import("../src/lib/socket/server.js").MetisIOServer,
      retrieve: async () => [
        { documentId: "doc-1", chunkIndex: 0, filename: "s.md", text: "c", score: 0.5 },
      ],
    });
    const { id: analysisId } = await orch.start({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
      agentKeys: ["document", "code"],
    });
    for (let i = 0; i < 600 && analyses.get(analysisId)!.status === "running"; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    delete process.env.ANALYSIS_AGENTIC_MAX_TURNS;
    delete process.env.ANALYSIS_FUSED_CODE_RETRIEVAL;
    __resetConfigSingleton();
    return { analysisId, provider };
  };

  it("#769 salvages a TURN-CAP-exhausted agentic run into real findings (fails on main)", async () => {
    // Winston never stops calling tools — the loop can only end by exhausting
    // its turn cap. The bounded final-answer call then serializes the work.
    const { analysisId, provider } = await runAgenticWith(({ messages }) =>
      askedForFinalJson(messages)
        ? buildCodeAgentJson([
            { filePath: "server/src/auth/session.ts", startLine: 12, endLine: 20 },
          ])
        : SEARCH_TOOL_CALL,
    );

    expect(systemMessagesOf(provider).some((s) => s.includes("MODE: AGENTIC"))).toBe(true);
    const code = codeRowOf(analysisId)!;
    // On main: status "failed", errorMessage "Model response did not contain a
    // JSON object", zero findings.
    expect(code.status).toBe("completed");
    expect(code.errorMessage).toBeNull();
    expect(code.findings).toHaveLength(1);
    // The salvaged finding still went through #734 code-citation grounding.
    const citations = codeFindingCitationsOf(analysisId);
    expect(citations).toContainEqual(
      expect.objectContaining({ filePath: "server/src/auth/session.ts" }),
    );
    // The run recovered fully, so it claims no code-agent degradation.
    const cap = capabilityOf(analysisId);
    expect(cap?.reasons).not.toContain("code-agent-degraded");
    expect(cap?.reasons).not.toContain("code-agent-failed");
    expect(analyses.get(analysisId)!.status).toBe("completed");
  });

  it("#769 retries once with a JSON-only instruction when the model answers in PROSE", async () => {
    const seen: string[] = [];
    const { analysisId } = await runAgenticWith(({ messages }) => {
      if (askedForFinalJson(messages)) {
        seen.push("retry");
        return buildCodeAgentJson([{ documentId: "doc-1234567890", chunkIndex: 0 }]);
      }
      seen.push("prose");
      return "I looked at the auth module and it seems fine, broadly speaking.";
    });
    // One prose answer, then EXACTLY one JSON-only retry — bounded, not a loop.
    expect(seen).toEqual(["prose", "retry"]);
    const code = codeRowOf(analysisId)!;
    expect(code.status).toBe("completed");
    expect(code.findings).toHaveLength(1);
    expect(capabilityOf(analysisId)?.reasons).not.toContain("code-agent-degraded");
  });

  it("#769 degrades with a recorded reason when the retry ALSO fails to emit JSON", async () => {
    const { analysisId } = await runAgenticWith(({ messages }) =>
      askedForFinalJson(messages) ? "Sorry, I still cannot produce that." : SEARCH_TOOL_CALL,
    );

    const code = codeRowOf(analysisId)!;
    // The agent is NOT hard-failed — its (empty) result is persisted with a note.
    expect(code.status).toBe("completed");
    const output = JSON.parse(code.output!);
    expect(output.summary).toContain("Code analysis degraded");
    expect(output.notes.join(" ")).toContain("#769");
    // The run does NOT silently claim a clean agentic pass (#770 mechanism).
    const cap = capabilityOf(analysisId)!;
    expect(cap.reasons).toContain("code-agent-degraded");
    expect(isAnalysisDegraded(cap)).toBe(true);
    expect(analyses.get(analysisId)!.status).toBe("completed");
  });

  it("#769 persists the findings it CAN salvage from a schema-invalid answer", async () => {
    // The retry answers with a JSON object that fails `agentOutputSchema` (no
    // `summary`) but carries one perfectly good finding. Before #769 the whole
    // object — and the whole investigation — was thrown away.
    const { analysisId } = await runAgenticWith(({ messages }) =>
      askedForFinalJson(messages)
        ? JSON.stringify({
            agentKey: "code",
            findings: [
              {
                category: "security",
                severity: "high",
                title: "Password reset token never expires",
                body: "session.ts issues a token with no TTL.",
                tags: [],
                citations: [{ filePath: "server/src/auth/session.ts", startLine: 12, endLine: 20 }],
              },
              // #1222 — was `category: "bogus-category"`. An out-of-enum
              // category no longer fails validation (it coerces to `other`), so
              // that fixture would now be salvaged and this test would assert
              // the coercion instead of #769's drop-the-malformed property. A
              // missing `title` is unambiguously malformed.
              { category: "security", severity: "high", body: "junk" },
            ],
          })
        : SEARCH_TOOL_CALL,
    );

    const code = codeRowOf(analysisId)!;
    expect(code.status).toBe("completed");
    // The valid finding survived; the malformed one was dropped.
    expect(code.findings).toHaveLength(1);
    expect(code.findings[0]!.title).toBe("Password reset token never expires");
    expect(capabilityOf(analysisId)?.reasons).toContain("code-agent-degraded");
  });

  it("#770 records `code-agent-failed` when the code agent dies outright", async () => {
    codeGraphExists = true;
    uploadedDocs = ["doc-1"];
    const provider = makeProvider({
      failAgent: "code",
      docRequirements: [{ id: "REQ-001", text: "Users can reset their password" }],
    });
    const orch = new AnalysisOrchestrator({
      provider,
      knowledge: stubKnowledge(),
      io: makeIO() as unknown as import("../src/lib/socket/server.js").MetisIOServer,
      retrieve: async () => [
        { documentId: "doc-1", chunkIndex: 0, filename: "s.md", text: "c", score: 0.5 },
      ],
    });
    const { id: analysisId } = await orch.start({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
      agentKeys: ["document", "code"],
    });
    for (let i = 0; i < 400 && analyses.get(analysisId)!.status === "running"; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(codeRowOf(analysisId)!.status).toBe("failed");
    const cap = capabilityOf(analysisId)!;
    // On main this was `reasons: []` — a clean-looking, code-blind run (#770).
    expect(cap.codeAgentFailed).toBe(true);
    expect(cap.reasons).toContain("code-agent-failed");
    expect(isAnalysisDegraded(cap)).toBe(true);
  });

  it("#769/#770 a clean agentic run reports NEITHER code-agent reason (no regression)", async () => {
    repoSourceExists = true; // silence the unrelated source-not-ingested reason
    // #773 — a CLEAN agentic run is one that actually retrieved something: it runs a
    // working search, then answers. (A code agent that answers without retrieving
    // anything is a `code-retrieval-degraded` run by definition — its "not found"
    // claims are backed by nothing — and is now reported as one.)
    const { analysisId } = await runAgenticWith(({ messages }) =>
      messages.some((m) => typeof m.content === "string" && m.content.startsWith("Tool result for"))
        ? buildCodeAgentJson(
            [{ filePath: "server/src/auth/session.ts", startLine: 12, endLine: 20 }],
            "implemented",
          )
        : SEARCH_TOOL_CALL,
    );
    const code = codeRowOf(analysisId)!;
    expect(code.status).toBe("completed");
    const cap = capabilityOf(analysisId)!;
    expect(cap.codeAgentFailed).toBe(false);
    expect(cap.codeAgentDegraded).toBe(false);
    expect(cap.reasons).toEqual([]);
    expect(isAnalysisDegraded(cap)).toBe(false);
  });

  const twoRequirementsText = "Add a monthly invoice charge.\n\nAdd a refund endpoint.";

  it("#735 seeds the deterministic affected-code block into the EXECUTING agentic prompt + persists it", async () => {
    // Isolate: fused retrieval OFF so the ONLY code seed is the #735 block.
    process.env.ANALYSIS_FUSED_CODE_RETRIEVAL = "false";
    __resetConfigSingleton();
    const io = makeIO();
    codeGraphExists = true; // requirements + code graph ⇒ AGENTIC
    uploadedDocs = ["doc-1"];
    const provider = makeProvider({
      docRequirements: [{ id: "REQ-001", text: "Users can charge invoices" }],
    });
    const orch = new AnalysisOrchestrator({
      provider,
      knowledge: stubKnowledge(),
      affectedCode: affectedCodeDepsFixture(),
      io: io as unknown as import("../src/lib/socket/server.js").MetisIOServer,
      retrieve: async () => [
        { documentId: "doc-1", chunkIndex: 0, filename: "s.md", text: "c", score: 0.5 },
      ],
    });
    const { id: analysisId } = await orch.start({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
      agentKeys: ["document", "code"],
      extraInstructions: twoRequirementsText,
    });
    for (let i = 0; i < 400 && analyses.get(analysisId)!.status === "running"; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }

    // Proof the EXECUTING agentic prompt carried the deterministic block.
    expect(systemMessagesOf(provider).some((s) => s.includes("MODE: AGENTIC"))).toBe(true);
    const agenticPrompt = userMessagesOf(provider).find((u) => u.includes("BEGIN AFFECTED CODE"));
    expect(agenticPrompt).toBeDefined();
    expect(agenticPrompt).toContain("InvoiceService.charge");
    expect(agenticPrompt).toContain("server/src/billing/invoice.ts:20");
    // The system message advertises the deterministic-mapping rule.
    expect(systemMessagesOf(provider).some((s) => s.includes("DETERMINISTIC AFFECTED CODE"))).toBe(
      true,
    );

    // Two candidates parsed from the two paragraphs, persisted for the API/UI.
    const meta = JSON.parse(analyses.get(analysisId)!.metadata!) as {
      affectedCode?: { candidates: Array<{ id: string; symbols: unknown[] }> };
    };
    expect(meta.affectedCode?.candidates).toHaveLength(2);
    expect(meta.affectedCode?.candidates[0].id).toBe("NR-1");
    expect(meta.affectedCode?.candidates[0].symbols.length).toBeGreaterThan(0);

    delete process.env.ANALYSIS_FUSED_CODE_RETRIEVAL;
    __resetConfigSingleton();
  });

  it("#735 degrades cleanly with NO code graph (requirement-grounded, no fence, no persist)", async () => {
    process.env.ANALYSIS_FUSED_CODE_RETRIEVAL = "false";
    __resetConfigSingleton();
    const io = makeIO();
    codeGraphExists = false; // requirements + no graph ⇒ REQUIREMENT-GROUNDED
    uploadedDocs = ["doc-1"];
    const provider = makeProvider({
      docRequirements: [{ id: "REQ-001", text: "Users can charge invoices" }],
    });
    const orch = new AnalysisOrchestrator({
      provider,
      knowledge: { search: async () => ({ hits: [] }) } as unknown as KnowledgeService,
      // No graph ⇒ mapper returns nothing for every candidate.
      affectedCode: { mapRequirement: async () => [], dataSourceFor: () => undefined as never },
      io: io as unknown as import("../src/lib/socket/server.js").MetisIOServer,
      retrieve: async () => [
        { documentId: "doc-1", chunkIndex: 0, filename: "s.md", text: "c", score: 0.5 },
      ],
    });
    const { id: analysisId } = await orch.start({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
      agentKeys: ["document", "code"],
      extraInstructions: twoRequirementsText,
    });
    for (let i = 0; i < 400 && analyses.get(analysisId)!.status === "running"; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }

    // The run completes and reaches requirement-grounded mode WITHOUT a fence.
    expect(analyses.get(analysisId)!.status).toBe("completed");
    expect(systemMessagesOf(provider).some((s) => s.includes("MODE: REQUIREMENT-GROUNDED"))).toBe(
      true,
    );
    expect(userMessagesOf(provider).some((u) => u.includes("BEGIN AFFECTED CODE"))).toBe(false);
    // Nothing deterministic to show ⇒ no affectedCode blob persisted.
    const meta = JSON.parse(analyses.get(analysisId)!.metadata ?? "{}") as {
      affectedCode?: unknown;
    };
    expect(meta.affectedCode).toBeUndefined();

    delete process.env.ANALYSIS_FUSED_CODE_RETRIEVAL;
    __resetConfigSingleton();
  });

  it("#735 leaves a plain run (no new requirements) untouched — no fence, no blob", async () => {
    process.env.ANALYSIS_FUSED_CODE_RETRIEVAL = "false";
    __resetConfigSingleton();
    const io = makeIO();
    codeGraphExists = true;
    uploadedDocs = ["doc-1"];
    const provider = makeProvider({
      docRequirements: [{ id: "REQ-001", text: "Users can charge invoices" }],
    });
    const orch = new AnalysisOrchestrator({
      provider,
      knowledge: stubKnowledge(),
      affectedCode: affectedCodeDepsFixture(),
      io: io as unknown as import("../src/lib/socket/server.js").MetisIOServer,
      retrieve: async () => [
        { documentId: "doc-1", chunkIndex: 0, filename: "s.md", text: "c", score: 0.5 },
      ],
    });
    const { id: analysisId } = await orch.start({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
      agentKeys: ["document", "code"],
      // No extraInstructions ⇒ the deterministic mapping is a clean no-op.
    });
    for (let i = 0; i < 400 && analyses.get(analysisId)!.status === "running"; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(userMessagesOf(provider).some((u) => u.includes("BEGIN AFFECTED CODE"))).toBe(false);
    const meta = JSON.parse(analyses.get(analysisId)!.metadata ?? "{}") as {
      affectedCode?: unknown;
    };
    expect(meta.affectedCode).toBeUndefined();

    delete process.env.ANALYSIS_FUSED_CODE_RETRIEVAL;
    __resetConfigSingleton();
  });

  // ── #739 (Epic #727) — requirement escalation policy ──────────────────────
  // Drive a REAL agentic code run with the escalation policy ON and two
  // requirements of divergent difficulty. Prove the EXECUTING agentic path is
  // partitioned into a deep pass (the vague/high-impact requirement) and a
  // standard pass (the crisp one), and that the decision is persisted per
  // requirement — observable behaviour, not a stubbed private method.

  const escalationDocRequirements = [
    // Marker-dense one-liner (ambiguity 1.0) + a mapped symbol (impact) ⇒ deep.
    { id: "REQ-VAGUE", text: "Handle everything appropriately" },
    // Long, specific requirement (ambiguity 0) ⇒ below threshold ⇒ standard.
    { id: "REQ-CRISP", text: "The login footer must render the semantic version token z9x7q" },
  ];

  it("#739 routes only the high scorer to a deep pass and persists the decision", async () => {
    process.env.ANALYSIS_ESCALATION_POLICY = "true";
    // Isolate: fused OFF so the agentic prompt is driven purely by requirements.
    process.env.ANALYSIS_FUSED_CODE_RETRIEVAL = "false";
    __resetConfigSingleton();
    const io = makeIO();
    codeGraphExists = true; // requirements + code graph ⇒ AGENTIC
    uploadedDocs = ["doc-1"];
    const provider = makeProvider({ docRequirements: escalationDocRequirements });
    const orch = new AnalysisOrchestrator({
      provider,
      knowledge: stubKnowledge(),
      // The mapper gives every requirement one symbol ⇒ blast size 1 (impact
      // 0.125). Combined with ambiguity this pushes only REQ-VAGUE over 0.5.
      affectedCode: affectedCodeDepsFixture(),
      io: io as unknown as import("../src/lib/socket/server.js").MetisIOServer,
      retrieve: async () => [
        { documentId: "doc-1", chunkIndex: 0, filename: "s.md", text: "c", score: 0.5 },
      ],
    });
    const { id: analysisId } = await orch.start({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
      agentKeys: ["document", "code"],
    });
    for (let i = 0; i < 400 && analyses.get(analysisId)!.status === "running"; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }

    // The persisted escalation record routes the vague req deep, the crisp std.
    const meta = JSON.parse(analyses.get(analysisId)!.metadata!) as {
      escalation?: {
        enabled: boolean;
        threshold: number;
        requirements: Array<{ requirementId: string; depth: string; score: number }>;
      };
    };
    expect(meta.escalation?.enabled).toBe(true);
    const byId = Object.fromEntries(
      (meta.escalation?.requirements ?? []).map((r) => [r.requirementId, r]),
    );
    expect(byId["REQ-VAGUE"].depth).toBe("deep");
    expect(byId["REQ-CRISP"].depth).toBe("standard");
    expect(byId["REQ-VAGUE"].score).toBeGreaterThanOrEqual(meta.escalation!.threshold);

    // Proof the EXECUTING agentic path was partitioned into two focused passes:
    // the deep prompt lists ONLY the deep requirement, the standard prompt ONLY
    // the standard one (a single uniform pass would list both together).
    const reqPrompts = userMessagesOf(provider).filter((u) => u.includes("BEGIN REQUIREMENTS"));
    const deepPrompt = reqPrompts.find((u) => u.includes("[REQ-VAGUE]"));
    const standardPrompt = reqPrompts.find((u) => u.includes("[REQ-CRISP]"));
    expect(deepPrompt).toBeDefined();
    expect(deepPrompt).not.toContain("[REQ-CRISP]");
    expect(standardPrompt).toBeDefined();
    expect(standardPrompt).not.toContain("[REQ-VAGUE]");
    // Two distinct agentic passes ran (deep + standard), not one uniform pass.
    expect(deepPrompt).not.toBe(standardPrompt);

    delete process.env.ANALYSIS_ESCALATION_POLICY;
    delete process.env.ANALYSIS_FUSED_CODE_RETRIEVAL;
    __resetConfigSingleton();
  });

  it("#739 is a clean no-op when the policy is off — single uniform pass, no blob", async () => {
    // Flag unset (default OFF).
    process.env.ANALYSIS_FUSED_CODE_RETRIEVAL = "false";
    __resetConfigSingleton();
    const io = makeIO();
    codeGraphExists = true;
    uploadedDocs = ["doc-1"];
    const provider = makeProvider({ docRequirements: escalationDocRequirements });
    const orch = new AnalysisOrchestrator({
      provider,
      knowledge: stubKnowledge(),
      affectedCode: affectedCodeDepsFixture(),
      io: io as unknown as import("../src/lib/socket/server.js").MetisIOServer,
      retrieve: async () => [
        { documentId: "doc-1", chunkIndex: 0, filename: "s.md", text: "c", score: 0.5 },
      ],
    });
    const { id: analysisId } = await orch.start({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
      agentKeys: ["document", "code"],
    });
    for (let i = 0; i < 400 && analyses.get(analysisId)!.status === "running"; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }

    // No escalation blob persisted.
    const meta = JSON.parse(analyses.get(analysisId)!.metadata ?? "{}") as { escalation?: unknown };
    expect(meta.escalation).toBeUndefined();

    // Exactly ONE agentic requirements prompt, listing BOTH requirements together
    // (uniform depth — byte-identical to pre-#739 routing).
    const reqPrompts = userMessagesOf(provider).filter((u) => u.includes("BEGIN REQUIREMENTS"));
    expect(reqPrompts).toHaveLength(1);
    expect(reqPrompts[0]).toContain("[REQ-VAGUE]");
    expect(reqPrompts[0]).toContain("[REQ-CRISP]");

    delete process.env.ANALYSIS_FUSED_CODE_RETRIEVAL;
    __resetConfigSingleton();
  });

  it("marks the analysis cancelled when cancel() is called mid-flight", async () => {
    const provider = makeProvider({ delayMs: 30 });
    const io = makeIO();
    const orch = new AnalysisOrchestrator({
      provider,
      io: io as unknown as import("../src/lib/socket/server.js").MetisIOServer,
      retrieve: async () => [],
    });
    const { id: analysisId } = await orch.start({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
    });
    await new Promise((r) => setTimeout(r, 5));
    const cancelled = await orch.cancel(analysisId, "user-1234567890");
    expect(cancelled).toBe(true);
    for (let i = 0; i < 400 && analyses.get(analysisId)!.status === "running"; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(["cancelled", "failed"]).toContain(analyses.get(analysisId)!.status);
  });

  it("rejects requests for archived projects", async () => {
    projects.get("proj-abcdefghij")!.status = "archived";
    const orch = new AnalysisOrchestrator({
      provider: makeProvider({}),
      retrieve: async () => [],
    });
    await expect(
      orch.start({ projectId: "proj-abcdefghij", startedById: "user-1234567890" }),
    ).rejects.toThrow(/archived/);
  });

  it("rejects requests for missing projects", async () => {
    const orch = new AnalysisOrchestrator({
      provider: makeProvider({}),
      retrieve: async () => [],
    });
    await expect(
      orch.start({ projectId: "missing-id-12345", startedById: "user-1234567890" }),
    ).rejects.toThrow(/not found/);
  });
});

describe("AnalysisOrchestrator.regenerateAgent", () => {
  it("re-runs a single specialist + synthesis and replaces prior rows", async () => {
    const provider = makeProvider({});
    const orch = new AnalysisOrchestrator({
      provider,
      retrieve: async () => [],
    });
    const { id: analysisId } = await orch.start({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
    });
    for (let i = 0; i < 200 && analyses.get(analysisId)!.status === "running"; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const beforeCount = agentResults.size;
    expect(beforeCount).toBe(5);
    await orch.regenerateAgent({
      analysisId,
      agentKey: "document",
      actorId: "user-1234567890",
    });
    // Document + synthesis got replaced; total agentResults still 5.
    expect(agentResults.size).toBe(5);
  });
});

describe("AnalysisOrchestrator.regenerateAgent guards", () => {
  async function runToCompletion(orch: AnalysisOrchestrator) {
    const { id: analysisId } = await orch.start({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
    });
    for (let i = 0; i < 200 && analyses.get(analysisId)!.status === "running"; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    return analysisId;
  }

  it("refuses regenerate when the monthly token cap has been hit (H2)", async () => {
    const orch = new AnalysisOrchestrator({ provider: makeProvider({}), retrieve: async () => [] });
    const analysisId = await runToCompletion(orch);

    process.env.ANALYSIS_MONTHLY_TOKEN_CAP = "1";
    try {
      // Existing analysis usage > 1 token → cap exceeded.
      const { CostCapExceededError } = await import("../src/lib/analysis/cost-cap.js");
      await expect(
        orch.regenerateAgent({
          analysisId,
          agentKey: "document",
          actorId: "user-1234567890",
        }),
      ).rejects.toBeInstanceOf(CostCapExceededError);
    } finally {
      delete process.env.ANALYSIS_MONTHLY_TOKEN_CAP;
    }
  });

  it("refuses regenerate when the analysis status is still running (M1)", async () => {
    const orch = new AnalysisOrchestrator({ provider: makeProvider({}), retrieve: async () => [] });
    const analysisId = await runToCompletion(orch);
    // Force the row back to running to simulate a concurrent in-flight pipeline.
    analyses.get(analysisId)!.status = "running";
    const { AnalysisNotRegeneratableError } = await import("../src/lib/analysis/orchestrator.js");
    await expect(
      orch.regenerateAgent({
        analysisId,
        agentKey: "document",
        actorId: "user-1234567890",
      }),
    ).rejects.toBeInstanceOf(AnalysisNotRegeneratableError);
  });

  it("commits regenerate token totals via atomic increment (M1)", async () => {
    const orch = new AnalysisOrchestrator({ provider: makeProvider({}), retrieve: async () => [] });
    const analysisId = await runToCompletion(orch);
    const before = analyses.get(analysisId)!.totalTokens;
    expect(before).toBeGreaterThan(0);
    await orch.regenerateAgent({
      analysisId,
      agentKey: "document",
      actorId: "user-1234567890",
    });
    const after = analyses.get(analysisId)!.totalTokens;
    // Tokens grew by exactly the regenerate run delta — never reset to 0,
    // never lost, never clobbered.
    expect(after).toBeGreaterThan(before);
  });

  it("emits an analysis.regenerate audit row with tokensConsumed + decision (M3)", async () => {
    const orch = new AnalysisOrchestrator({ provider: makeProvider({}), retrieve: async () => [] });
    const analysisId = await runToCompletion(orch);
    const { audit } = await import("../src/lib/audit/audit-service.js");
    (audit as unknown as { mockClear: () => void }).mockClear();
    await orch.regenerateAgent({
      analysisId,
      agentKey: "document",
      actorId: "user-1234567890",
    });
    const calls = (audit as unknown as { mock: { calls: Array<unknown[]> } }).mock.calls;
    const regenerateRow = calls
      .map((c) => c[0] as { action?: string; metadata?: Record<string, unknown> })
      .find((c) => c.action === "analysis.regenerate");
    expect(regenerateRow).toBeDefined();
    expect(regenerateRow!.metadata).toMatchObject({
      agentKey: "document",
      decision: "completed",
    });
    expect(typeof regenerateRow!.metadata!.tokensConsumed).toBe("number");
    expect((regenerateRow!.metadata!.tokensConsumed as number) >= 0).toBe(true);
  });

  it("audits analysis.regenerate with decision=failed when the agent throws (M3)", async () => {
    const orch = new AnalysisOrchestrator({ provider: makeProvider({}), retrieve: async () => [] });
    const analysisId = await runToCompletion(orch);
    const { audit } = await import("../src/lib/audit/audit-service.js");
    (audit as unknown as { mockClear: () => void }).mockClear();

    // Swap in a provider that fails the document agent.
    (orch as unknown as { deps: { provider: AIProvider } }).deps.provider = makeProvider({
      failAgent: "document",
    });
    await orch.regenerateAgent({
      analysisId,
      agentKey: "document",
      actorId: "user-1234567890",
    });
    const calls = (audit as unknown as { mock: { calls: Array<unknown[]> } }).mock.calls;
    const regenerateRow = calls
      .map((c) => c[0] as { action?: string; metadata?: Record<string, unknown> })
      .find((c) => c.action === "analysis.regenerate");
    expect(regenerateRow).toBeDefined();
    expect(regenerateRow!.metadata).toMatchObject({ decision: "failed" });
    expect(analyses.get(analysisId)!.status).toBe("failed");
  });
});

describe("AnalysisOrchestrator misc branches", () => {
  it("cancel() returns false when no active run exists", async () => {
    const orch = new AnalysisOrchestrator({ provider: makeProvider({}), retrieve: async () => [] });
    const result = await orch.cancel("ana_unknown", "user-1234567890");
    expect(result).toBe(false);
  });

  it("isActive() reports false for unknown analyses", () => {
    const orch = new AnalysisOrchestrator({ provider: makeProvider({}), retrieve: async () => [] });
    expect(orch.isActive("ana_unknown")).toBe(false);
  });

  it("emits gracefully when the IO server's emit throws", async () => {
    const provider = makeProvider({});
    const ioBroken = {
      to() {
        return {
          emit() {
            throw new Error("socket dead");
          },
        };
      },
    };
    const orch = new AnalysisOrchestrator({
      provider,
      io: ioBroken as unknown as import("../src/lib/socket/server.js").MetisIOServer,
      retrieve: async () => [],
    });
    const { id: analysisId } = await orch.start({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
    });
    for (let i = 0; i < 200 && analyses.get(analysisId)!.status === "running"; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    // Pipeline still completed despite socket emit failures.
    expect(analyses.get(analysisId)!.status).toBe("completed");
  });

  // #254 — the `analysis:failed` (emitFailed) client payload broadcast on the
  // `analysis:{id}` room must carry ONLY the generic, user-safe message. The
  // room is joined by any authenticated socket via `subscribe:analysis` (no
  // per-run authz gate), so raw error detail must never reach it. Raw detail is
  // kept in server logs + the persisted analysis row only. Mirrors the
  // genericFailureMessage emit-layer guard in job-events.test.ts.
  it("emitFailed emits only the generic message — never the raw error (#254)", () => {
    const io = makeIO();
    const orch = new AnalysisOrchestrator({
      provider: makeProvider({}),
      io: io as unknown as import("../src/lib/socket/server.js").MetisIOServer,
      retrieve: async () => [],
    });

    const rawError =
      "ECONNREFUSED 10.0.3.4:5432 — prisma P2024 pool timeout in synthesizeFinalDocument";

    // Drive the private emit helper exactly as the pipeline catch block does:
    // route the client message through genericFailureMessage, keep raw out.
    (orch as unknown as { emitFailed(id: string, msg: string): void }).emitFailed(
      "ana_fail_254",
      genericFailureMessage("analysis"),
    );

    const failedEvents = io.events.filter((e) => e.event === "analysis:failed");
    expect(failedEvents).toHaveLength(1);
    const payload = failedEvents[0]!.data as { analysisId: string; errorMessage: string };
    expect(payload.analysisId).toBe("ana_fail_254");
    expect(payload.errorMessage).toBe("Analysis failed");
    // Regression guard: no fragment of a realistic raw error leaks to the client.
    expect(payload.errorMessage).not.toContain("ECONNREFUSED");
    expect(payload.errorMessage).not.toContain("P2024");
    expect(payload.errorMessage).not.toContain(rawError);
    expect(failedEvents[0]!.room).toBe("analysis:ana_fail_254");
  });

  it("retrieveContext uses the knowledge service when no override is provided", async () => {
    const provider = makeProvider({});
    const knowledge = {
      search: vi.fn(async () => ({
        hits: [
          {
            documentId: "doc-1234567890",
            position: 3,
            filename: "spec.md",
            text: "context",
            score: 0.9,
          },
        ],
        embeddingModel: "stub",
        elapsedMs: 1,
      })),
    };
    const orch = new AnalysisOrchestrator({
      provider,
      knowledge:
        knowledge as unknown as import("../src/lib/rag/knowledge-service.js").KnowledgeService,
    });
    const { id: analysisId } = await orch.start({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
    });
    for (let i = 0; i < 200 && analyses.get(analysisId)!.status === "running"; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(analyses.get(analysisId)!.status).toBe("completed");
    expect(knowledge.search).toHaveBeenCalled();
  });
});

describe("getOrchestrator", () => {
  it("throws when no deps are provided and no singleton exists", async () => {
    const { getOrchestrator, setOrchestratorForTests } =
      await import("../src/lib/analysis/orchestrator.js");
    setOrchestratorForTests(null);
    expect(() => getOrchestrator()).toThrow(/initialised/);
  });

  it("returns the cached singleton on subsequent calls", async () => {
    const { getOrchestrator, setOrchestratorForTests, AnalysisOrchestrator } =
      await import("../src/lib/analysis/orchestrator.js");
    setOrchestratorForTests(null);
    const first = getOrchestrator({ provider: makeProvider({}), retrieve: async () => [] });
    const second = getOrchestrator();
    expect(first).toBe(second);
    expect(first instanceof AnalysisOrchestrator).toBe(true);
    setOrchestratorForTests(null);
  });
});

/**
 * Records every specialist user-prompt so tests can assert that the free-text
 * `extraInstructions` (#905) actually reaches the agent prompt — wrapped in the
 * untrusted OPERATOR NOTES data boundary (i.e. via `escapeContext`, not raw).
 */
function makeCapturingProvider(): { provider: AIProvider; userPrompts: string[] } {
  const userPrompts: string[] = [];
  const provider = {
    key: "offline-stub" as const,
    model: "stub",
    offline: true,
    async chat(
      messages: ChatMessage[],
      chatOpts?: { signal?: AbortSignal; systemMessage?: string },
    ): Promise<ChatResponse> {
      const sys = chatOpts?.systemMessage ?? "";
      const userMsg = messages[0]?.content ?? "";
      userPrompts.push(userMsg);
      let detected = "synthesis";
      if (sys.includes("Mary")) detected = "document";
      else if (sys.includes("Winston")) detected = "code";
      else if (sys.includes("Sally")) detected = "database";
      else if (sys.includes("Quinn")) detected = "web";
      if (detected === "synthesis") return stubResponse(buildSynthesisJson());
      return stubResponse(buildAgentJson(detected));
    },
    async *stream() {
      yield { type: "done" } as const;
    },
    async embed() {
      return { vectors: [], dimension: 0, model: "stub" };
    },
    async models() {
      return ["stub"];
    },
    async ping() {
      return true;
    },
  };
  return { provider: provider as unknown as AIProvider, userPrompts };
}

describe("AnalysisOrchestrator extraInstructions plumbing (#905)", () => {
  async function drain(analysisId: string) {
    for (let i = 0; i < 200 && analyses.get(analysisId)!.status === "running"; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  it("persists extraInstructions into analysis metadata", async () => {
    const orch = new AnalysisOrchestrator({ provider: makeProvider({}), retrieve: async () => [] });
    const { id: analysisId } = await orch.start({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
      extraInstructions: "Add SSO support for enterprise tenants",
    });
    await drain(analysisId);
    const meta = JSON.parse(analyses.get(analysisId)!.metadata ?? "{}");
    expect(meta.extraInstructions).toBe("Add SSO support for enterprise tenants");
  });

  it("forwards extraInstructions into the specialist prompt via the OPERATOR NOTES boundary", async () => {
    const { provider, userPrompts } = makeCapturingProvider();
    const orch = new AnalysisOrchestrator({ provider, retrieve: async () => [] });
    const { id: analysisId } = await orch.start({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
      extraInstructions: "Evaluate GDPR data-deletion requirements",
    });
    await drain(analysisId);
    const withNotes = userPrompts.filter((p) => p.includes("BEGIN OPERATOR NOTES"));
    expect(withNotes.length).toBeGreaterThan(0);
    expect(withNotes.every((p) => p.includes("Evaluate GDPR data-deletion requirements"))).toBe(
      true,
    );
  });

  it("omits the OPERATOR NOTES boundary when no extraInstructions are supplied", async () => {
    const { provider, userPrompts } = makeCapturingProvider();
    const orch = new AnalysisOrchestrator({ provider, retrieve: async () => [] });
    const { id: analysisId } = await orch.start({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
    });
    await drain(analysisId);
    expect(analyses.get(analysisId)!.status).toBe("completed");
    expect(userPrompts.some((p) => p.includes("BEGIN OPERATOR NOTES"))).toBe(false);
  });

  it("reloads extraInstructions from metadata on single-agent regenerate (parity)", async () => {
    // Start with a normal provider so the analysis reaches a terminal state.
    const orch = new AnalysisOrchestrator({ provider: makeProvider({}), retrieve: async () => [] });
    const { id: analysisId } = await orch.start({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
      extraInstructions: "Support multi-region active-active deployment",
    });
    await drain(analysisId);

    // Swap in a capturing provider for the regenerate; extraInstructions is
    // NOT passed to regenerateAgent — it must be reloaded from metadata.
    const { provider, userPrompts } = makeCapturingProvider();
    (orch as unknown as { deps: { provider: AIProvider } }).deps.provider = provider;
    await orch.regenerateAgent({
      analysisId,
      agentKey: "document",
      actorId: "user-1234567890",
    });
    const withNotes = userPrompts.filter((p) => p.includes("BEGIN OPERATOR NOTES"));
    expect(withNotes.length).toBeGreaterThan(0);
    expect(withNotes.some((p) => p.includes("Support multi-region active-active deployment"))).toBe(
      true,
    );
  });
});

/**
 * Epic #912 (#916) — requirement-grounded code path. Exercises the
 * `runRequirementGroundedCodeAgent` method directly: per-requirement retrieval,
 * model findings carrying requirementId, and the synthetic info finding emitted
 * for requirements with no grounded evidence.
 */
describe("AnalysisOrchestrator requirement-grounded code agent (#916)", () => {
  // Knowledge stub: returns evidence only for the password requirement; the
  // audit requirement comes back empty so it must produce a gap finding.
  const makeKnowledge = () => ({
    search: vi.fn(async (_projectId: string, query: string, opts?: { documentIds?: string[] }) => {
      const hasEvidence = query.toLowerCase().includes("password");
      return {
        hits: hasEvidence
          ? [
              {
                chunkId: "chunk-1",
                documentId: opts?.documentIds?.[0] ?? "doc-1234567890",
                position: 2,
                filename: "auth.ts",
                text: "resetPassword(token) updates the credential store",
                score: 0.91,
                embeddingModel: "stub",
              },
            ]
          : [],
        embeddingModel: "stub",
        elapsedMs: 1,
      };
    }),
  });

  // Provider returns a code finding tagged with REQ-001 only; REQ-002 is left
  // for the orchestrator to backfill with a synthetic info finding.
  const makeCodeProvider = (): AIProvider =>
    ({
      key: "offline-stub" as const,
      model: "stub",
      offline: true,
      async chat(): Promise<ChatResponse> {
        return stubResponse(
          JSON.stringify({
            agentKey: "code",
            summary: "requirement-grounded review",
            findings: [
              {
                requirementId: "REQ-001",
                category: "architecture",
                severity: "high",
                title: "Password reset partially implemented",
                body: "resetPassword exists but lacks rate limiting",
                tags: ["gap"],
                citations: [{ documentId: "doc-1234567890", chunkIndex: 2 }],
              },
              {
                // Hallucinated requirement id — must be dropped to null.
                requirementId: "REQ-999",
                category: "other",
                severity: "low",
                title: "Stray finding",
                body: "not tied to a known requirement",
                tags: [],
                citations: [],
              },
            ],
            notes: [],
          }),
        );
      },
      async *stream() {
        yield { type: "done" } as const;
      },
      async embed() {
        return { vectors: [], dimension: 0, model: "stub" };
      },
      async models() {
        return ["stub"];
      },
      async ping() {
        return true;
      },
    }) as unknown as AIProvider;

  const requirementsFixture = [
    { id: "REQ-001", text: "Users can reset their password" },
    { id: "REQ-002", text: "Audit log retention is 90 days" },
  ];

  type FindingEvidence = { requirementId: string | null; tags?: string[] };
  const evidenceOf = (raw: string | null): FindingEvidence =>
    raw ? (JSON.parse(raw) as FindingEvidence) : { requirementId: null };

  const runGrounded = async (knowledge: { search: ReturnType<typeof vi.fn> }) => {
    const orch = new AnalysisOrchestrator({
      provider: makeCodeProvider(),
      knowledge:
        knowledge as unknown as import("../src/lib/rag/knowledge-service.js").KnowledgeService,
    });
    await (
      orch as unknown as {
        runRequirementGroundedCodeAgent: (input: unknown) => Promise<unknown>;
      }
    ).runRequirementGroundedCodeAgent({
      analysisId: "ana_rg",
      projectId: "proj-abcdefghij",
      projectName: "Acme",
      projectDescription: "monolith",
      requirements: requirementsFixture,
      documentIds: ["doc-1234567890"],
      signal: new AbortController().signal,
    });
    return [...agentResults.values()].find((a) => a.agentKey === "code")!;
  };

  it("searches per-requirement using the requirement text and document filter", async () => {
    const knowledge = makeKnowledge();
    await runGrounded(knowledge);
    expect(knowledge.search).toHaveBeenCalledTimes(2);
    const [, q1, opts1] = knowledge.search.mock.calls[0];
    expect(q1).toBe("Users can reset their password");
    expect(opts1).toMatchObject({ documentIds: ["doc-1234567890"] });
  });

  it("persists the model finding with its requirementId in the evidence blob", async () => {
    const row = await runGrounded(makeKnowledge());
    const grounded = row.findings.find((f) => f.title.includes("Password reset"))!;
    expect(grounded).toBeDefined();
    expect(evidenceOf(grounded.evidence).requirementId).toBe("REQ-001");
  });

  it("drops a hallucinated requirementId to null", async () => {
    const row = await runGrounded(makeKnowledge());
    const stray = row.findings.find((f) => f.title === "Stray finding")!;
    expect(stray).toBeDefined();
    expect(evidenceOf(stray.evidence).requirementId).toBeNull();
  });

  it("emits a synthetic info finding for a requirement with no grounded evidence", async () => {
    const row = await runGrounded(makeKnowledge());
    const gap = row.findings.find((f) => f.severity === "info")!;
    expect(gap).toBeDefined();
    expect(gap.title).toContain("REQ-002");
    expect(evidenceOf(gap.evidence).requirementId).toBe("REQ-002");
    expect(evidenceOf(gap.evidence).tags).toContain("requirement-gap");
  });

  it("falls back to all uploaded docs when documentIds is empty (#913 fallback)", async () => {
    // Seed the mock so prisma.document.findMany returns fallback docs.
    uploadedDocs = ["fallback-doc-1", "fallback-doc-2"];
    const knowledge = makeKnowledge();
    const orch = new AnalysisOrchestrator({
      provider: makeCodeProvider(),
      knowledge:
        knowledge as unknown as import("../src/lib/rag/knowledge-service.js").KnowledgeService,
    });
    await (
      orch as unknown as {
        runRequirementGroundedCodeAgent: (input: unknown) => Promise<unknown>;
      }
    ).runRequirementGroundedCodeAgent({
      analysisId: "ana_fallback",
      projectId: "proj-abcdefghij",
      projectName: "Acme",
      projectDescription: "monolith",
      requirements: requirementsFixture,
      documentIds: [], // empty → triggers fallback
      signal: new AbortController().signal,
    });
    // Should query with the fallback document ids from prisma.document.findMany
    const [, , opts] = knowledge.search.mock.calls[0];
    expect(opts).toMatchObject({ documentIds: ["fallback-doc-1", "fallback-doc-2"] });
    uploadedDocs = []; // reset
  });

  it("persists a failed status when the provider throws", async () => {
    const failProvider: AIProvider = {
      key: "offline-stub" as const,
      model: "stub",
      offline: true,
      async chat(): Promise<ChatResponse> {
        throw new Error("provider exploded");
      },
      async *stream() {
        yield { type: "done" } as const;
      },
      async embed() {
        return { vectors: [], dimension: 0, model: "stub" };
      },
      async models() {
        return ["stub"];
      },
      async ping() {
        return true;
      },
    } as unknown as AIProvider;

    const orch = new AnalysisOrchestrator({
      provider: failProvider,
      knowledge:
        makeKnowledge() as unknown as import("../src/lib/rag/knowledge-service.js").KnowledgeService,
    });
    await expect(
      (
        orch as unknown as {
          runRequirementGroundedCodeAgent: (input: unknown) => Promise<unknown>;
        }
      ).runRequirementGroundedCodeAgent({
        analysisId: "ana_fail",
        projectId: "proj-abcdefghij",
        projectName: "Acme",
        projectDescription: "monolith",
        requirements: requirementsFixture,
        documentIds: ["doc-1234567890"],
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("provider exploded");
    const row = [...agentResults.values()].find(
      (a) => a.analysisId === "ana_fail" && a.agentKey === "code",
    )!;
    expect(row).toBeDefined();
    expect(row.status).toBe("failed");
    expect(row.errorMessage).toBe("provider exploded");
  });

  it("persists a cancelled status when the signal is aborted", async () => {
    const controller = new AbortController();
    const slowProvider: AIProvider = {
      key: "offline-stub" as const,
      model: "stub",
      offline: true,
      async chat(): Promise<ChatResponse> {
        controller.abort();
        const err = new DOMException("aborted", "AbortError");
        throw err;
      },
      async *stream() {
        yield { type: "done" } as const;
      },
      async embed() {
        return { vectors: [], dimension: 0, model: "stub" };
      },
      async models() {
        return ["stub"];
      },
      async ping() {
        return true;
      },
    } as unknown as AIProvider;

    const orch = new AnalysisOrchestrator({
      provider: slowProvider,
      knowledge:
        makeKnowledge() as unknown as import("../src/lib/rag/knowledge-service.js").KnowledgeService,
    });
    await expect(
      (
        orch as unknown as {
          runRequirementGroundedCodeAgent: (input: unknown) => Promise<unknown>;
        }
      ).runRequirementGroundedCodeAgent({
        analysisId: "ana_abort",
        projectId: "proj-abcdefghij",
        projectName: "Acme",
        projectDescription: "monolith",
        requirements: requirementsFixture,
        documentIds: ["doc-1234567890"],
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    const row = [...agentResults.values()].find(
      (a) => a.analysisId === "ana_abort" && a.agentKey === "code",
    )!;
    expect(row).toBeDefined();
    expect(row.status).toBe("cancelled");
    expect(row.errorMessage).toBe("cancelled");
  });
});

describe("runEnhancementPipeline (Epic #922)", () => {
  // Online provider that answers the enhancement sub-prompts deterministically:
  // requirements extraction, then search-query generation.
  const makeEnhancementProvider = (withEvidenceNeed: boolean): AIProvider => {
    const provider = {
      key: "anthropic" as const,
      model: "stub",
      offline: false,
      async chat(
        messages: ChatMessage[],
        chatOpts?: { systemMessage?: string },
      ): Promise<ChatResponse> {
        const sys = chatOpts?.systemMessage ?? messages[0]?.content ?? "";
        if (sys.includes("requirements analyst")) {
          return stubResponse(
            JSON.stringify({
              requirements: [
                {
                  title: "Audit retention",
                  description: "Retain logs",
                  type: "non-functional",
                  stakeholders: ["compliance"],
                  priority: "must-have",
                  ambiguities: [
                    { field: "duration", description: "how long?", suggestedQuestion: "How long?" },
                  ],
                  evidenceNeeds: withEvidenceNeed
                    ? [
                        {
                          description: "NERC retention period",
                          domain: "compliance",
                          searchHints: [],
                        },
                      ]
                    : [],
                },
              ],
            }),
          );
        }
        if (sys.includes("search query generator")) {
          return stubResponse(JSON.stringify(["NERC CIP log retention period"]));
        }
        return stubResponse("plain digest");
      },
      async *stream() {
        yield { type: "done" } as const;
      },
      async embed() {
        return { vectors: [], dimension: 0, model: "stub" };
      },
      async models() {
        return ["stub"];
      },
      async ping() {
        return true;
      },
    };
    return provider as unknown as AIProvider;
  };

  const runPipeline = async (
    provider: AIProvider,
    opts: { enableWebResearch: boolean; enableClarification: boolean },
  ): Promise<string> => {
    const analysisId = nid("ana");
    analyses.set(analysisId, {
      id: analysisId,
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
      status: "running",
      startedAt: new Date(),
      completedAt: null,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      errorMessage: null,
      metadata: JSON.stringify({ agentKeys: ["document"], model: "stub" }),
      deletedAt: null,
      project: projects.get("proj-abcdefghij")!,
    });
    const orch = new AnalysisOrchestrator({
      provider,
      io: makeIO() as unknown as import("../src/lib/socket/server.js").MetisIOServer,
      retrieve: async () => [],
    });
    await (
      orch as unknown as {
        runEnhancementPipeline: (input: unknown) => Promise<void>;
      }
    ).runEnhancementPipeline({
      analysisId,
      extractedRequirements: [{ id: "r1", text: "System must retain audit logs." }],
      extraInstructions: undefined,
      enableWebResearch: opts.enableWebResearch,
      enableClarification: opts.enableClarification,
      model: "stub",
      signal: new AbortController().signal,
    });
    return analysisId;
  };

  it("offline provider records the opt-in flags but performs no extraction (no-op)", async () => {
    const offline = makeProvider({}); // offline: true
    const analysisId = await runPipeline(offline, {
      enableWebResearch: true,
      enableClarification: true,
    });
    const meta = JSON.parse(analyses.get(analysisId)!.metadata!);
    expect(meta.enhancement).toEqual({ enableWebResearch: true, enableClarification: true });
    expect(meta.structuredRequirements).toBeUndefined();
    expect(meta.webResearch).toBeUndefined();
  });

  it("persists structured requirements but skips web research when the flag is off", async () => {
    const provider = makeEnhancementProvider(false);
    const analysisId = await runPipeline(provider, {
      enableWebResearch: false,
      enableClarification: true,
    });
    const meta = JSON.parse(analyses.get(analysisId)!.metadata!);
    expect(meta.enhancement.enableWebResearch).toBe(false);
    expect(meta.structuredRequirements.requirements).toHaveLength(1);
    expect(meta.structuredRequirements.totalAmbiguities).toBe(1);
    expect(meta.webResearch).toBeUndefined();
  });

  it("persists web research digests when the flag is on and evidence is needed", async () => {
    const provider = makeEnhancementProvider(true);
    const analysisId = await runPipeline(provider, {
      enableWebResearch: true,
      enableClarification: false,
    });
    const meta = JSON.parse(analyses.get(analysisId)!.metadata!);
    expect(meta.structuredRequirements.requirements).toHaveLength(1);
    expect(meta.webResearch).toBeDefined();
    expect(meta.webResearch.digests.length).toBeGreaterThan(0);
    // Stub search yields no sources ⇒ digest is flagged for human review.
    expect(meta.webResearch.reviewRequired).toBeGreaterThan(0);
  });
});

/**
 * Issue #729 (Epic #725) — fused code-graph symbol context in the code agent's
 * single-shot `retrieveContext`. Flag OFF (default) must reproduce today's
 * behaviour exactly (the injected searcher is never queried); flag ON must
 * surface symbol chunks — with `filePath:startLine-endLine` provenance — in the
 * code agent's prompt.
 */
describe("AnalysisOrchestrator fused code-graph context (#729)", () => {
  const fusedSearcher = () => ({
    search: vi.fn(async () => [
      {
        symbolId: "sym-login",
        filePath: "src/lib/auth/login.ts",
        name: "loginUser",
        kind: "function",
        score: 0.9,
        snippet: "export function loginUser() {}",
      },
    ]),
  });
  const fusedLineLookup = () => ({
    resolve: vi.fn(
      async () =>
        new Map([["sym-login", { filePath: "src/lib/auth/login.ts", startLine: 12, endLine: 48 }]]),
    ),
  });
  const makeKnowledge = () =>
    ({
      search: vi.fn(async () => ({
        hits: [
          {
            chunkId: "ck-1",
            documentId: "doc-1234567890",
            position: 0,
            filename: "spec.md",
            text: "requirements context",
            score: 0.9,
          },
        ],
        embeddingModel: "stub",
        elapsedMs: 1,
      })),
    }) as unknown as import("../src/lib/rag/knowledge-service.js").KnowledgeService;

  async function drain(analysisId: string) {
    for (let i = 0; i < 200 && analyses.get(analysisId)!.status === "running"; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    __resetConfigSingleton();
  });

  it("flag OFF (explicit opt-out): never queries the code-graph searcher (regression)", async () => {
    vi.stubEnv("ANALYSIS_FUSED_CODE_RETRIEVAL", "false");
    __resetConfigSingleton();
    const searcher = fusedSearcher();
    const orch = new AnalysisOrchestrator({
      provider: makeProvider({}),
      knowledge: makeKnowledge(),
      fusedCode: { searcher, lineLookup: fusedLineLookup() },
    });
    const { id: analysisId } = await orch.start({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
      agentKeys: ["code"],
    });
    await drain(analysisId);
    expect(analyses.get(analysisId)!.status).toBe("completed");
    expect(searcher.search).not.toHaveBeenCalled();
  });

  it("flag DEFAULT (no env, #752): the single-shot code agent queries the searcher", async () => {
    // No env stubbed ⇒ the config default (now ON) governs.
    __resetConfigSingleton();
    const searcher = fusedSearcher();
    const orch = new AnalysisOrchestrator({
      provider: makeProvider({}),
      knowledge: makeKnowledge(),
      fusedCode: { searcher, lineLookup: fusedLineLookup() },
    });
    const { id: analysisId } = await orch.start({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
      agentKeys: ["code"],
    });
    await drain(analysisId);
    expect(analyses.get(analysisId)!.status).toBe("completed");
    expect(searcher.search).toHaveBeenCalled();
  });

  it("flag ON: the code agent prompt contains the fused symbol locator", async () => {
    vi.stubEnv("ANALYSIS_FUSED_CODE_RETRIEVAL", "true");
    __resetConfigSingleton();
    const searcher = fusedSearcher();
    const { provider, userPrompts } = makeCapturingProvider();
    const orch = new AnalysisOrchestrator({
      provider,
      knowledge: makeKnowledge(),
      fusedCode: { searcher, lineLookup: fusedLineLookup() },
    });
    const { id: analysisId } = await orch.start({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
      agentKeys: ["code"],
    });
    await drain(analysisId);
    expect(analyses.get(analysisId)!.status).toBe("completed");
    // The searcher was queried with the derived project-metadata query.
    expect(searcher.search).toHaveBeenCalledWith("Acme. monolith with billing", "proj-abcdefghij", {
      limit: 12,
    });
    // The code agent's user prompt carries the symbol chunk with its locator.
    const codePrompt = userPrompts.find((p) => p.includes("src/lib/auth/login.ts:12-48"));
    expect(codePrompt).toBeDefined();
    expect(codePrompt).toContain("loginUser (function)");
    expect(codePrompt).toContain("documentId=code-graph:sym-login");
  });

  // AC #1 targets the AGENTIC mode — the path reached when a code graph EXISTS
  // and requirements were extracted. That path runs `runAgenticCodeAgent`, NOT
  // `retrieveContext`, so it must seed the fused block into the agentic prompt
  // itself. This is the regression test for the review defect: before the fix
  // the agentic path never touched the fused searcher, so AC #1's scenario went
  // completely unwired. We drive `runAgenticCodeAgent` directly with explicit
  // requirements (i.e. agentic-mode-with-requirements) — the pipeline's own
  // requirement extraction is unreliable to force in a unit test.
  const runAgentic = (
    orch: AnalysisOrchestrator,
    requirements: Array<{ id: string; text: string }>,
  ) =>
    (
      orch as unknown as {
        runAgenticCodeAgent: (input: {
          analysisId: string;
          projectId: string;
          projectName: string;
          projectDescription: string;
          requirements: Array<{ id: string; text: string }>;
          signal: AbortSignal;
        }) => Promise<import("../src/lib/analysis/agent-runner.js").AgentRunResult>;
      }
    ).runAgenticCodeAgent({
      analysisId: nid("ana"),
      projectId: "proj-abcdefghij",
      projectName: "Acme",
      projectDescription: "monolith with billing",
      requirements,
      signal: new AbortController().signal,
    });

  it("AGENTIC flag ON: seeds the fused symbol block into the initial agentic prompt", async () => {
    vi.stubEnv("ANALYSIS_FUSED_CODE_RETRIEVAL", "true");
    __resetConfigSingleton();
    const searcher = fusedSearcher();
    const { provider, userPrompts } = makeCapturingProvider();
    const orch = new AnalysisOrchestrator({
      provider,
      knowledge: makeKnowledge(),
      fusedCode: { searcher, lineLookup: fusedLineLookup() },
    });
    await runAgentic(orch, [{ id: "REQ-001", text: "users can log in" }]);

    // The searcher was queried with project metadata fused with requirement text.
    expect(searcher.search).toHaveBeenCalledWith(
      "Acme. monolith with billing. users can log in",
      "proj-abcdefghij",
      { limit: 12 },
    );
    // The agent's INITIAL user message (turn 1, before any tool call) carries
    // the fused symbol block with its filePath:startLine-endLine provenance.
    const codePrompt = userPrompts.find((p) => p.includes("src/lib/auth/login.ts:12-48"));
    expect(codePrompt).toBeDefined();
    expect(codePrompt).toContain("loginUser (function)");
    expect(codePrompt).toContain("BEGIN RETRIEVED CONTEXT");
  });

  it("AGENTIC flag OFF (explicit opt-out): the searcher is never queried and no fused block is seeded", async () => {
    vi.stubEnv("ANALYSIS_FUSED_CODE_RETRIEVAL", "false");
    __resetConfigSingleton();
    const searcher = fusedSearcher();
    const { provider, userPrompts } = makeCapturingProvider();
    const orch = new AnalysisOrchestrator({
      provider,
      knowledge: makeKnowledge(),
      fusedCode: { searcher, lineLookup: fusedLineLookup() },
    });
    await runAgentic(orch, [{ id: "REQ-001", text: "users can log in" }]);

    expect(searcher.search).not.toHaveBeenCalled();
    // No fused locator anywhere in the agentic prompt.
    expect(userPrompts.some((p) => p.includes("src/lib/auth/login.ts:12-48"))).toBe(false);
    expect(userPrompts.some((p) => p.includes("BEGIN RETRIEVED CONTEXT"))).toBe(false);
  });

  // #752 VALIDATION — the headline scenario: with DEFAULT config (no env), the
  // AGENTIC code agent's turn-1 prompt carries the fused symbol block with
  // filePath:startLine-endLine provenance. (The search_code_symbols tool #730 is
  // offered unconditionally in agentic mode — see agentic-code-tools.test.ts.)
  it("AGENTIC flag DEFAULT (no env, #752): seeds the fused block into the initial agentic prompt", async () => {
    __resetConfigSingleton();
    const searcher = fusedSearcher();
    const { provider, userPrompts } = makeCapturingProvider();
    const orch = new AnalysisOrchestrator({
      provider,
      knowledge: makeKnowledge(),
      fusedCode: { searcher, lineLookup: fusedLineLookup() },
    });
    await runAgentic(orch, [{ id: "REQ-001", text: "users can log in" }]);

    expect(searcher.search).toHaveBeenCalled();
    const codePrompt = userPrompts.find((p) => p.includes("src/lib/auth/login.ts:12-48"));
    expect(codePrompt).toBeDefined();
    expect(codePrompt).toContain("loginUser (function)");
    expect(codePrompt).toContain("BEGIN RETRIEVED CONTEXT");
  });

  it("REQUIREMENT-GROUNDED flag ON: folds fused symbols into the grounded prompt", async () => {
    vi.stubEnv("ANALYSIS_FUSED_CODE_RETRIEVAL", "true");
    __resetConfigSingleton();
    const searcher = fusedSearcher();
    const { provider, userPrompts } = makeCapturingProvider();
    const orch = new AnalysisOrchestrator({
      provider,
      knowledge: makeKnowledge(),
      fusedCode: { searcher, lineLookup: fusedLineLookup() },
    });
    await (
      orch as unknown as {
        runRequirementGroundedCodeAgent: (input: {
          analysisId: string;
          projectId: string;
          projectName: string;
          projectDescription: string;
          requirements: Array<{ id: string; text: string }>;
          documentIds?: string[];
          signal: AbortSignal;
        }) => Promise<import("../src/lib/analysis/agent-runner.js").AgentRunResult>;
      }
    ).runRequirementGroundedCodeAgent({
      analysisId: nid("ana"),
      projectId: "proj-abcdefghij",
      projectName: "Acme",
      projectDescription: "monolith with billing",
      requirements: [{ id: "REQ-001", text: "users can log in" }],
      documentIds: ["doc-1234567890"],
      signal: new AbortController().signal,
    });

    expect(searcher.search).toHaveBeenCalled();
    const codePrompt = userPrompts.find((p) => p.includes("BEGIN CODE SYMBOLS"));
    expect(codePrompt).toBeDefined();
    expect(codePrompt).toContain("src/lib/auth/login.ts:12-48");
  });
});

/**
 * Issue #752 (Epic #725 wrap-up) — with ANALYSIS_SCHEMA_CONTEXT now ON by
 * default, the DATABASE agent (Sally) must receive the introspected live-schema
 * chunk under DEFAULT config (no env), and an operator opt-out must restore the
 * docs-only prompt. Drives the real `retrieveContext` database branch (no
 * `retrieve` short-circuit) with an injected introspection seam.
 */
describe("AnalysisOrchestrator schema-context default (#752)", () => {
  const dbTable = (): DbTableInfo => ({
    schema: "public",
    name: "users",
    columns: [
      { name: "id", dataType: "int", nullable: false, isPrimaryKey: true, isForeignKey: false },
    ],
    foreignKeys: [],
    indexes: [],
  });
  const schemaDeps = () => ({ introspect: vi.fn(async () => ({ tables: [dbTable()] })) });
  const emptyKnowledge = () =>
    ({
      search: vi.fn(async () => ({ hits: [], embeddingModel: "stub", elapsedMs: 0 })),
    }) as unknown as KnowledgeService;

  async function drain(analysisId: string) {
    for (let i = 0; i < 200 && analyses.get(analysisId)!.status === "running"; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    __resetConfigSingleton();
  });

  it("DEFAULT (no env): Sally's prompt carries the live-schema chunk", async () => {
    __resetConfigSingleton();
    const schemaContext = schemaDeps();
    const { provider, userPrompts } = makeCapturingProvider();
    const orch = new AnalysisOrchestrator({
      provider,
      knowledge: emptyKnowledge(),
      schemaContext,
    });
    const { id: analysisId } = await orch.start({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
      agentKeys: ["database"],
    });
    await drain(analysisId);
    expect(analyses.get(analysisId)!.status).toBe("completed");
    // The introspector ran under the actor who started the analysis.
    expect(schemaContext.introspect).toHaveBeenCalledWith("proj-abcdefghij", "user-1234567890");
    // Sally's user prompt embeds the synthetic live-schema chunk + its table.
    const sallyPrompt = userPrompts.find((p) => p.includes("live-schema:proj-abcdefghij"));
    expect(sallyPrompt).toBeDefined();
    expect(sallyPrompt).toContain("TABLE public.users");
  });

  it("operator opt-out (ANALYSIS_SCHEMA_CONTEXT=false): Sally's prompt has no schema chunk", async () => {
    vi.stubEnv("ANALYSIS_SCHEMA_CONTEXT", "false");
    __resetConfigSingleton();
    const schemaContext = schemaDeps();
    const { provider, userPrompts } = makeCapturingProvider();
    const orch = new AnalysisOrchestrator({
      provider,
      knowledge: emptyKnowledge(),
      schemaContext,
    });
    const { id: analysisId } = await orch.start({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
      agentKeys: ["database"],
    });
    await drain(analysisId);
    expect(analyses.get(analysisId)!.status).toBe("completed");
    expect(schemaContext.introspect).not.toHaveBeenCalled();
    expect(userPrompts.some((p) => p.includes("live-schema:proj-abcdefghij"))).toBe(false);
  });
});

/**
 * Issue #731 (Epic #725) — derive the code agent's SOURCE-CODE retrieval queries
 * from extracted requirements + `extraInstructions` + project metadata, using
 * the static `RETRIEVAL_QUERIES.code` bag only as a fallback.
 *
 * Two seams matter because they are the only places a source-code query is
 * built for a code path that runs:
 *   - `retrieveContext` (single-shot; no requirements by definition) — now
 *     derives the source-code half from project metadata + `extraInstructions`.
 *   - `runAgenticCodeAgent` (requirements PRESENT) — its fused symbol search must
 *     fold `extraInstructions` into the derived query too (previously it only
 *     used requirements + metadata).
 */
describe("AnalysisOrchestrator derived source-code retrieval queries (#731)", () => {
  const makeKnowledge = () => ({
    // Empty hits ⇒ no quarantine fallback is triggered; we only assert on the
    // QUERY strings the source-code half passes to `search`.
    search: vi.fn(async () => ({ hits: [], embeddingModel: "stub", elapsedMs: 1 })),
  });

  // Invoke the private `retrieveContext` directly. With NO `documentIds` and no
  // uploaded docs (`uploadedDocs = []`), the requirements half is skipped, so
  // every `knowledge.search` call is a SOURCE-CODE-half query.
  const retrieve = (
    orch: AnalysisOrchestrator,
    input: {
      projectId: string;
      agentKey: "code";
      projectName?: string;
      projectDescription?: string;
      extraInstructions?: string;
    },
  ) =>
    (
      orch as unknown as {
        retrieveContext: (i: unknown) => Promise<unknown>;
      }
    ).retrieveContext(input);

  it("derives the source-code query from project metadata + extraInstructions, keeping the static bag as a fallback query", async () => {
    const knowledge = makeKnowledge();
    const orch = new AnalysisOrchestrator({
      provider: makeProvider({}),
      knowledge:
        knowledge as unknown as import("../src/lib/rag/knowledge-service.js").KnowledgeService,
    });
    await retrieve(orch, {
      projectId: "proj-abcdefghij",
      agentKey: "code",
      projectName: "Acme",
      projectDescription: "billing monolith",
      extraInstructions: "evaluate SSO support",
    });
    const queries = knowledge.search.mock.calls.map(([, q]) => q);
    // Derived (metadata + notes) query, notes-only query, and the static bag.
    expect(queries).toContain("Acme. billing monolith. evaluate SSO support");
    expect(queries).toContain("evaluate SSO support");
    expect(queries).toContain(RETRIEVAL_QUERIES.code);
    // The static keyword bag is no longer the ONLY source-code query.
    expect(queries.length).toBeGreaterThan(1);
  });

  it("falls back to the static code bag exactly when no metadata or extraInstructions are available (regression)", async () => {
    const knowledge = makeKnowledge();
    const orch = new AnalysisOrchestrator({
      provider: makeProvider({}),
      knowledge:
        knowledge as unknown as import("../src/lib/rag/knowledge-service.js").KnowledgeService,
    });
    await retrieve(orch, { projectId: "proj-abcdefghij", agentKey: "code" });
    const queries = knowledge.search.mock.calls.map(([, q]) => q);
    // Identical to pre-#731 behaviour: a single search on the static bag.
    expect(queries).toEqual([RETRIEVAL_QUERIES.code]);
  });

  it("AGENTIC: folds extraInstructions into the fused source-code query alongside requirements + metadata", async () => {
    vi.stubEnv("ANALYSIS_FUSED_CODE_RETRIEVAL", "true");
    __resetConfigSingleton();
    const searcher = {
      search: vi.fn(async () => [] as unknown[]),
    };
    const lineLookup = { resolve: vi.fn(async () => new Map()) };
    const { provider } = makeCapturingProvider();
    const orch = new AnalysisOrchestrator({
      provider,
      knowledge:
        makeKnowledge() as unknown as import("../src/lib/rag/knowledge-service.js").KnowledgeService,
      fusedCode: {
        searcher: searcher as never,
        lineLookup: lineLookup as never,
      },
    });
    await (
      orch as unknown as {
        runAgenticCodeAgent: (input: {
          analysisId: string;
          projectId: string;
          projectName: string;
          projectDescription: string;
          requirements: Array<{ id: string; text: string }>;
          extraInstructions?: string;
          signal: AbortSignal;
        }) => Promise<unknown>;
      }
    ).runAgenticCodeAgent({
      analysisId: nid("ana"),
      projectId: "proj-abcdefghij",
      projectName: "Acme",
      projectDescription: "monolith with billing",
      requirements: [{ id: "REQ-001", text: "users can log in" }],
      extraInstructions: "prioritize SSO",
      signal: new AbortController().signal,
    });
    // The derived symbol query now carries the operator notes ("prioritize SSO")
    // between the project metadata and the requirement text.
    expect(searcher.search).toHaveBeenCalledWith(
      "Acme. monolith with billing. prioritize SSO. users can log in",
      "proj-abcdefghij",
      { limit: 12 },
    );
    vi.unstubAllEnvs();
    __resetConfigSingleton();
  });
});

/**
 * Issue #733 (Epic #725) — the analysis-capability record is populated on the
 * paths that ACTUALLY run: single-shot, requirement-grounded, AND agentic
 * (the reachability lesson from #729). Each mode drives a real pipeline run and
 * asserts the persisted `metadata.capability` shape + derived reasons.
 */
describe("AnalysisOrchestrator capability record (#733)", () => {
  async function drain(analysisId: string) {
    for (let i = 0; i < 400 && analyses.get(analysisId)!.status === "running"; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
  }
  // #750 REFACTOR: these tests previously stubbed the private
  // `extractRequirementsFromDocAgent` to force requirements, because the
  // AgentOutput schema stripped the document agent's raw `requirements` array.
  // #750 makes the document specialist emit `requirements` in its normal output
  // and validates the document agent with a schema that RETAINS them, so
  // `makeReqProvider` (which emits a `requirements` array) now routes the code
  // agent through the REAL extraction path — no stub needed.
  const readCapability = (analysisId: string) => {
    const meta = JSON.parse(analyses.get(analysisId)!.metadata ?? "{}") as {
      capability?: import("@metis/shared").AnalysisCapability;
    };
    return meta.capability;
  };
  const retrieveStub = async () => [
    {
      documentId: "doc-1234567890",
      chunkIndex: 0,
      filename: "spec.md",
      text: "context",
      score: 0.8,
    },
  ];

  // The document agent (Mary) must emit a `requirements` array for
  // `extractRequirementsFromDocAgent` to route the code agent into
  // agentic/requirement-grounded mode (empty ⇒ single-shot).
  const makeReqProvider = (): AIProvider =>
    ({
      key: "offline-stub" as const,
      model: "stub",
      offline: true,
      async chat(
        messages: ChatMessage[],
        chatOpts?: { signal?: AbortSignal; systemMessage?: string },
      ): Promise<ChatResponse> {
        const sys =
          chatOpts?.systemMessage ?? messages.find((m) => m.role === "system")?.content ?? "";
        const sysStr = typeof sys === "string" ? sys : "";
        if (sysStr.includes("Mary")) {
          return stubResponse(
            JSON.stringify({
              agentKey: "document",
              summary: "doc summary",
              requirements: [{ id: "REQ-001", text: "Users can reset their password" }],
              findings: [
                {
                  category: "architecture",
                  severity: "medium",
                  title: "document title",
                  body: "document body",
                  tags: ["t"],
                  citations: [{ documentId: "doc-1234567890", chunkIndex: 0 }],
                },
              ],
              notes: [],
            }),
          );
        }
        if (sysStr.includes("Winston")) {
          // #773 — in AGENTIC mode a clean run SEARCHES before it answers. Emit one
          // working tool call per pass (keyed off whether this conversation already
          // carries a tool result, so each pass of a multi-pass run does it once),
          // then the findings JSON. A code agent that retrieves nothing is a
          // degraded run by definition, and is reported as one.
          const alreadySearched = messages.some(
            (m) => typeof m.content === "string" && m.content.startsWith("Tool result for"),
          );
          if (codeGraphExists && !alreadySearched) {
            return stubResponse(
              JSON.stringify({ tool: "search_code_graph", query: "reset password" }),
            );
          }
          // #19 — …and a clean run VERIFIES its requirement, citing the code its
          // search returned. A requirement with no verdict is `could-not-verify` on
          // the page, and a run showing most requirements unverified is degraded.
          return stubResponse(
            buildCodeAgentJson(
              [{ filePath: "server/src/auth/auth-service.ts", startLine: 10, endLine: 42 }],
              "implemented",
            ),
          );
        }
        if (sysStr.includes("Sally")) return stubResponse(buildAgentJson("database"));
        if (sysStr.includes("Quinn")) return stubResponse(buildAgentJson("web"));
        return stubResponse(buildSynthesisJson());
      },
      async *stream() {
        yield { type: "done" } as const;
      },
      async embed() {
        return { vectors: [], dimension: 0, model: "stub" };
      },
      async models() {
        return ["stub"];
      },
      async ping() {
        return true;
      },
    }) as unknown as AIProvider;

  it("SINGLE-SHOT: persists agentMode=single-shot with the no-requirements reason", async () => {
    const io = makeIO();
    // Code agent, no document agent ⇒ no extracted requirements ⇒ single-shot.
    const orch = new AnalysisOrchestrator({
      provider: makeProvider({}),
      io: io as unknown as import("../src/lib/socket/server.js").MetisIOServer,
      retrieve: retrieveStub,
    });
    const { id: analysisId } = await orch.start({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
      agentKeys: ["code"],
    });
    await drain(analysisId);
    expect(analyses.get(analysisId)!.status).toBe("completed");
    const cap = readCapability(analysisId);
    expect(cap).toBeDefined();
    expect(cap!.agentMode).toBe("single-shot");
    expect(cap!.codeAnalysisRequested).toBe(true);
    expect(cap!.reasons).toContain("agentic-unavailable-no-requirements");
    expect(cap!.reasons).toContain("no-code-graph");
    expect(cap!.reasons).toContain("source-not-ingested");
    // Capability was also broadcast on the socket during the run.
    expect(io.events.some((e) => e.event === "analysis:capability")).toBe(true);
  });

  it("REQUIREMENT-GROUNDED: persists agentMode=requirement-grounded, no agentic reason", async () => {
    codeGraphExists = false; // requirements exist but no graph ⇒ requirement-grounded
    uploadedDocs = ["doc-1"];
    const orch = new AnalysisOrchestrator({
      provider: makeReqProvider(),
      retrieve: retrieveStub,
    });
    const { id: analysisId } = await orch.start({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
      agentKeys: ["document", "code"],
    });
    await drain(analysisId);
    expect(analyses.get(analysisId)!.status).toBe("completed");
    const cap = readCapability(analysisId);
    expect(cap!.agentMode).toBe("requirement-grounded");
    expect(cap!.reasons).toContain("no-code-graph");
    expect(cap!.reasons).not.toContain("agentic-unavailable-no-requirements");
  });

  it("AGENTIC: persists agentMode=agentic and codeGraphPresent=true", async () => {
    codeGraphExists = true; // graph + requirements ⇒ agentic
    repoSourceExists = true;
    uploadedDocs = ["doc-1"];
    const orch = new AnalysisOrchestrator({
      provider: makeReqProvider(),
      retrieve: retrieveStub,
    });
    const { id: analysisId } = await orch.start({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
      agentKeys: ["document", "code"],
    });
    await drain(analysisId);
    expect(analyses.get(analysisId)!.status).toBe("completed");
    const cap = readCapability(analysisId);
    expect(cap!.agentMode).toBe("agentic");
    expect(cap!.codeGraphPresent).toBe(true);
    expect(cap!.repoSourceIngested).toBe(true);
    expect(cap!.reasons).not.toContain("no-code-graph");
    expect(cap!.reasons).not.toContain("source-not-ingested");
    expect(cap!.reasons).not.toContain("agentic-unavailable-no-requirements");
  });

  it("FULLY CAPABLE: no degradation reasons when graph + source + flag are all present", async () => {
    codeGraphExists = true;
    repoSourceExists = true;
    uploadedDocs = ["doc-1"];
    vi.stubEnv("ANALYSIS_FUSED_CODE_RETRIEVAL", "true");
    __resetConfigSingleton();
    try {
      const orch = new AnalysisOrchestrator({
        provider: makeReqProvider(),
        retrieve: retrieveStub,
      });
      const { id: analysisId } = await orch.start({
        projectId: "proj-abcdefghij",
        startedById: "user-1234567890",
        // No database agent ⇒ schema-context-disabled must not fire.
        agentKeys: ["document", "code"],
      });
      await drain(analysisId);
      expect(analyses.get(analysisId)!.status).toBe("completed");
      const cap = readCapability(analysisId);
      expect(cap!.reasons).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      __resetConfigSingleton();
    }
  });

  // #752 — the acceptance criterion the whole issue turns on: under DEFAULT
  // config (NO env stub) a fully-capable run reports ZERO degradation reasons,
  // so `isAnalysisDegraded` is false and the UI banner does not render.
  it("FULLY CAPABLE under DEFAULT config (no env, #752): empty reasons ⇒ no banner", async () => {
    codeGraphExists = true;
    repoSourceExists = true;
    uploadedDocs = ["doc-1"];
    __resetConfigSingleton();
    const orch = new AnalysisOrchestrator({
      provider: makeReqProvider(),
      retrieve: retrieveStub,
    });
    const { id: analysisId } = await orch.start({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
      agentKeys: ["document", "code"],
    });
    await drain(analysisId);
    expect(analyses.get(analysisId)!.status).toBe("completed");
    const cap = readCapability(analysisId);
    expect(cap!.fusedCodeRetrievalEnabled).toBe(true);
    expect(cap!.reasons).toEqual([]);
  });

  // #752 — a project with NEITHER a code graph NOR a DB connector still runs
  // cleanly under the new defaults; the banner surfaces the STRUCTURAL reasons
  // (no graph / no source) but NOT the flag-disabled reasons, since both flags
  // are now on by default. This is the "degrades gracefully" guard.
  it("BARE project under DEFAULT config (#752): structural reasons only, never the flag-disabled reasons", async () => {
    // beforeEach leaves codeGraphExists=false, repoSourceExists=false, no connectors.
    __resetConfigSingleton();
    const io = makeIO();
    const orch = new AnalysisOrchestrator({
      provider: makeProvider({}),
      knowledge: stubKnowledge(),
      io: io as unknown as import("../src/lib/socket/server.js").MetisIOServer,
    });
    const { id: analysisId } = await orch.start({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
      agentKeys: ["code", "database"],
    });
    await drain(analysisId);
    expect(analyses.get(analysisId)!.status).toBe("completed");
    const cap = readCapability(analysisId);
    expect(cap!.reasons).toContain("no-code-graph");
    expect(cap!.reasons).toContain("source-not-ingested");
    expect(cap!.reasons).toContain("agentic-unavailable-no-requirements");
    // The point of #752: flags default ON, so these reasons must be absent.
    expect(cap!.reasons).not.toContain("fused-code-retrieval-disabled");
    expect(cap!.reasons).not.toContain("schema-context-disabled");
  });

  it("records repos skipped for budget in a multi-repo agentic run", async () => {
    codeGraphExists = true;
    repoSourceExists = true;
    uploadedDocs = ["doc-1"];
    // 3 repos with a 100k budget and a 50k per-repo floor ⇒ cap to 2, skip 1.
    repoConnectors = [
      { id: "c1", label: "web" },
      { id: "c2", label: "api" },
      { id: "c3", label: "worker" },
    ];
    const orch = new AnalysisOrchestrator({
      provider: makeReqProvider(),
      retrieve: retrieveStub,
    });
    const { id: analysisId } = await orch.start({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
      agentKeys: ["document", "code"],
    });
    await drain(analysisId);
    expect(analyses.get(analysisId)!.status).toBe("completed");
    const cap = readCapability(analysisId);
    expect(cap!.skippedRepos).toEqual([{ connectorId: "c3", label: "worker" }]);
    expect(cap!.reasons).toContain("repos-skipped-budget");
  });
});

/**
 * Issue #750 — requirement extraction is no longer dead code. These tests drive
 * the WHOLE pipeline through `start()` and assert on OBSERVABLE behaviour (which
 * mode's prompt the provider was actually handed), not by stubbing the private
 * extractor. Before #750 the code agent could never leave single-shot because
 * the document agent's `requirements` array was silently stripped at validation.
 */
describe("AnalysisOrchestrator requirement extraction routes the code agent (#750)", () => {
  async function drain(analysisId: string) {
    for (let i = 0; i < 400 && analyses.get(analysisId)!.status === "running"; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
  }
  const retrieve = async () => [
    { documentId: "doc-1", chunkIndex: 0, filename: "s.md", text: "c", score: 0.5 },
  ];

  it("AGENTIC: documents with requirements + a code graph ⇒ runAgenticCodeAgent executes", async () => {
    codeGraphExists = true;
    uploadedDocs = ["doc-1"];
    const provider = makeProvider({
      docRequirements: [{ id: "REQ-001", text: "Users can reset their password" }],
    });
    const orch = new AnalysisOrchestrator({
      provider,
      knowledge: stubKnowledge(),
      retrieve,
    });
    const { id: analysisId } = await orch.start({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
      agentKeys: ["document", "code"],
    });
    await drain(analysisId);
    expect(analyses.get(analysisId)!.status).toBe("completed");
    // Observable proof the agentic code agent actually ran (the multi-turn loop
    // built and dispatched the agentic prompt) — asserted end-to-end, not via a
    // stubbed private method.
    expect(systemMessagesOf(provider).some((s) => s.includes("MODE: AGENTIC"))).toBe(true);
    // The single-shot and requirement-grounded prompts were NOT used.
    expect(systemMessagesOf(provider).some((s) => s.includes("MODE: REQUIREMENT-GROUNDED"))).toBe(
      false,
    );
    // The agentic code agent completed and persisted a code row.
    const codeRows = [...agentResults.values()].filter(
      (a) => a.analysisId === analysisId && a.agentKey === "code",
    );
    expect(codeRows).toHaveLength(1);
    expect(codeRows[0]!.status).toBe("completed");
  });

  it("REQUIREMENT-GROUNDED: requirements but no code graph ⇒ runRequirementGroundedCodeAgent executes", async () => {
    codeGraphExists = false;
    uploadedDocs = ["doc-1"];
    const provider = makeProvider({
      docRequirements: [{ id: "REQ-001", text: "Users can reset their password" }],
    });
    const orch = new AnalysisOrchestrator({ provider, retrieve });
    const { id: analysisId } = await orch.start({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
      agentKeys: ["document", "code"],
    });
    await drain(analysisId);
    expect(analyses.get(analysisId)!.status).toBe("completed");
    expect(systemMessagesOf(provider).some((s) => s.includes("MODE: REQUIREMENT-GROUNDED"))).toBe(
      true,
    );
    expect(systemMessagesOf(provider).some((s) => s.includes("MODE: AGENTIC"))).toBe(false);
  });

  it("SINGLE-SHOT: no extractable requirements ⇒ single-shot AND capability reason agentic-unavailable-no-requirements", async () => {
    codeGraphExists = true; // graph present, but no requirements ⇒ still single-shot
    uploadedDocs = ["doc-1"];
    const io = makeIO();
    // No `docRequirements` ⇒ the document agent yields an empty requirements array.
    const provider = makeProvider({});
    const orch = new AnalysisOrchestrator({
      provider,
      knowledge: stubKnowledge(),
      io: io as unknown as import("../src/lib/socket/server.js").MetisIOServer,
      retrieve,
    });
    const { id: analysisId } = await orch.start({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
      agentKeys: ["document", "code"],
    });
    await drain(analysisId);
    expect(analyses.get(analysisId)!.status).toBe("completed");
    // Neither agentic nor requirement-grounded prompt was ever built.
    expect(systemMessagesOf(provider).some((s) => s.includes("MODE: AGENTIC"))).toBe(false);
    expect(systemMessagesOf(provider).some((s) => s.includes("MODE: REQUIREMENT-GROUNDED"))).toBe(
      false,
    );
    // #733 capability record surfaces the degradation (not silent).
    const meta = JSON.parse(analyses.get(analysisId)!.metadata ?? "{}") as {
      capability?: import("@metis/shared").AnalysisCapability;
    };
    expect(meta.capability!.agentMode).toBe("single-shot");
    expect(meta.capability!.reasons).toContain("agentic-unavailable-no-requirements");
  });

  it("INTEGRATION: extractRequirementsFromDocAgent round-trips the real persisted document-agent output", async () => {
    // Drive the document agent through the REAL runAgent + persistAgentResult
    // path (no hand-built AgentResult fixture): the provider emits requirements,
    // runAgent validates with the document schema that retains them, and
    // persistAgentResult serialises the row exactly as production does.
    const analysisId = "ana_roundtrip";
    const provider = makeProvider({
      docRequirements: [
        { id: "REQ-001", text: "Users can reset their password" },
        { id: "REQ-002", text: "Admins can export an audit log" },
      ],
    });
    const result = await runAgent(provider, {
      agentKey: "document",
      projectName: "Acme",
      projectDescription: "monolith with billing",
      retrieved: [
        { documentId: "doc-1", chunkIndex: 0, filename: "s.md", text: "context", score: 0.5 },
      ],
    });
    await persistAgentResult({
      analysisId,
      agentKey: "document",
      status: "completed",
      output: result.output,
      startedAt: new Date(),
      completedAt: new Date(),
      usage: result.usage,
    });
    const orch = new AnalysisOrchestrator({ provider, retrieve });
    const extracted = await (
      orch as unknown as {
        extractRequirementsFromDocAgent: (
          id: string,
        ) => Promise<Array<{ id: string; text: string }>>;
      }
    ).extractRequirementsFromDocAgent(analysisId);
    expect(extracted).toEqual([
      { id: "REQ-001", text: "Users can reset their password" },
      { id: "REQ-002", text: "Admins can export an audit log" },
    ]);
  });
});
