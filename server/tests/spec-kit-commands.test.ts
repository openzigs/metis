/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Tests for the Spec Kit slash command runners (#204-#208 + /implement).
 * Mocks Prisma + governance hooks so the runners are exercised in isolation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatMessage, ChatResponse } from "../src/lib/ai/types.js";

// ── Prisma mock (reused by artifacts service + runner.loadProjectContext) ──
const artifactRows = new Map<string, any>();
let nextId = 0;
const projects = new Map<string, any>();
const auditCalls: any[] = [];

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    auditLog: { create: vi.fn(async () => ({})) },
    specKitArtifact: {
      findMany: vi.fn(async ({ where }: any) =>
        [...artifactRows.values()].filter((r) => r.projectId === where.projectId),
      ),
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.projectId_name) {
          for (const r of artifactRows.values()) {
            if (
              r.projectId === where.projectId_name.projectId &&
              r.name === where.projectId_name.name
            )
              return r;
          }
        }
        return null;
      }),
      create: vi.fn(async ({ data }: any) => {
        nextId++;
        const row = {
          id: `ska_${nextId}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          projectId: data.projectId,
          name: data.name,
          content: data.content ?? "",
          version: data.version ?? 1,
          updatedById: data.updatedById ?? null,
        };
        artifactRows.set(row.id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const r = artifactRows.get(where.id);
        Object.assign(r, data, { updatedAt: new Date() });
        return r;
      }),
    },
    project: {
      findUnique: vi.fn(async ({ where }: any) => projects.get(where.id) ?? null),
    },
  },
}));

// ── Audit ──────────────────────────────────────────────────────────────────
vi.mock("../src/lib/audit/audit-service.js", () => ({
  audit: vi.fn((entry: any) => {
    auditCalls.push(entry);
  }),
  getAuditService: vi.fn(() => ({ record: vi.fn() })),
}));

// ── FinOps ─────────────────────────────────────────────────────────────────
const finopsState = vi.hoisted(() => ({ budgetThrows: false }));
const { FakeBudgetExceededError } = vi.hoisted(() => {
  class FakeBudgetExceededError extends Error {
    status = 402;
    code = "BUDGET_EXCEEDED";
    usedTokens = 1_000_000;
    budget = 500_000;
  }
  return { FakeBudgetExceededError };
});
vi.mock("../src/lib/finops/index.js", () => ({
  assertWithinBudget: vi.fn(async () => {
    if (finopsState.budgetThrows) throw new FakeBudgetExceededError("Budget exceeded");
  }),
  BudgetExceededError: FakeBudgetExceededError,
  recordUsage: vi.fn(() => ({ totalTokens: 0, costCents: 0 })),
}));

// ── Safety ────────────────────────────────────────────────────────────────
const safetyState = vi.hoisted(() => ({ denyInput: false, denyOutput: false }));
const { FakeSafetyDeniedError } = vi.hoisted(() => {
  class FakeSafetyDeniedError extends Error {
    status = 422;
    code = "SAFETY_BLOCKED";
    findings: unknown[] = [];
  }
  return { FakeSafetyDeniedError };
});
vi.mock("../src/lib/safety/index.js", () => ({
  applySafety: vi.fn(async (text: string, ctx: { direction: string }) => {
    if (ctx.direction === "input" && safetyState.denyInput) {
      throw new FakeSafetyDeniedError("input blocked");
    }
    if (ctx.direction === "output" && safetyState.denyOutput) {
      throw new FakeSafetyDeniedError("output blocked");
    }
    return { text, redacted: false };
  }),
  SafetyDeniedError: FakeSafetyDeniedError,
}));

// ── Now load the runners (they pick up mocks above) ───────────────────────
import { runSpecify } from "../src/lib/spec-kit/commands/specify.js";
import { runPlan } from "../src/lib/spec-kit/commands/plan.js";
import { runTasks } from "../src/lib/spec-kit/commands/tasks.js";
import { runClarify } from "../src/lib/spec-kit/commands/clarify.js";
import { runAnalyze } from "../src/lib/spec-kit/commands/analyze.js";
import { runImplement } from "../src/lib/spec-kit/commands/implement.js";
import { writeArtifact } from "../src/lib/spec-kit/artifacts.js";
import { SpecKitArtifactError } from "../src/lib/spec-kit/artifacts.js";

class FakeProvider implements AIProvider {
  readonly key: any = "offline-stub";
  constructor(private readonly text: string) {}
  async chat(_m: ChatMessage[], _o: unknown): Promise<ChatResponse> {
    return {
      content: this.text,
      provider: this.key,
      model: "fake-model",
      usage: { promptTokens: 5, completionTokens: 7, totalTokens: 12 },
      finishReason: "stop",
    } as unknown as ChatResponse;
  }
}

/**
 * Echoes the agent system message back as completion content so tests can
 * assert that the RAG context block actually reached the provider (#374/#375).
 */
class EchoSystemProvider implements AIProvider {
  readonly key: any = "offline-stub";
  async chat(_m: ChatMessage[], o: any): Promise<ChatResponse> {
    return {
      content: String(o?.systemMessage ?? ""),
      provider: this.key,
      model: "fake-model",
      usage: { promptTokens: 5, completionTokens: 7, totalTokens: 12 },
      finishReason: "stop",
    } as unknown as ChatResponse;
  }
}

function ragChunk(partial: any): any {
  return {
    chunkId: "c1",
    documentId: "d1",
    filename: "src/foo.ts",
    position: "L1-L10",
    text: "body",
    score: 0.7,
    embeddingModel: "fake-model",
    ...partial,
  };
}

/** Injectable fake knowledge service returning the supplied hits. */
function fakeKnowledgeService(hits: any[]): any {
  return { search: vi.fn(async () => ({ hits })) };
}

/** Injectable fake whose `search` throws (embedder offline / fallback). */
function throwingKnowledgeService(): any {
  return {
    search: vi.fn(async () => {
      throw new Error("embedder offline");
    }),
  };
}

beforeEach(() => {
  artifactRows.clear();
  projects.clear();
  auditCalls.length = 0;
  nextId = 0;
  finopsState.budgetThrows = false;
  safetyState.denyInput = false;
  safetyState.denyOutput = false;
  projects.set("p1", {
    id: "p1",
    name: "Demo",
    description: "Demo project",
    safetyMode: "standard",
    aiProviderId: null,
  });
});

afterEach(() => vi.clearAllMocks());

describe("/specify", () => {
  it("rejects empty prompt", async () => {
    await expect(runSpecify({ projectId: "p1", prompt: "  " })).rejects.toThrow(
      SpecKitArtifactError,
    );
  });

  it("writes spec.md and audits a success row", async () => {
    const r = await runSpecify({
      projectId: "p1",
      prompt: "build a billing dashboard",
      actorId: "u1",
      deps: { provider: new FakeProvider("# Spec\n...") },
    });
    expect(r.artifact.name).toBe("spec.md");
    expect(r.artifact.content).toContain("# Spec");
    expect(auditCalls.find((c) => c.action === "spec_kit.command.specify")).toBeTruthy();
  });

  it("audits a budget denial when assertWithinBudget throws", async () => {
    finopsState.budgetThrows = true;
    await expect(
      runSpecify({
        projectId: "p1",
        prompt: "x",
        deps: { provider: new FakeProvider("ignored") },
      }),
    ).rejects.toBeInstanceOf(FakeBudgetExceededError);
    expect(auditCalls.find((c) => c.action === "spec_kit.command.specify.denied")).toBeTruthy();
  });

  it("audits a safety denial when applySafety blocks input", async () => {
    safetyState.denyInput = true;
    await expect(
      runSpecify({
        projectId: "p1",
        prompt: "x",
        deps: { provider: new FakeProvider("ignored") },
      }),
    ).rejects.toBeInstanceOf(FakeSafetyDeniedError);
    expect(
      auditCalls.find(
        (c) => c.action === "spec_kit.command.specify.denied" && c.metadata?.direction === "input",
      ),
    ).toBeTruthy();
  });

  it("grounds the spec on project RAG when the knowledge service returns hits (#374)", async () => {
    const ks = fakeKnowledgeService([
      ragChunk({ filename: "server/src/billing/ledger.ts", position: "L10-L40", text: "ledger" }),
    ]);
    // The provider echoes the system prompt so we can assert the RAG block
    // (and its untrusted-data framing) reached the agent.
    const r = await runSpecify({
      projectId: "p1",
      prompt: "build a billing dashboard",
      actorId: "u1",
      knowledgeService: ks,
      deps: { provider: new EchoSystemProvider() },
    });
    // Top-k first; the second call pins the rest of the retrieved document (#20).
    expect(ks.search.mock.calls[0][2]).toEqual({ k: 8 });
    // RAG context threaded into the agent system prompt.
    expect(r.artifact.content).toContain("Retrieved Project Knowledge");
    expect(r.artifact.content).toContain("server/src/billing/ledger.ts#L10-L40");
    expect(r.artifact.content).toMatch(/untrusted reference/i);
    // Success audit records that RAG was attempted with the right chunk count.
    const ok = auditCalls.find((c) => c.action === "spec_kit.command.specify");
    expect(ok?.metadata?.ragAttempted).toBe(true);
    expect(ok?.metadata?.ragChunksUsed).toBe(1);
    expect(r.message).toMatch(/grounded on 1 retrieved chunk/);
  });

  it("still succeeds ungrounded when retrieval returns zero hits (#374)", async () => {
    const ks = fakeKnowledgeService([]);
    const r = await runSpecify({
      projectId: "p1",
      prompt: "build a billing dashboard",
      knowledgeService: ks,
      deps: { provider: new FakeProvider("# Spec\nok") },
    });
    expect(r.artifact.name).toBe("spec.md");
    expect(r.message).toMatch(/ungrounded/);
    const ok = auditCalls.find((c) => c.action === "spec_kit.command.specify");
    expect(ok?.metadata?.ragChunksUsed).toBe(0);
  });

  it("still succeeds ungrounded when retrieval throws (#374)", async () => {
    const ks = throwingKnowledgeService();
    const r = await runSpecify({
      projectId: "p1",
      prompt: "build a billing dashboard",
      knowledgeService: ks,
      deps: { provider: new FakeProvider("# Spec\nok") },
    });
    expect(r.artifact.name).toBe("spec.md");
    expect(r.message).toMatch(/ungrounded/);
  });
});

describe("/plan", () => {
  it("requires spec.md", async () => {
    await expect(runPlan({ projectId: "p1" })).rejects.toMatchObject({
      code: "SPEC_KIT_PLAN_NEEDS_SPEC",
    });
  });

  it("writes plan.md after spec exists", async () => {
    await writeArtifact({ projectId: "p1", name: "spec.md", content: "spec body" });
    const r = await runPlan({
      projectId: "p1",
      deps: { provider: new FakeProvider("# Plan\n```mermaid\ngraph TD\n```") },
    });
    expect(r.artifact.name).toBe("plan.md");
    expect(r.artifact.content).toContain("# Plan");
  });

  it("grounds the plan on project RAG when the knowledge service returns hits (#375)", async () => {
    await writeArtifact({ projectId: "p1", name: "spec.md", content: "spec body" });
    const ks = fakeKnowledgeService([
      ragChunk({ filename: "server/src/server.ts", position: "L1-L80", text: "express app" }),
    ]);
    const r = await runPlan({
      projectId: "p1",
      knowledgeService: ks,
      deps: { provider: new EchoSystemProvider() },
    });
    // Top-k first; the second call pins the rest of the retrieved document (#20).
    expect(ks.search.mock.calls[0][2]).toEqual({ k: 8 });
    expect(r.artifact.content).toContain("Retrieved Project Knowledge");
    expect(r.artifact.content).toContain("server/src/server.ts#L1-L80");
    const ok = auditCalls.find((c) => c.action === "spec_kit.command.plan");
    expect(ok?.metadata?.ragAttempted).toBe(true);
    expect(ok?.metadata?.ragChunksUsed).toBe(1);
    expect(r.message).toMatch(/grounded on 1 retrieved chunk/);
  });

  it("still produces a valid plan.md ungrounded when retrieval is empty/fails (#375)", async () => {
    await writeArtifact({ projectId: "p1", name: "spec.md", content: "spec body" });
    const ks = fakeKnowledgeService([]);
    const r = await runPlan({
      projectId: "p1",
      knowledgeService: ks,
      deps: { provider: new FakeProvider("# Plan\n```mermaid\ngraph TD\n```") },
    });
    expect(r.artifact.name).toBe("plan.md");
    expect(r.artifact.content).toContain("# Plan");
    expect(r.message).toMatch(/ungrounded/);
    // 409 needs-spec guard still enforced when no spec exists.
    const ok = auditCalls.find((c) => c.action === "spec_kit.command.plan");
    expect(ok?.metadata?.ragChunksUsed).toBe(0);
  });
});

describe("grounding in the codebase (#20)", () => {
  const noCode = {
    searcher: { search: vi.fn(async () => []) },
    lineLookup: { resolve: vi.fn(async () => new Map()) },
  };

  it("/specify retrieves on the operator brief alone and pins requirement documents", async () => {
    const ks = fakeKnowledgeService([ragChunk({ filename: "req.md", documentId: "req" })]);
    await runSpecify({
      projectId: "p1",
      prompt: "recover malformed tool-call markup",
      knowledgeService: ks,
      deps: { provider: new FakeProvider("# Spec\nok") },
    });
    expect(ks.search.mock.calls[0][1]).toBe("recover malformed tool-call markup");
    expect(ks.search).toHaveBeenCalledWith("p1", "recover malformed tool-call markup", {
      k: 8,
      documentIds: ["req"],
    });
  });

  it("/plan retrieves on the spec's requirement text and always queries the code graph", async () => {
    await writeArtifact({
      projectId: "p1",
      name: "spec.md",
      content: "# Spec\nRepair tool calls.\n## Stakeholders\n- ops\n## In scope\n- JSON repair",
    });
    const ks = fakeKnowledgeService([]);
    const fusedCode = {
      searcher: {
        search: vi.fn(async () => [
          { symbolId: "s1", filePath: "x", name: "parseToolCalls", kind: "function", score: 1 },
        ]),
      },
      lineLookup: {
        resolve: vi.fn(
          async () =>
            new Map([
              [
                "s1",
                {
                  filePath: "server/src/lib/analysis/agent-loop.ts",
                  startLine: 1030,
                  endLine: 1088,
                },
              ],
            ]),
        ),
      },
    };
    const r = await runPlan({
      projectId: "p1",
      knowledgeService: ks,
      fusedCode,
      pathLookup: { hasCodeGraph: async () => false, findExisting: async () => [] },
      deps: { provider: new EchoSystemProvider() },
    });
    const query = ks.search.mock.calls[0][1] as string;
    expect(query).toBe("Repair tool calls.\n- JSON repair");
    expect(query).not.toContain("Demo");
    expect(query).not.toMatch(/architecture components modules/);
    expect(fusedCode.searcher.search).toHaveBeenCalledOnce();
    expect(r.artifact.content).toContain("server/src/lib/analysis/agent-loop.ts:1030-1088");
    expect(r.message).toMatch(/grounded on 1 code symbol\./);
  });

  it("/plan reports backticked paths the code graph does not contain", async () => {
    await writeArtifact({ projectId: "p1", name: "spec.md", content: "spec body" });
    const r = await runPlan({
      projectId: "p1",
      knowledgeService: fakeKnowledgeService([]),
      fusedCode: noCode,
      pathLookup: {
        hasCodeGraph: async () => true,
        findExisting: async () => ["server/src/lib/analysis/agent-loop.ts"],
      },
      deps: {
        provider: new FakeProvider(
          "# Plan\nExtend `server/src/lib/analysis/agent-loop.ts`; add `server/src/lib/MultiTurnToolCallNormalizer.ts`.",
        ),
      },
    });
    expect(r.message).toMatch(
      /1 referenced path is not in the project's code graph: `server\/src\/lib\/MultiTurnToolCallNormalizer\.ts`\.$/,
    );
    expect(r.message).not.toContain("agent-loop.ts");
  });

  it("/plan adds no path note when every referenced path exists", async () => {
    await writeArtifact({ projectId: "p1", name: "spec.md", content: "spec body" });
    const r = await runPlan({
      projectId: "p1",
      knowledgeService: fakeKnowledgeService([]),
      fusedCode: noCode,
      pathLookup: {
        hasCodeGraph: async () => true,
        findExisting: async () => ["a/b.ts", "c/d.ts"],
      },
      deps: { provider: new FakeProvider("# Plan\n`a/b.ts` and `c/d.ts`") },
    });
    expect(r.message).toMatch(/ungrounded \(no project knowledge retrieved\)\.$/);
  });

  it("/plan pluralises the path note", async () => {
    await writeArtifact({ projectId: "p1", name: "spec.md", content: "spec body" });
    const r = await runPlan({
      projectId: "p1",
      knowledgeService: fakeKnowledgeService([]),
      fusedCode: noCode,
      pathLookup: { hasCodeGraph: async () => true, findExisting: async () => [] },
      deps: { provider: new FakeProvider("# Plan\n`a/b.ts` and `c/d.ts`") },
    });
    expect(r.message).toContain(
      "2 referenced paths are not in the project's code graph: `a/b.ts`, `c/d.ts`.",
    );
  });

  it("/tasks reports test tasks that trail the implementation they cover", async () => {
    await writeArtifact({ projectId: "p1", name: "spec.md", content: "s" });
    await writeArtifact({ projectId: "p1", name: "plan.md", content: "p" });
    const r = await runTasks({
      projectId: "p1",
      deps: {
        provider: new FakeProvider(
          [
            "## Tasks",
            "- [ ] T01 — Implement JSON repair (satisfies: AC-1) depends-on: none",
            "- [ ] T02 — Implement gate (satisfies: AC-2) depends-on: none",
            "- [ ] T03 — Unit tests for JSON repair (satisfies: AC-1) depends-on: T01",
            "- [ ] T04 — Unit tests for gate (satisfies: AC-2) depends-on: T02",
          ].join("\n"),
        ),
      },
    });
    expect(r.message).toMatch(/Test tasks T03, T04 come after the implementation they cover\.$/);
  });

  it("/tasks uses the singular form for one late test task", async () => {
    await writeArtifact({ projectId: "p1", name: "spec.md", content: "s" });
    await writeArtifact({ projectId: "p1", name: "plan.md", content: "p" });
    const r = await runTasks({
      projectId: "p1",
      deps: {
        provider: new FakeProvider(
          "- [ ] T01 — Implement repair (satisfies: AC-1)\n- [ ] T02 — Tests for repair (satisfies: AC-1)",
        ),
      },
    });
    expect(r.message).toMatch(/Test task T02 comes after the implementation it covers\.$/);
  });

  it("/tasks adds no note when tests come first", async () => {
    await writeArtifact({ projectId: "p1", name: "spec.md", content: "s" });
    await writeArtifact({ projectId: "p1", name: "plan.md", content: "p" });
    const r = await runTasks({
      projectId: "p1",
      deps: {
        provider: new FakeProvider(
          "- [ ] T01 — Failing tests for repair (satisfies: AC-1)\n- [ ] T02 — Implement repair (satisfies: AC-1) depends-on: T01",
        ),
      },
    });
    expect(r.message).toMatch(/tokens\.$/);
  });
});

describe("/tasks", () => {
  it("requires spec then plan", async () => {
    await expect(runTasks({ projectId: "p1" })).rejects.toMatchObject({
      code: "SPEC_KIT_TASKS_NEEDS_SPEC",
    });
    await writeArtifact({ projectId: "p1", name: "spec.md", content: "s" });
    await expect(runTasks({ projectId: "p1" })).rejects.toMatchObject({
      code: "SPEC_KIT_TASKS_NEEDS_PLAN",
    });
  });

  it("writes tasks.md when both prerequisites are present", async () => {
    await writeArtifact({ projectId: "p1", name: "spec.md", content: "s" });
    await writeArtifact({ projectId: "p1", name: "plan.md", content: "p" });
    const r = await runTasks({
      projectId: "p1",
      deps: {
        provider: new FakeProvider("| # | Title | SP | Deps | Notes |\n|---|---|---|---|---|"),
      },
    });
    expect(r.artifact.name).toBe("tasks.md");
  });
});

describe("/clarify", () => {
  it("question mode invokes the agent and stores Q line", async () => {
    const r = await runClarify({
      projectId: "p1",
      input: "",
      deps: { provider: new FakeProvider("- **Q:** what is the SLA?") },
    });
    expect(r.questioned).toBe(true);
    expect(r.artifact.content).toContain("- **Q:** what is the SLA?");
  });

  it("answer mode 409s when no question is pending", async () => {
    await expect(runClarify({ projectId: "p1", input: "Five nines" })).rejects.toMatchObject({
      code: "SPEC_KIT_NO_PENDING_QUESTION",
    });
  });

  it("answer mode appends an A line and skips the agent", async () => {
    await runClarify({
      projectId: "p1",
      input: "",
      deps: { provider: new FakeProvider("- **Q:** what is the SLA?") },
    });
    const r = await runClarify({
      projectId: "p1",
      input: "Five nines",
      // No provider — answer mode must not call AI.
    });
    expect(r.questioned).toBe(false);
    expect(r.artifact.content).toContain("- **A:** Five nines");
  });
});

describe("/analyze", () => {
  it("requires spec + plan + tasks", async () => {
    await expect(runAnalyze({ projectId: "p1" })).rejects.toMatchObject({
      code: "SPEC_KIT_ANALYZE_INCOMPLETE",
    });
  });

  it("appends a timestamped block and parses the verdict", async () => {
    await writeArtifact({ projectId: "p1", name: "spec.md", content: "s" });
    await writeArtifact({ projectId: "p1", name: "plan.md", content: "p" });
    await writeArtifact({ projectId: "p1", name: "tasks.md", content: "t" });
    const r = await runAnalyze({
      projectId: "p1",
      now: () => new Date("2026-05-02T12:00:00Z"),
      deps: { provider: new FakeProvider("## Summary\n\nOK\n\n## Uncovered\n- none") },
    });
    expect(r.verdict).toBe("OK");
    expect(r.artifact.content).toContain("/analyze run @ 2026-05-02T12:00:00.000Z");
  });

  it("returns UNKNOWN when the agent omits a Summary header", async () => {
    await writeArtifact({ projectId: "p1", name: "spec.md", content: "s" });
    await writeArtifact({ projectId: "p1", name: "plan.md", content: "p" });
    await writeArtifact({ projectId: "p1", name: "tasks.md", content: "t" });
    const r = await runAnalyze({
      projectId: "p1",
      deps: { provider: new FakeProvider("nothing useful") },
    });
    expect(r.verdict).toBe("UNKNOWN");
  });
});

describe("/implement", () => {
  it("rejects when prerequisites are missing", async () => {
    await expect(runImplement({ projectId: "p1" })).rejects.toMatchObject({
      code: "SPEC_KIT_IMPLEMENT_INCOMPLETE",
    });
  });

  it("returns the orchestrator handoff payload + audits success", async () => {
    await writeArtifact({ projectId: "p1", name: "spec.md", content: "s" });
    await writeArtifact({ projectId: "p1", name: "plan.md", content: "p" });
    await writeArtifact({ projectId: "p1", name: "tasks.md", content: "t" });
    const r = await runImplement({ projectId: "p1", actorId: "u1" });
    expect(r.context).toEqual(["spec.md", "plan.md", "tasks.md"]);
    expect(r.orchestratorRoute).toBe("/api/projects/p1/analyses");
    expect(auditCalls.find((c) => c.action === "spec_kit.command.implement")).toBeTruthy();
  });
});
