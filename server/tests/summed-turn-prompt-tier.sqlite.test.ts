/**
 * #1080 (PR #1092 review) — a usage row is not always one model request.
 *
 * A chat turn that runs a tool loop (`/chat` and `/stream`), a discussion reply
 * and a failed-turn row are each ONE row per usage store holding the SUM of the
 * turn's model calls. Claude Haiku 5.5 is priced by prompt length, per request
 * (https://platform.claude.com/docs/en/about-claude/pricing, read 2026-10-11):
 *
 *   prompt ≤ 100,000 tokens   $0.10 in / $0.50 out per MTok
 *   prompt > 100,000 tokens   $0.50 in / $2.50 out per MTok
 *
 * so such a row must cost the sum of its calls' prices, not the price of their
 * sum. Worked by hand, never derived from the code under test:
 *
 *   four calls of 30,000 in / 1,000 out
 *     one by one   4 × (30,000 × $0.10/M + 1,000 × $0.50/M) = 4 × $0.0035 = $0.014
 *     as one row   120,000 × $0.50/M + 4,000 × $2.50/M      = $0.07   (the defect)
 *   two calls of 60,000 in / 1,000 out (the failed turn)
 *     one by one   2 × (60,000 × $0.10/M + 1,000 × $0.50/M) = 2 × $0.0065 = $0.013
 *     as one row   120,000 × $0.50/M + 2,000 × $2.50/M      = $0.065  (the defect)
 *
 * Claude Sonnet 5.5 ($2 in / $10 out, no tier) is the control: the same turns
 * must cost exactly what their summed tokens cost, as before.
 *
 *   four calls   120,000 × $2/M + 4,000 × $10/M = $0.28
 *   two calls    120,000 × $2/M + 2,000 × $10/M = $0.26
 *
 * Each case checks the STORED cost in both tables and the two readers that
 * re-price a `token_usages` row from its stored tokens: the agent-run cost
 * (`computeRunCost`) and the budget ceiling's projection, which re-prices a row
 * recorded unpriced (`projectMonthlyCostForCeiling`).
 *
 * The real routes and the real responder run over a real SQLite database built
 * by the real migration chain, so the new `requestTokens` column is the one the
 * migration adds. The provider is a scripted double: nothing calls a model.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";
import type { AIProvider, ChatChunk, ChatResponse, ToolDefinition } from "../src/lib/ai/types.js";
import type { RuntimeTool } from "../src/lib/ai/tool-runtime/types.js";

const state = vi.hoisted(() => {
  process.env.AI_RATE_LIMIT_MAX = "10000";
  return { db: null as unknown };
});
vi.mock("../src/lib/prisma.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return {
    get prisma() {
      return state.db;
    },
    Prisma,
  };
});
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));
vi.mock("../src/lib/rag/knowledge-service.js", async (original) => ({
  ...(await original<typeof import("../src/lib/rag/knowledge-service.js")>()),
  getKnowledgeService: () => ({ search: async () => ({ hits: [] }) }),
}));

const { aiRouter, setAIProviderForTests } = await import("../src/routes/ai.js");
const { aiConversationRouter } = await import("../src/routes/ai-conversation.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { getTokenTracker } = await import("../src/lib/ai/token-tracker.js");
const { getPendingUsageWrites } = await import("../src/lib/finops/token-tracker.js");
const { projectMonthlyCostForCeiling, projectMonthlyFromMtd } =
  await import("../src/lib/finops/budget-enforcer.js");
const { computeRunCost } = await import("../src/lib/replay/runs-service.js");
const { __resetToolRegistrySingleton, getToolRegistry } =
  await import("../src/lib/ai/tool-registry.js");
const { __resetToolApprovalBroker } = await import("../src/lib/ai/tool-runtime/approval-broker.js");
const { __resetModelCatalogForTests } = await import("../src/lib/ai/model-catalog.js");
const { makeToolset } = await import("../src/lib/ai/tool-runtime/toolset.js");
const { ApprovalGateService } = await import("../src/lib/ai/approval-policy.js");
const { streamAIReply } = await import("../src/lib/discussions/ai-responder.js");
const { DISCUSSION_TOOL_POLICY } = await import("../src/lib/discussions/grounding.js");

const ALICE = "u-alice";
const HAIKU = "claude-haiku-5-5";
const SONNET = "claude-sonnet-5-5";

/** One scripted model call: what it reports, and whether it calls the tool or fails. */
interface Step {
  usage: { promptTokens: number; completionTokens: number };
  tool?: boolean;
  fail?: boolean;
}
const call = (promptTokens: number, extra: Partial<Step> = {}): Step => ({
  usage: { promptTokens, completionTokens: 1_000 },
  ...extra,
});
/** Three tool rounds and an answer: four calls of 30,000 in / 1,000 out. */
const FOUR_SMALL_CALLS = (): Step[] => [
  call(30_000, { tool: true }),
  call(30_000, { tool: true }),
  call(30_000, { tool: true }),
  call(30_000),
];
/** Two paid tool rounds of 60,000 in / 1,000 out, then the third call fails. */
const TWO_CALLS_THEN_FAIL = (): Step[] => [
  call(60_000, { tool: true }),
  call(60_000, { tool: true }),
  { usage: { promptTokens: 0, completionTokens: 0 }, fail: true },
];

