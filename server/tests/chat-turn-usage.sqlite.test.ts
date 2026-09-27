/**
 * #137 — every chat turn records REAL usage: what the provider reported
 * (cache reads/writes included), in the transcript and in BOTH usage stores,
 * once each; and a documented estimate only when the provider reported nothing.
 *
 * REAL provider classes (`openai` → OpenAICompatibleProvider, `anthropic` →
 * AnthropicProvider) talking to loopback HTTP servers, through the real routes,
 * over a real SQLite database built by the migration chain. Multi-turn: every
 * scenario runs a /stream turn and a /chat turn on one session.
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
import type { ToolDefinition } from "../src/lib/ai/types.js";

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
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { getTokenTracker } = await import("../src/lib/ai/token-tracker.js");
const { getPendingUsageWrites, canonicalTokenCounts } =
  await import("../src/lib/finops/token-tracker.js");
const { __resetToolRegistrySingleton, getToolRegistry } =
  await import("../src/lib/ai/tool-registry.js");
const { __resetToolApprovalBroker } = await import("../src/lib/ai/tool-runtime/approval-broker.js");
const { resetLocalConcurrencyLimitersForTests } =
  await import("../src/lib/ai/providers/local-concurrency-limiter.js");
const { __resetModelCatalogForTests } = await import("../src/lib/ai/model-catalog.js");
const { ESTIMATED_TURN_AGENT_STEP } = await import("../src/lib/ai/conversation/turn-usage.js");
const { nativeToolChars } = await import("../src/lib/ai/conversation/turn.js");

type Body = Record<string, unknown>;
const ALICE = "u-alice";
const PLAIN = "p-plain";
const ANTH = "p-anth";
const REPLY = "openai says hi";

/** What the OpenAI-shaped server reports as usage. */
let usageMode: "reported" | "none" = "reported";
const OPENAI_USAGE = {
  prompt_tokens: 120,
  prompt_tokens_details: { cached_tokens: 100 },
  completion_tokens: 7,
  total_tokens: 127,
};

function readBody(req: IncomingMessage): Promise<Body> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
    req.on("end", () => resolve(raw ? (JSON.parse(raw) as Body) : {}));
  });
}

