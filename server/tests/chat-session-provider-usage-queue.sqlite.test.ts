/**
 * Chat follow-ups #241, #243 and #204 — REAL provider classes talking to
 * loopback HTTP servers, through the real routes, over a real SQLite database
 * built by the real migration chain. Nothing on the wire is stubbed: what a
 * test asserts about "which provider got the turn" is what a loopback server
 * actually received.
 *
 *   #241 — a chat/stream/compact turn runs on the provider STORED ON THE
 *          SESSION (a per-project override), not the deployment's global one;
 *          one that cannot be built is refused by name, never re-routed.
 *   #243 — a turn that fails after paid model calls meters what they cost, once,
 *          in both usage stores; one that fails before any usage writes nothing.
 *   #204 — the /stream hard ceiling measures generation, not time queued behind
 *          the local model's only slot; the queue wait has its own, reported
 *          limit.
 */
import express from "express";
import request from "supertest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
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
import type { AIProvider, ChatChunk, ToolDefinition } from "../src/lib/ai/types.js";

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
const { audit } = await import("../src/lib/audit/audit-service.js");
const { getTokenTracker } = await import("../src/lib/ai/token-tracker.js");
const { getPendingUsageWrites } = await import("../src/lib/finops/token-tracker.js");
const { __resetToolRegistrySingleton, getToolRegistry } =
  await import("../src/lib/ai/tool-registry.js");
const { __resetToolApprovalBroker } = await import("../src/lib/ai/tool-runtime/approval-broker.js");
const { OpenAICompatibleProvider } =
  await import("../src/lib/ai/providers/bedrock-direct-provider.js");
const { localConcurrencyLimiter, resetLocalConcurrencyLimitersForTests } =
  await import("../src/lib/ai/providers/local-concurrency-limiter.js");
const { __resetModelCatalogForTests } = await import("../src/lib/ai/model-catalog.js");
const { FAILED_TURN_AGENT_STEP } = await import("../src/lib/ai/conversation/turn-usage.js");

type Body = Record<string, unknown>;
interface Seen {
  path: string;
  body: Body;
  headers: IncomingMessage["headers"];
}
/**
 * What the OpenAI-shaped server does with its next request. `delegate` calls
 * the first sub-agent tool (`agent_*`) the request offers.
 */
type Step = "text" | "tool" | "delegate" | "fail" | "hang";

const IDS = {
  alice: "u-alice",
  anth: "p-anth",
  anthOnly: "p-anth-provider-only",
  azure: "p-azure",
  plain: "p-plain",
  retired: "p-retired",
  delegating: "p-delegating",
} as const;

async function usageSettled(): Promise<void> {
  for (let i = 0; i < 200 && (getTokenTracker().inFlight > 0 || getPendingUsageWrites() > 0); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

function readBody(req: IncomingMessage): Promise<Body> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
    req.on("end", () => resolve(raw ? (JSON.parse(raw) as Body) : {}));
  });
}

function openAiReply(res: ServerResponse, body: Body, step: "text" | "tool" | "delegate"): void {
  const streaming = body.stream === true;
  const usage = { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 };
  const offered = ((body.tools as Array<{ function: { name: string } }> | undefined) ?? []).map(
    (t) => t.function.name,
  );
  const agentTool = offered.find((n) => n.startsWith("agent_"));
  const toolCall = {
    id: `call_${Math.random().toString(36).slice(2, 8)}`,
    type: "function",
    function:
      step === "delegate"
        ? { name: agentTool ?? "no_agent_offered", arguments: JSON.stringify({ task: "count t" }) }
        : { name: "count_rows", arguments: JSON.stringify({ table: "t" }) },
  };
  if (step === "delegate") step = "tool";
  const finish = step === "tool" ? "tool_calls" : "stop";
  if (!streaming) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "c1",
        object: "chat.completion",
        model: "gpt-4.1",
        choices: [
          {
            index: 0,
            message:
              step === "tool"
                ? { role: "assistant", content: null, tool_calls: [toolCall] }
                : { role: "assistant", content: "openai says hi" },
            finish_reason: finish,
          },
        ],
        usage,
      }),
    );
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  const chunk = (d: Body) => `data: ${JSON.stringify(d)}\n\n`;
  res.end(
    chunk({
      id: "c1",
      choices: [
        {
          index: 0,
          delta:
            step === "tool"
              ? { role: "assistant", tool_calls: [{ index: 0, ...toolCall }] }
              : { content: "openai says hi" },
          finish_reason: null,
        },
      ],
    }) +
      chunk({ id: "c1", choices: [{ index: 0, delta: {}, finish_reason: finish }], usage }) +
      "data: [DONE]\n\n",
  );
}