/** A native-tool-calling provider that answers from a script. Calls no model. */
class ScriptedProvider implements AIProvider {
  readonly key = "anthropic" as const;
  readonly offline = false;
  readonly capabilities = { responseFormat: false, nativeToolCalls: true };
  calls = 0;
  constructor(
    readonly model: string,
    private readonly script: Step[],
    private readonly toolName: string,
  ) {}

  private next(): Step {
    const step = this.script.shift();
    if (!step) throw new Error("the script has no more model calls");
    if (step.fail) throw new Error("upstream exploded");
    this.calls += 1;
    return step;
  }
  private usageOf(step: Step) {
    return {
      ...step.usage,
      totalTokens: step.usage.promptTokens + step.usage.completionTokens,
    };
  }

  async chat(): Promise<ChatResponse> {
    const step = this.next();
    return {
      content: step.tool ? "" : "the answer",
      usage: this.usageOf(step),
      model: this.model,
      provider: this.key,
      finishReason: step.tool ? "tool_use" : "end_turn",
      ...(step.tool
        ? { toolCalls: [{ id: `call_${this.calls}`, name: this.toolName, args: { table: "t" } }] }
        : {}),
    };
  }

  async *stream(): AsyncGenerator<ChatChunk> {
    const step = this.next();
    if (step.tool) {
      yield {
        type: "tool_call",
        name: this.toolName,
        arguments: { table: "t" },
        toolCallId: `call_${this.calls}`,
        native: true,
      };
    } else {
      yield { type: "delta", content: "the answer" };
    }
    yield { type: "usage", usage: this.usageOf(step) };
    yield { type: "done", finishReason: step.tool ? "tool_use" : "end_turn" };
  }

  async embed() {
    return { vectors: [], dimension: 0, model: "x" };
  }
  async models() {
    return [this.model];
  }
  async ping() {
    return true;
  }
}