function openAiReply(res: ServerResponse, body: Body): void {
  const usage = usageMode === "reported" ? { usage: OPENAI_USAGE } : {};
  if (body.stream !== true) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "c1",
        object: "chat.completion",
        model: "gpt-4.1",
        choices: [
          { index: 0, message: { role: "assistant", content: REPLY }, finish_reason: "stop" },
        ],
        ...usage,
      }),
    );
    return;
  }
  const chunk = (d: Body) => `data: ${JSON.stringify(d)}\n\n`;
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(
    chunk({ id: "c1", choices: [{ index: 0, delta: { content: REPLY }, finish_reason: null }] }) +
      chunk({ id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
      (usageMode === "reported" ? chunk({ id: "c1", choices: [], ...usage }) : "") +
      "data: [DONE]\n\n",
  );
}

/** Anthropic reports cache reads and writes BESIDE input_tokens. */
const ANTHROPIC_USAGE = {
  input_tokens: 11,
  cache_read_input_tokens: 50,
  cache_creation_input_tokens: 20,
  output_tokens: 3,
};

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
        usage: ANTHROPIC_USAGE,
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
        usage: { ...ANTHROPIC_USAGE, output_tokens: 1 },
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

async function usageSettled(): Promise<void> {
  for (let i = 0; i < 200 && (getTokenTracker().inFlight > 0 || getPendingUsageWrites() > 0); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#137 — real per-turn usage, real providers on loopback",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let alice: string;
    let openaiServer: Server;
    let anthropicServer: Server;
    let openaiBase = "";
    let anthropicBase = "";
    const openaiSeen: Body[] = [];
    const ENV_KEYS = [
      "AI_OFFLINE",
      "AI_PROVIDER",
      "AI_MODEL",
      "OPENAI_BASE_URL",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_BASE_URL",
      "CHAT_TOOLS",
    ];
    const savedEnv: Record<string, string | undefined> = {};

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/ai", aiRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const post = (url: string, body: object = {}) =>
      request(app()).post(url).set("Authorization", `Bearer ${alice}`).send(body);
    async function newSession(projectId: string): Promise<string> {
      const res = await post("/api/ai/sessions", { projectId });
      expect(res.status, res.text).toBe(201);
      return (res.body.data.session as { id: string }).id;
    }
    /** One /stream turn then one /chat turn on the same session. */
    async function twoTurns(sessionId: string): Promise<void> {
      const s = await post("/api/ai/stream", { sessionId, message: "first question" });
      expect(s.text).toContain("event: done");
      const c = await post("/api/ai/chat", { sessionId, message: "second question" });
      expect(c.status, c.text).toBe(200);
    }
    async function records(sessionId: string) {
      await usageSettled();
      return {
        replies: await db.aIMessage.findMany({
          where: { sessionId, role: "assistant", kind: "message" },
          orderBy: { ordinal: "asc" },
        }),
        perUser: await db.aITokenUsage.findMany({ where: { sessionId }, orderBy: { ts: "asc" } }),
        project: await db.tokenUsage.findMany({
          where: { sessionId },
          orderBy: { createdAt: "asc" },
        }),
      };
    }

    beforeAll(async () => {
      sqlite = createMigratedSqlite("b5-usage");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: ALICE, username: "alice", displayName: "alice", email: "a@example.test" },
      });
      await db.project.create({
        data: { id: PLAIN, name: PLAIN, slug: PLAIN, createdById: ALICE },
      });
      await db.project.create({
        data: {
          id: ANTH,
          name: ANTH,
          slug: ANTH,
          createdById: ALICE,
          aiProviderId: "anthropic",
          aiModel: "claude-sonnet-4-6",
        },
      });
      alice = issueTokens({
        userId: ALICE,
        username: "alice",
        role: "developer",
        permissions: [],
      }).accessToken;
      openaiServer = createServer((req, res) => {
        void readBody(req).then((body) => {
          openaiSeen.push(body);
          openAiReply(res, body);
        });
      });
      anthropicServer = createServer((req, res) => {
        void readBody(req).then((body) => anthropicReply(res, body.stream === true));
      });
      await new Promise<void>((r) => openaiServer.listen(0, "127.0.0.1", () => r()));
      await new Promise<void>((r) => anthropicServer.listen(0, "127.0.0.1", () => r()));
      openaiBase = `http://127.0.0.1:${(openaiServer.address() as AddressInfo).port}`;
      anthropicBase = `http://127.0.0.1:${(anthropicServer.address() as AddressInfo).port}`;
      for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      openaiServer.closeAllConnections();
      anthropicServer.closeAllConnections();
      await new Promise<void>((r) => openaiServer.close(() => r()));
      await new Promise<void>((r) => anthropicServer.close(() => r()));
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(() => {
      delete process.env.AI_OFFLINE;
      process.env.AI_PROVIDER = "openai";
      process.env.AI_MODEL = "gpt-4.1";
      process.env.OPENAI_BASE_URL = `${openaiBase}/v1`;
      process.env.OPENAI_API_KEY = "k-openai";
      process.env.ANTHROPIC_API_KEY = "k-anthropic";
      process.env.ANTHROPIC_BASE_URL = anthropicBase;
      delete process.env.CHAT_TOOLS;
      usageMode = "reported";
      openaiSeen.length = 0;
      __resetModelCatalogForTests();
      __resetToolRegistrySingleton();
      __resetToolApprovalBroker();
      getToolRegistry().register({
        name: "count_rows",
        description: "Count the rows of one table in the project's database.",
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
      resetLocalConcurrencyLimitersForTests();
    });

    it("OpenAI-compatible: the reported usage, cache reads included, lands once per turn in all three records", async () => {
      const session = await newSession(PLAIN);
      await twoTurns(session);
      const { replies, perUser, project } = await records(session);

      expect(replies).toHaveLength(2);
      for (const r of replies) {
        expect(r).toMatchObject({ inputTokens: 120, outputTokens: 7, cacheReadTokens: 100 });
      }
      // One row per turn in each store — never two.
      expect(perUser).toHaveLength(2);
      expect(project).toHaveLength(2);
      for (const u of perUser) {
        expect(u).toMatchObject({ promptTokens: 120, completionTokens: 7, cacheReadTokens: 100 });
        expect(u.agentStep).not.toBe(ESTIMATED_TURN_AGENT_STEP);
      }
      for (const p of project) {
        expect(p).toMatchObject({ inputTokens: 120, outputTokens: 7, cacheReadTokens: 100 });
        // prompt_tokens INCLUDES the 100 cached: counted once, not 220.
        expect(p.totalTokens).toBe(127);
      }
    });

    it("Anthropic: cache reads and writes are recorded, and the context size counts them", async () => {
      const session = await newSession(ANTH);
      await twoTurns(session);
      const { replies, perUser, project } = await records(session);

      expect(replies).toHaveLength(2);
      for (const r of replies) {
        // input_tokens EXCLUDES the cache fields: the prompt occupied 11 + 50 + 20.
        expect(r).toMatchObject({
          inputTokens: 81,
          outputTokens: 3,
          cacheReadTokens: 50,
          cacheWriteTokens: 20,
        });
      }
      expect(perUser).toHaveLength(2);
      expect(project).toHaveLength(2);
      for (const p of project) {
        expect(p).toMatchObject({
          inputTokens: 11,
          cacheReadTokens: 50,
          cacheWriteTokens: 20,
          outputTokens: 3,
        });
        expect(p.totalTokens).toBe(84);
      }
      // The two stores agree on the turn once made canonical.
      for (const u of perUser) {
        expect(
          canonicalTokenCounts("anthropic", {
            inputTokens: u.promptTokens,
            outputTokens: u.completionTokens,
            cacheReadTokens: u.cacheReadTokens,
            cacheWriteTokens: u.cacheWriteTokens,
          }).totalTokens,
        ).toBe(84);
      }
    });

    for (const tools of ["native tools", "no tools"] as const) {
      it(`a provider that reports NO usage is metered on the documented estimate, once per store, marked (${tools})`, async () => {
        usageMode = "none";
        // Without tools a turn is a single plain call, not the tool loop.
        if (tools === "no tools") process.env.CHAT_TOOLS = "false";
        const session = await newSession(PLAIN);
        await twoTurns(session);
        const { replies, perUser, project } = await records(session);

        // The transcript keeps ONLY reported numbers — an estimate never calibrates.
        expect(replies).toHaveLength(2);
        for (const r of replies) {
          expect(r.inputTokens).toBeNull();
          expect(r.outputTokens).toBeNull();
        }
        expect(perUser).toHaveLength(2);
        expect(project).toHaveLength(2);
        for (const [i, u] of perUser.entries()) {
          expect(u.agentStep).toBe(ESTIMATED_TURN_AGENT_STEP);
          expect(u.promptTokens).toBeGreaterThan(0);
          // The reply's characters at the session's default ratio (3 chars/token).
          expect(u.completionTokens).toBe(Math.ceil(REPLY.length / 3));
          expect(u.cacheReadTokens).toBe(0);
          // Both stores hold the same estimate for the same turn.
          expect(project[i]).toMatchObject({
            inputTokens: u.promptTokens,
            outputTokens: u.completionTokens,
            cacheReadTokens: 0,
          });
        }
        expect(openaiSeen.every((b) => (b.tools === undefined) === (tools === "no tools"))).toBe(
          true,
        );
      });
    }

    it("the prompt size stored for calibration includes natively-sent tool specs", async () => {
      const session = await newSession(PLAIN);
      await twoTurns(session);
      const { replies } = await records(session);
      expect(openaiSeen).toHaveLength(2);
      for (const [i, body] of openaiSeen.entries()) {
        const tools = body.tools as Array<{ function: Body }> | undefined;
        expect(tools?.length).toBeGreaterThan(0);
        const messageChars = (body.messages as Array<{ content: unknown }>).reduce(
          (n, m) => n + (typeof m.content === "string" ? m.content.length : 0),
          0,
        );
        const toolChars = nativeToolChars(tools!.map((t) => t.function) as never);
        expect(toolChars).toBeGreaterThan(0);
        expect(replies[i]!.promptChars).toBe(messageChars + toolChars);
      }
    });
  },
);