function anthropicReply(res: ServerResponse, streaming: boolean): void {
  const text = "anthropic says hi";
  if (!streaming) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 11, output_tokens: 3 },
      }),
    );
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  const ev = (type: string, data: Body) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  res.end(
    ev("message_start", {
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 11, output_tokens: 1 },
      },
    }) +
      ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
      ev("content_block_delta", { index: 0, delta: { type: "text_delta", text } }) +
      ev("content_block_stop", { index: 0 }) +
      ev("message_delta", {
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 3 },
      }) +
      ev("message_stop", {}),
  );
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "chat follow-ups #241 / #243 / #204 — real providers on loopback",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let alice: string;
    let openaiServer: Server;
    let anthropicServer: Server;
    let openaiBase = "";
    let anthropicBase = "";
    const openaiSeen: Seen[] = [];
    const anthropicSeen: Seen[] = [];
    const steps: Step[] = [];
    /** Run, in order, as each OpenAI-shaped request arrives (before it is answered). */
    const onOpenAiRequest: Array<() => void> = [];
    const hanging: ServerResponse[] = [];
    const savedEnv: Record<string, string | undefined> = {};
    const ENV_KEYS = [
      "AI_OFFLINE",
      "AI_PROVIDER",
      "AI_MODEL",
      "OPENAI_BASE_URL",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_MODEL",
      "AZURE_OPENAI_ENDPOINT",
      "AZURE_OPENAI_API_KEY",
      "AI_STREAM_MAX_DURATION_MS",
      "AI_STREAM_QUEUE_MAX_WAIT_MS",
      "AI_STREAM_IDLE_TIMEOUT_MS",
      "LOCAL_GEMMA_MAX_CONCURRENCY",
      "CHAT_CODE_SEARCH_TOOLS",
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
    async function newSession(
      projectId?: string,
      extra: Body = {},
    ): Promise<{ id: string; provider: string }> {
      const res = await post("/api/ai/sessions", { ...(projectId ? { projectId } : {}), ...extra });
      expect(res.status, res.text).toBe(201);
      return res.body.data.session as { id: string; provider: string };
    }
    const stream = (sessionId: string, message: string) =>
      post("/api/ai/stream", { sessionId, message });
    const chat = (sessionId: string, message: string) =>
      post("/api/ai/chat", { sessionId, message });
    /** The newest assistant row, read back through the transcript route. */
    async function lastReply(sessionId: string): Promise<{ incomplete: Body | null }> {
      const res = await request(app())
        .get(`/api/ai/sessions/${sessionId}/messages`)
        .set("Authorization", `Bearer ${alice}`);
      expect(res.status).toBe(200);
      const rows = res.body.data.messages as Array<{ role: string; incomplete: Body | null }>;
      return rows.filter((r) => r.role === "assistant").at(-1)!;
    }

    beforeAll(async () => {
      sqlite = createMigratedSqlite("b4-chat");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: IDS.alice, username: "alice", displayName: "alice", email: "a@example.test" },
      });
      const projects: Array<[string, string | null, string | null]> = [
        [IDS.anth, "anthropic", "claude-sonnet-4-6"],
        [IDS.anthOnly, "anthropic", null],
        [IDS.azure, "azure", null],
        [IDS.plain, null, null],
        [IDS.retired, "copilot-native", null],
        [IDS.delegating, null, null],
      ];
      for (const [id, aiProviderId, aiModel] of projects) {
        await db.project.create({
          data: { id, name: id, slug: id, createdById: IDS.alice, aiProviderId, aiModel },
        });
      }
      // #204 — a project whose chat may delegate to a sub-agent.
      await db.customAgent.create({
        data: {
          id: "c-counter",
          projectId: IDS.delegating,
          name: "Counter",
          description: "Counts rows.",
          systemPrompt: "You count rows.",
          tools: JSON.stringify(["count_rows"]),
        },
      });
      alice = issueTokens({
        userId: IDS.alice,
        username: "alice",
        role: "developer",
        permissions: [],
      }).accessToken;

      openaiServer = createServer((req, res) => {
        void readBody(req).then((body) => {
          openaiSeen.push({ path: req.url ?? "", body, headers: req.headers });
          const step = steps.shift() ?? "text";
          if (step === "hang") {
            hanging.push(res);
            return;
          }
          if (step === "fail") {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { message: "upstream exploded" } }));
            return;
          }
          onOpenAiRequest.shift()?.();
          openAiReply(res, body, step);
        });
      });
      anthropicServer = createServer((req, res) => {
        void readBody(req).then((body) => {
          anthropicSeen.push({ path: req.url ?? "", body, headers: req.headers });
          anthropicReply(res, body.stream === true);
        });
      });
      await new Promise<void>((r) => openaiServer.listen(0, "127.0.0.1", () => r()));
      await new Promise<void>((r) => anthropicServer.listen(0, "127.0.0.1", () => r()));
      openaiBase = `http://127.0.0.1:${(openaiServer.address() as AddressInfo).port}`;
      anthropicBase = `http://127.0.0.1:${(anthropicServer.address() as AddressInfo).port}`;
      for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      for (const res of hanging.splice(0)) res.destroy();
      openaiServer.closeAllConnections();
      anthropicServer.closeAllConnections();
      await new Promise<void>((r) => openaiServer.close(() => r()));
      await new Promise<void>((r) => anthropicServer.close(() => r()));
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(() => {
      // The deployment's GLOBAL provider is `openai` (loopback A). Anthropic is
      // configured too (loopback B) — only a session bound to it may reach it.
      delete process.env.AI_OFFLINE;
      process.env.AI_PROVIDER = "openai";
      process.env.AI_MODEL = "gpt-4.1";
      process.env.OPENAI_BASE_URL = `${openaiBase}/v1`;
      process.env.OPENAI_API_KEY = "k-openai";
      process.env.ANTHROPIC_API_KEY = "k-anthropic";
      process.env.ANTHROPIC_BASE_URL = anthropicBase;
      delete process.env.ANTHROPIC_MODEL;
      delete process.env.AZURE_OPENAI_ENDPOINT;
      delete process.env.AZURE_OPENAI_API_KEY;
      openaiSeen.length = 0;
      anthropicSeen.length = 0;
      steps.length = 0;
      onOpenAiRequest.length = 0;
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
      vi.mocked(audit).mockReset();
    });

    afterEach(() => {
      setAIProviderForTests(null);
      for (const res of hanging.splice(0)) res.destroy();
      for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
      resetLocalConcurrencyLimitersForTests();
    });

    // ── #241 — the session's stored provider ────────────────────────────────

    it("#241 — every turn of a session under a project override runs on THAT provider (stream, chat, compact)", async () => {
      const session = await newSession(IDS.anth);
      expect(session.provider).toBe("anthropic");

      const first = await stream(session.id, "first question");
      expect(first.text).toContain("anthropic says hi");
      expect(first.text).toContain("event: done");
      const second = await stream(session.id, "second question");
      expect(second.text).toContain("event: done");
      const third = await chat(session.id, "third question");
      expect(third.status, third.text).toBe(200);
      expect(third.body.data.response.content).toBe("anthropic says hi");
      expect(third.body.data.response.provider).toBe("anthropic");
      const compacted = await post(`/api/ai/sessions/${session.id}/compact`);
      expect(compacted.status, compacted.text).toBe(200);
      expect(compacted.body.data.compacted).toBe(true);

      // Nothing reached the global provider.
      expect(openaiSeen).toHaveLength(0);
      // Three turns and at least one summary call, all on the project's provider,
      // with its model and its own credential.
      expect(anthropicSeen.length).toBeGreaterThanOrEqual(4);
      for (const s of anthropicSeen) {
        expect(s.path).toBe("/v1/messages");
        expect(s.body.model).toBe("claude-sonnet-4-6");
        expect(s.headers["x-api-key"]).toBe("k-anthropic");
      }
      // Multi-turn: the second turn carried the first from the server transcript.
      expect(JSON.stringify(anthropicSeen[1]!.body.messages)).toContain("first question");

      // The records agree with the wire.
      const rows = await db.aIMessage.findMany({
        where: { sessionId: session.id, role: "assistant", kind: "message" },
      });
      expect(rows.length).toBe(3);
      expect(rows.every((r) => r.provider === "anthropic")).toBe(true);
      await usageSettled();
      const perUser = await db.aITokenUsage.findMany({ where: { sessionId: session.id } });
      expect(perUser.length).toBeGreaterThan(0);
      expect(perUser.every((r) => r.provider === "anthropic")).toBe(true);
    });

    it("#283 — a provider-only override stores and sends THAT provider's default model, never the deployment's AI_MODEL", async () => {
      // The deployment pins AI_MODEL=gpt-4.1 for openai (beforeEach); the project
      // names only `anthropic`.
      process.env.ANTHROPIC_MODEL = "claude-anthropic-default";
      const session = await newSession(IDS.anthOnly);
      expect(session.provider).toBe("anthropic");
      expect((session as { model?: string }).model).toBe("claude-anthropic-default");

      expect((await chat(session.id, "hello")).status).toBe(200);
      expect(openaiSeen).toHaveLength(0);
      expect(anthropicSeen).toHaveLength(1);
      expect(anthropicSeen[0]!.body.model).toBe("claude-anthropic-default");
      const row = await db.aISession.findUniqueOrThrow({ where: { id: session.id } });
      expect(row.model).toBe("claude-anthropic-default");
    });

    it("#283 — a request model still wins over a provider-only override's default", async () => {
      const session = await newSession(IDS.anthOnly, { model: "claude-request-pick" });
      expect((session as { model?: string }).model).toBe("claude-request-pick");
    });

    it("#241 — a session with no override runs on the global provider", async () => {
      const session = await newSession(IDS.plain);
      expect(session.provider).toBe("openai");
      expect((await stream(session.id, "hello")).text).toContain("openai says hi");
      expect((await chat(session.id, "again")).status).toBe(200);
      expect(anthropicSeen).toHaveLength(0);
      expect(openaiSeen).toHaveLength(2);
      for (const s of openaiSeen) {
        expect(s.path).toBe("/v1/chat/completions");
        expect(s.headers.authorization).toBe("Bearer k-openai");
      }
    });

    it("#241 — a session whose provider this server cannot build is refused by name, never re-routed", async () => {
      const session = await newSession(IDS.azure);
      expect(session.provider).toBe("azure");
      for (const res of [
        await stream(session.id, "q"),
        await chat(session.id, "q"),
        await post(`/api/ai/sessions/${session.id}/compact`),
      ]) {
        expect(res.status, res.text).toBe(503);
        expect(res.body.error.message).toContain('"azure"');
        // The config loader's reason (which can name an endpoint URL or the
        // allowed-host list) goes to the server log, not to the chat user.
        expect(res.body.error.message).not.toContain("AZURE_OPENAI_ENDPOINT");
        expect(res.body.error.message).toContain("server log");
      }
      expect(openaiSeen).toHaveLength(0);
      expect(anthropicSeen).toHaveLength(0);
      // Refused before the question was persisted: nothing half-recorded.
      expect(await db.aIMessage.count({ where: { sessionId: session.id } })).toBe(0);
    });

    it("#241 / #149 — retired providers are still refused with 409, and reach no provider", async () => {
      const bound = await post("/api/ai/sessions", { projectId: IDS.retired });
      expect(bound.status).toBe(409);
      expect(bound.body.error.code).toBe("AI_PROVIDER_RETIRED");
      const stored = await db.aISession.create({
        data: { userId: IDS.alice, provider: "copilot-native", model: "gpt-4.1", policy: "{}" },
      });
      for (const res of [await stream(stored.id, "q"), await chat(stored.id, "q")]) {
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe("AI_SESSION_PROVIDER_RETIRED");
      }
      expect(openaiSeen).toHaveLength(0);
      expect(anthropicSeen).toHaveLength(0);
    });

    // ── #243 — failed turns still meter what they spent ─────────────────────

    async function usageRows(sessionId: string) {
      await usageSettled();
      return {
        perUser: await db.aITokenUsage.findMany({ where: { sessionId } }),
        project: await db.tokenUsage.findMany({ where: { sessionId } }),
      };
    }

    for (const route of ["/api/ai/chat", "/api/ai/stream"] as const) {
      it(`#243 ${route} — a tool turn whose SECOND model call fails meters the first call, once, in both stores`, async () => {
        const session = await newSession(IDS.plain);
        steps.push("tool", "fail");
        const res = await post(route, { sessionId: session.id, message: "count rows" });
        if (route === "/api/ai/chat") expect(res.status).toBeGreaterThanOrEqual(500);
        else expect(res.text).toContain("event: error");
        expect(openaiSeen).toHaveLength(2);
        expect(openaiSeen[0]!.body.tools).toBeDefined(); // the loop really ran

        const { perUser, project } = await usageRows(session.id);
        expect(perUser).toHaveLength(1);
        expect(perUser[0]).toMatchObject({
          provider: "openai",
          promptTokens: 5,
          completionTokens: 2,
          agentStep: FAILED_TURN_AGENT_STEP,
          projectId: IDS.plain,
        });
        expect(project).toHaveLength(1);
        expect(project[0]).toMatchObject({
          projectId: IDS.plain,
          provider: "openai",
          inputTokens: 5,
          outputTokens: 2,
        });
        // The failed turn is still in the transcript, marked incomplete.
        expect((await lastReply(session.id)).incomplete).toBeTruthy();
      });

      it(`#243 ${route} — a turn that fails before any usage was reported writes no usage row`, async () => {
        const session = await newSession(IDS.plain);
        steps.push("fail");
        await post(route, { sessionId: session.id, message: "count rows" });
        expect(openaiSeen).toHaveLength(1);
        const { perUser, project } = await usageRows(session.id);
        expect(perUser).toHaveLength(0);
        expect(project).toHaveLength(0);
      });

      it(`#243 ${route} — a failure after the success path metered the turn does not meter it again`, async () => {
        const session = await newSession(IDS.plain);
        // The audit write is the last step of both routes, after both usage writes.
        vi.mocked(audit).mockImplementation(() => {
          throw new Error("audit exploded");
        });
        await post(route, { sessionId: session.id, message: "hello" });
        const { perUser, project } = await usageRows(session.id);
        expect(perUser).toHaveLength(1);
        expect(perUser[0]!.agentStep).not.toBe(FAILED_TURN_AGENT_STEP);
        expect(project).toHaveLength(1);
      });
    }

    it("#243 /api/ai/stream — a stream that fails after its usage arrived meters it (no tools)", async () => {
      class UsageThenFail implements AIProvider {
        readonly key = "openai" as const;
        readonly model = "gpt-4.1";
        async chat(): Promise<never> {
          throw new Error("not used");
        }
        async *stream(): AsyncGenerator<ChatChunk> {
          yield { type: "delta", content: "partial" };
          yield {
            type: "usage",
            usage: { promptTokens: 40, completionTokens: 9, totalTokens: 49 },
          };
          throw new Error("connection reset after usage");
        }
        async embed() {
          return { vectors: [], dimension: 0, model: "x" };
        }
        async models() {
          return ["gpt-4.1"];
        }
        async ping() {
          return true;
        }
      }
      setAIProviderForTests(new UsageThenFail());
      const session = await newSession(); // unscoped, no skills: no tools
      const res = await stream(session.id, "q");
      expect(res.text).toContain("event: error");
      const { perUser, project } = await usageRows(session.id);
      expect(perUser).toHaveLength(1);
      expect(perUser[0]).toMatchObject({ promptTokens: 40, completionTokens: 9 });
      expect(project).toHaveLength(0); // unscoped: no project store
    });

    // ── #204 — queue time is not generation time ────────────────────────────

    function localProvider(): AIProvider {
      return new OpenAICompatibleProvider({
        baseUrl: `${openaiBase}/v1`,
        apiKey: "ollama",
        model: "gemma4:e4b",
        providerKey: "local-gemma",
        maxAttempts: 1,
      });
    }
    /** Take the local model's ONLY slot, as a long docs-gen generation would. */
    async function holdTheOnlySlot(): Promise<() => void> {
      process.env.LOCAL_GEMMA_MAX_CONCURRENCY = "1";
      resetLocalConcurrencyLimitersForTests();
      return localConcurrencyLimiter(`${openaiBase}/v1`).acquire();
    }
    const frames = (text: string, event: string) =>
      text
        .split("\n\n")
        .filter((f) => f.startsWith(`event: ${event}\n`))
        .map((f) => JSON.parse(f.slice(f.indexOf("data: ") + 6)) as Body);

    it("#204 — a turn queued behind the only local slot for longer than the hard ceiling still answers", async () => {
      process.env.AI_STREAM_MAX_DURATION_MS = "400";
      const release = await holdTheOnlySlot();
      setAIProviderForTests(localProvider());
      const session = await newSession();
      setTimeout(release, 900);
      const res = await stream(session.id, "hello");
      expect(res.text).not.toContain("STREAM_MAX_DURATION");
      expect(res.text).toContain("openai says hi");
      expect(res.text).toContain("event: done");
      const queue = frames(res.text, "queue");
      expect(queue[0]).toMatchObject({ type: "queue", state: "waiting", position: 1 });
      expect(queue[0]!.maxWaitMs).toBe(600_000);
      expect(queue[1]).toMatchObject({ type: "queue", state: "acquired" });
      expect(queue[1]!.waitedMs as number).toBeGreaterThanOrEqual(800);
      expect(openaiSeen).toHaveLength(1);
    });

    it("#204 — the hard ceiling still bounds generation once the slot is acquired", async () => {
      process.env.AI_STREAM_MAX_DURATION_MS = "400";
      process.env.AI_STREAM_IDLE_TIMEOUT_MS = "0";
      const release = await holdTheOnlySlot();
      setAIProviderForTests(localProvider());
      const session = await newSession();
      steps.push("hang");
      setTimeout(release, 600);
      const started = Date.now();
      const res = await stream(session.id, "hello");
      const elapsed = Date.now() - started;
      expect(frames(res.text, "error")[0]).toMatchObject({ code: "STREAM_MAX_DURATION" });
      // Queued ~600ms, then generation ran out its ~400ms budget.
      expect(elapsed).toBeGreaterThanOrEqual(950);
      expect(openaiSeen).toHaveLength(1);
    });

    it("#204 — the queue wait has its own limit: past it the turn ends, reported, and gives up its place", async () => {
      process.env.AI_STREAM_QUEUE_MAX_WAIT_MS = "300";
      const release = await holdTheOnlySlot();
      try {
        setAIProviderForTests(localProvider());
        const session = await newSession();
        const res = await stream(session.id, "hello");
        expect(frames(res.text, "queue")[0]).toMatchObject({ state: "waiting", maxWaitMs: 300 });
        const err = frames(res.text, "error")[0]!;
        expect(err.code).toBe("STREAM_QUEUE_TIMEOUT");
        expect(String(err.message)).toContain("local model was busy");
        // Never sent, and no longer queued behind the slot.
        expect(openaiSeen).toHaveLength(0);
        expect(localConcurrencyLimiter(`${openaiBase}/v1`).queued).toBe(0);
        expect((await lastReply(session.id)).incomplete).toMatchObject({
          code: "STREAM_QUEUE_TIMEOUT",
        });
      } finally {
        release();
      }
    });

    it("#204 — the local provider reports a queued wait on chat() too, then the acquisition", async () => {
      const release = await holdTheOnlySlot();
      const events: string[] = [];
      const call = localProvider().chat([{ role: "user", content: "hi" }], {
        onSlotQueued: (position) => events.push(`queued:${position}`),
        onSlotAcquired: () => events.push("acquired"),
      });
      await new Promise((r) => setTimeout(r, 50));
      expect(events).toEqual(["queued:1"]);
      release();
      expect((await call).content).toBe("openai says hi");
      expect(events).toEqual(["queued:1", "acquired"]);
    });

    // #204 on the TOOL paths — a project-scoped session offers tools, so its turn
    // runs through the tool loop (each model call its own slot), not the plain
    // stream. These are the turns #204 describes.

    it("#204 native tool loop — a project turn queued past the hard ceiling still answers, every call through the loop", async () => {
      process.env.AI_STREAM_MAX_DURATION_MS = "400";
      const release = await holdTheOnlySlot();
      setAIProviderForTests(localProvider());
      const session = await newSession(IDS.plain);
      steps.push("tool", "text");
      setTimeout(release, 900);
      const res = await stream(session.id, "count rows");
      expect(res.text).not.toContain("STREAM_MAX_DURATION");
      expect(res.text).toContain("openai says hi");
      expect(res.text).toContain("event: done");
      // The loop really ran natively: tools on the wire, a tool call, a second call.
      expect(openaiSeen).toHaveLength(2);
      expect(openaiSeen[0]!.body.tools).toBeDefined();
      expect(openaiSeen[0]!.body.stream).toBe(true);
      expect(res.text).toContain("event: tool_call");
      const queue = frames(res.text, "queue");
      expect(queue[0]).toMatchObject({ state: "waiting", position: 1 });
      expect(queue[1]).toMatchObject({ state: "acquired" });
      expect(queue[1]!.waitedMs as number).toBeGreaterThanOrEqual(800);
    });

    it("#204 native tool loop — once the slot is acquired the ceiling bounds generation again", async () => {
      process.env.AI_STREAM_MAX_DURATION_MS = "400";
      process.env.AI_STREAM_IDLE_TIMEOUT_MS = "0";
      process.env.AI_STREAM_QUEUE_MAX_WAIT_MS = "5000";
      const release = await holdTheOnlySlot();
      setAIProviderForTests(localProvider());
      const session = await newSession(IDS.plain);
      steps.push("hang");
      setTimeout(release, 600);
      const started = Date.now();
      const res = await stream(session.id, "count rows");
      const elapsed = Date.now() - started;
      expect(openaiSeen[0]!.body.tools).toBeDefined();
      expect(frames(res.text, "error")[0]).toMatchObject({ code: "STREAM_MAX_DURATION" });
      expect(elapsed).toBeGreaterThanOrEqual(950);
      expect(elapsed).toBeLessThan(4000);
    });

    it("#204 text-protocol tool loop — a queued chat() call is timed the same way", async () => {
      process.env.AI_STREAM_MAX_DURATION_MS = "400";
      process.env.AI_STREAM_QUEUE_MAX_WAIT_MS = "5000";
      process.env.CHAT_CODE_SEARCH_TOOLS = "true";
      // A local model the catalog says cannot call tools natively: the curated
      // code tools ride the text protocol, through non-streaming chat().
      class TextProtocolLocal extends OpenAICompatibleProvider {
        override capabilitiesFor(model: string) {
          return { ...super.capabilitiesFor(model), nativeToolCalls: false };
        }
      }
      const release = await holdTheOnlySlot();
      setAIProviderForTests(
        new TextProtocolLocal({
          baseUrl: `${openaiBase}/v1`,
          apiKey: "ollama",
          model: "gemma4:e4b",
          providerKey: "local-gemma",
          maxAttempts: 1,
        }),
      );
      const session = await newSession(IDS.plain);
      setTimeout(release, 900);
      const res = await stream(session.id, "hello");
      expect(res.text).not.toContain("STREAM_MAX_DURATION");
      expect(res.text).toContain("openai says hi");
      expect(res.text).toContain("event: done");
      expect(openaiSeen).toHaveLength(1);
      // Text protocol: no native tools on the wire, the schemas in the prompt.
      expect(openaiSeen[0]!.body.tools).toBeUndefined();
      expect(openaiSeen[0]!.body.stream).not.toBe(true);
      expect(JSON.stringify(openaiSeen[0]!.body.messages)).toContain("search_code_graph");
      const queue = frames(res.text, "queue");
      expect(queue.map((q) => q.state)).toEqual(["waiting", "acquired"]);
    });

    it("#204 sub-agent — a sub-agent call queued behind the only slot does not count against the ceiling", async () => {
      process.env.AI_STREAM_MAX_DURATION_MS = "400";
      process.env.AI_STREAM_QUEUE_MAX_WAIT_MS = "5000";
      process.env.LOCAL_GEMMA_MAX_CONCURRENCY = "1";
      resetLocalConcurrencyLimitersForTests();
      setAIProviderForTests(localProvider());
      const session = await newSession(IDS.delegating, { policy: { medium: "auto" } });
      // The parent's first call runs at once and delegates. While it holds the
      // slot, other work queues for it — so the sub-agent's call waits ~900ms.
      onOpenAiRequest.push(() => {
        void localConcurrencyLimiter(`${openaiBase}/v1`)
          .acquire()
          .then((release) => setTimeout(release, 900));
      });
      steps.push("delegate", "text", "text");
      const res = await stream(session.id, "count rows via the counter");
      expect(res.text).not.toContain("STREAM_MAX_DURATION");
      expect(res.text).toContain("event: done");
      expect(openaiSeen).toHaveLength(3);
      const delegated = (openaiSeen[0]!.body.tools as Array<{ function: { name: string } }>).find(
        (t) => t.function.name.startsWith("agent_"),
      );
      expect(delegated).toBeDefined();
      // The sub-agent's own request: its system prompt, not the parent's.
      expect(JSON.stringify(openaiSeen[1]!.body.messages)).toContain("You count rows.");
      const queue = frames(res.text, "queue");
      expect(queue.map((q) => q.state)).toEqual(["waiting", "acquired"]);
      expect(queue[1]!.waitedMs as number).toBeGreaterThanOrEqual(800);
    });
  },
);