/** A model, and what the two scripted turns must cost on it (USD, worked in the header). */
const MODELS = [
  { model: HAIKU, tiered: true, fourCallsUsd: 0.014, twoCallsUsd: 0.013 },
  { model: SONNET, tiered: false, fourCallsUsd: 0.28, twoCallsUsd: 0.26 },
] as const;

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1080 — a row that sums several model calls is priced call by call",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let alice: string;
    let seq = 0;
    const savedEnv: Record<string, string | undefined> = {};
    const ENV_KEYS = [
      "AI_OFFLINE",
      "AI_PROVIDER",
      "AI_MODEL",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_BASE_URL_BILLS_AS",
      "ANTHROPIC_MODEL",
      "MODEL_PRICES",
    ];

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/ai", aiRouter());
      a.use("/api/ai", aiConversationRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const post = (url: string, body: object = {}) =>
      request(app()).post(url).set("Authorization", `Bearer ${alice}`).send(body);

    /** A fresh project on `model`, so one test's rows are the project's whole month. */
    async function newProject(model: string): Promise<string> {
      const id = `p-${++seq}`;
      await db.project.create({
        data: {
          id,
          name: id,
          slug: id,
          createdById: ALICE,
          aiProviderId: "anthropic",
          aiModel: model,
        },
      });
      return id;
    }
    async function newSession(projectId: string): Promise<string> {
      const res = await post("/api/ai/sessions", { projectId });
      expect(res.status, res.text).toBe(201);
      return (res.body.data.session as { id: string }).id;
    }
    async function usageRows(sessionId: string) {
      for (
        let i = 0;
        i < 200 && (getTokenTracker().inFlight > 0 || getPendingUsageWrites() > 0);
        i++
      ) {
        await new Promise((r) => setTimeout(r, 5));
      }
      return {
        perUser: await db.aITokenUsage.findMany({ where: { sessionId } }),
        project: await db.tokenUsage.findMany({ where: { sessionId } }),
      };
    }

    /**
     * What the two readers that re-price a stored row from its TOKENS make of
     * this session's ledger row.
     */
    async function repriced(sessionId: string, projectId: string) {
      const hour = 3_600_000;
      const run = await db.agentRun.create({
        data: {
          sessionId,
          projectId,
          kind: "chat",
          startedAt: new Date(Date.now() - hour),
          completedAt: new Date(Date.now() + hour),
          status: "completed",
        },
      });
      const runCostUsd = (await computeRunCost(run.id)).costUsd;
      // The ceiling re-prices only a row recorded UNPRICED, so make it one: the
      // tokens (and the requests they sum) are all it then has to go on.
      const row = await db.tokenUsage.findFirstOrThrow({ where: { sessionId } });
      await db.tokenUsage.updateMany({
        where: { sessionId },
        data: { costUsd: null, costCents: null },
      });
      const ceiling = await projectMonthlyCostForCeiling(projectId, row.createdAt);
      return { runCostUsd, ceiling, at: row.createdAt };
    }

    /** One row per store, holding the turn's sum and costing `usd` — stored and re-priced. */
    async function expectTurnCost(
      sessionId: string,
      projectId: string,
      expected: { usd: number; inputTokens: number; outputTokens: number; requests: number[][] },
    ): Promise<void> {
      const { perUser, project } = await usageRows(sessionId);
      // The turn is still ONE row in each store, with the same summed tokens.
      expect(project).toHaveLength(1);
      expect(perUser).toHaveLength(1);
      expect(project[0]).toMatchObject({
        inputTokens: expected.inputTokens,
        outputTokens: expected.outputTokens,
        totalTokens: expected.inputTokens + expected.outputTokens,
      });
      expect(perUser[0]).toMatchObject({
        promptTokens: expected.inputTokens,
        completionTokens: expected.outputTokens,
      });
      // Stored cost, both tables.
      expect(project[0]!.costUsd).toBeCloseTo(expected.usd, 12);
      expect(project[0]!.costCents).toBe(Math.round(expected.usd * 100));
      expect(perUser[0]!.estimatedCostUsd).toBeCloseTo(expected.usd, 12);
      // The row lists the requests it sums.
      expect(JSON.parse(project[0]!.requestTokens ?? "null")).toEqual(expected.requests);

      // Re-priced from the stored tokens.
      const again = await repriced(sessionId, projectId);
      expect(again.runCostUsd).toBeCloseTo(expected.usd, 12);
      expect(again.ceiling).toEqual({
        projectedCents: projectMonthlyFromMtd(expected.usd * 100, again.at),
        unpricedTokens: 0,
      });
    }

    const FOUR = { inputTokens: 120_000, outputTokens: 4_000 };
    const FOUR_REQUESTS = Array.from({ length: 4 }, () => [30_000, 1_000, 0, 0]);
    const TWO = { inputTokens: 120_000, outputTokens: 2_000 };
    const TWO_REQUESTS = Array.from({ length: 2 }, () => [60_000, 1_000, 0, 0]);

    beforeAll(async () => {
      sqlite = createMigratedSqlite("summed-turn-tier");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: ALICE, username: "alice", displayName: "alice", email: "a@example.test" },
      });
      alice = issueTokens({
        userId: ALICE,
        username: "alice",
        role: "developer",
        permissions: [],
      }).accessToken;
      for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(() => {
      // Anthropic's own endpoint and no administrator prices: the built-in
      // Claude prices apply (a third-party base URL would unprice them).
      delete process.env.AI_OFFLINE;
      process.env.AI_PROVIDER = "anthropic";
      process.env.ANTHROPIC_API_KEY = "placeholder-not-a-key";
      delete process.env.AI_MODEL;
      delete process.env.ANTHROPIC_BASE_URL;
      delete process.env.ANTHROPIC_BASE_URL_BILLS_AS;
      delete process.env.ANTHROPIC_MODEL;
      delete process.env.MODEL_PRICES;
      __resetModelCatalogForTests();
      __resetToolRegistrySingleton();
      __resetToolApprovalBroker();
      getToolRegistry().register({
        name: "count_rows",
        description: "Count rows",
        schema: z.object({ table: z.string() }),
        risk: "low",
        exec: async () => ({ text: "rows: 7" }),
      } as ToolDefinition);
    });

    afterEach(() => {
      setAIProviderForTests(null);
      for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
    });

    for (const m of MODELS) {
      const label = m.tiered ? `${m.model} (priced by prompt length)` : `${m.model} (no tier)`;

      for (const route of ["/api/ai/chat", "/api/ai/stream"] as const) {
        it(`${route} on ${label} — a four-call tool turn costs the sum of its calls`, async () => {
          const projectId = await newProject(m.model);
          const sessionId = await newSession(projectId);
          const provider = new ScriptedProvider(m.model, FOUR_SMALL_CALLS(), "count_rows");
          setAIProviderForTests(provider);

          const res = await post(route, { sessionId, message: "count rows" });
          if (route === "/api/ai/chat") expect(res.status, res.text).toBe(200);
          else expect(res.text).toContain("event: done");
          expect(provider.calls).toBe(4); // the loop really made four model calls

          await expectTurnCost(sessionId, projectId, {
            usd: m.fourCallsUsd,
            ...FOUR,
            requests: FOUR_REQUESTS,
          });
        });

        it(`${route} on ${label} — a turn that fails after two paid calls costs the sum of those calls`, async () => {
          const projectId = await newProject(m.model);
          const sessionId = await newSession(projectId);
          const provider = new ScriptedProvider(m.model, TWO_CALLS_THEN_FAIL(), "count_rows");
          setAIProviderForTests(provider);

          const res = await post(route, { sessionId, message: "count rows" });
          if (route === "/api/ai/chat") expect(res.status).toBeGreaterThanOrEqual(500);
          else expect(res.text).toContain("event: error");
          expect(provider.calls).toBe(2);

          const { perUser, project } = await usageRows(sessionId);
          expect(project[0]?.agentStep).toBe("chat-failed");
          expect(perUser[0]?.agentStep).toBe("chat-failed");
          await expectTurnCost(sessionId, projectId, {
            usd: m.twoCallsUsd,
            ...TWO,
            requests: TWO_REQUESTS,
          });
        });
      }

      /** A read-only tool under the discussion gate, as `resolveDiscussionTools` builds it. */
      const discussionTools = (sessionId: string) => {
        const tool: RuntimeTool = {
          name: "read_file_slice",
          wireName: "read_file_slice",
          description: "read a file",
          parameters: { type: "object" },
          risk: "low",
          source: "code",
          validate: (args: unknown) => ({ ok: true as const, args }),
          execute: async () => ({ text: "package model", resultCount: 1 }),
        };
        return {
          toolset: makeToolset([tool]),
          native: true,
          note: "## Tools",
          gate: new ApprovalGateService({
            sessionId,
            userId: ALICE,
            policy: { ...DISCUSSION_TOOL_POLICY },
            agentAllowlist: ["read_file_slice"],
          }),
        };
      };
      async function discuss(provider: ScriptedProvider, projectId: string) {
        const thread = await db.discussionThread.create({
          data: { projectId, createdById: ALICE },
        });
        return streamAIReply({
          thread: { id: thread.id, projectId, aiResponseMode: "on_mention" },
          triggerMessage: { id: "m-1", body: "@AI where is the feed model?" },
          actor: { id: ALICE },
          provider,
          resolveTools: async (session) => discussionTools(session.id),
        });
      }

      it(`a discussion reply on ${label} — four calls cost the sum of its calls`, async () => {
        const projectId = await newProject(m.model);
        const provider = new ScriptedProvider(m.model, FOUR_SMALL_CALLS(), "read_file_slice");

        const reply = await discuss(provider, projectId);
        expect(provider.calls).toBe(4);

        const sessionId = reply.message.aiSessionId;
        const { project } = await usageRows(sessionId);
        expect(project[0]?.agentStep).toBe("discussion");
        await expectTurnCost(sessionId, projectId, {
          usd: m.fourCallsUsd,
          ...FOUR,
          requests: FOUR_REQUESTS,
        });
      });

      it(`a failed discussion reply on ${label} — two paid calls cost the sum of those calls`, async () => {
        const projectId = await newProject(m.model);
        const provider = new ScriptedProvider(m.model, TWO_CALLS_THEN_FAIL(), "read_file_slice");

        await expect(discuss(provider, projectId)).rejects.toThrow("upstream exploded");
        expect(provider.calls).toBe(2);

        const session = await db.aISession.findFirstOrThrow({ where: { projectId } });
        const { project } = await usageRows(session.id);
        expect(project[0]?.agentStep).toBe("discussion-failed");
        await expectTurnCost(session.id, projectId, {
          usd: m.twoCallsUsd,
          ...TWO,
          requests: TWO_REQUESTS,
        });
      });
    }

    it("a one-call turn stores no request list — the row is the request", async () => {
      const projectId = await newProject(HAIKU);
      const sessionId = await newSession(projectId);
      // One call over the threshold: 100,001 × $0.50/M + 1,000 × $2.50/M = $0.0525005.
      setAIProviderForTests(new ScriptedProvider(HAIKU, [call(100_001)], "count_rows"));

      const res = await post("/api/ai/chat", { sessionId, message: "hello" });
      expect(res.status, res.text).toBe(200);

      const { perUser, project } = await usageRows(sessionId);
      expect(project).toHaveLength(1);
      expect(project[0]!.requestTokens).toBeNull();
      expect(project[0]!.costUsd).toBeCloseTo(0.0525005, 12);
      expect(perUser[0]!.estimatedCostUsd).toBeCloseTo(0.0525005, 12);
    });
  },
);
