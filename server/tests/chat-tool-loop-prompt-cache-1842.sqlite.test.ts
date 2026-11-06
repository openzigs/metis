/**
 * #1842 — a chat tool loop caches its growing transcript, and every model
 * call's cache reads and writes reach the ledger.
 *
 * The real `/api/ai/chat` and `/api/ai/stream` routes run a three-call tool
 * loop on the REAL Anthropic provider; only the SDK underneath is a double, so
 * the requests asserted here are the ones the provider would put on the wire.
 * Each call reports its own `cache_read_input_tokens` and
 * `cache_creation_input_tokens`, and the test reads them back through the
 * paths a consumer uses: the ledger row's per-request list
 * (`ledgerRowSummedRequests`), the cache-savings report over that row, and the
 * #699 in-process cache-hit aggregator — not only a log line.
 *
 * Runs over a real SQLite database built by the real migration chain.
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
import type { ToolDefinition } from "../src/lib/ai/types.js";
import type { Mock } from "vitest";

/** The fake SDK's `messages.create` / `messages.stream`. */
type SdkMock = Mock<(...args: unknown[]) => unknown>;

const state = vi.hoisted(() => {
  process.env.AI_RATE_LIMIT_MAX = "10000";
  return {
    db: null as unknown,
    create: null as unknown as SdkMock,
    stream: null as unknown as SdkMock,
  };
});
vi.mock("@anthropic-ai/sdk", async () => {
  const { vi: v } = await import("vitest");
  state.create = v.fn();
  state.stream = v.fn();
  class FakeAnthropic {
    messages = {
      create: (...a: unknown[]) => state.create(...a),
      stream: (...a: unknown[]) => state.stream(...a),
    };
    models = { list: v.fn() };
    constructor(_opts: unknown) {
      /* no network */
    }
  }
  return { default: FakeAnthropic };
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
const { ledgerRowSummedRequests } = await import("../src/lib/finops/summed-requests.js");
const { summarizeCacheSavings } = await import("../src/lib/finops/cache-savings-report.js");
const { getCacheHitAggregator, __resetCacheHitAggregatorSingleton } =
  await import("../src/lib/ai/cache-hit-telemetry.js");
const { AnthropicProvider } = await import("../src/lib/ai/providers/anthropic-provider.js");
const { __resetToolRegistrySingleton, getToolRegistry } =
  await import("../src/lib/ai/tool-registry.js");
const { __resetToolApprovalBroker } = await import("../src/lib/ai/tool-runtime/approval-broker.js");
const { __resetModelCatalogForTests } = await import("../src/lib/ai/model-catalog.js");

const ALICE = "u-alice";
const SONNET = "claude-sonnet-5-5";

/** Per call: fresh input, output, cache read, cache write — distinct so a mix-up shows. */
const CALLS = [
  { input: 50, output: 10, read: 1_500, write: 300 },
  { input: 40, output: 11, read: 1_800, write: 400 },
  { input: 30, output: 20, read: 2_200, write: 250 },
] as const;
const usageOf = (c: (typeof CALLS)[number]) => ({
  input_tokens: c.input,
  output_tokens: c.output,
  cache_read_input_tokens: c.read,
  cache_creation_input_tokens: c.write,
});

/** The SDK's reply to call `i` (0-based): two tool rounds, then the answer. */
function reply(i: number) {
  const tool = i < CALLS.length - 1;
  return {
    content: tool
      ? [{ type: "tool_use", id: `toolu_${i + 1}`, name: "count_rows", input: { table: "t" } }]
      : [{ type: "text", text: "seven rows" }],
    model: SONNET,
    stop_reason: tool ? "tool_use" : "end_turn",
    usage: usageOf(CALLS[i]!),
  };
}

type Block = Record<string, unknown> & { cache_control?: unknown };
type Sent = {
  messages: Array<{ role: string; content: string | Block[] }>;
  cache_control?: unknown;
};

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1842 — the chat tool loop's prompt cache, on the wire and in the ledger",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let alice: string;
    let seq = 0;
    let sent: Sent[] = [];
    const savedEnv: Record<string, string | undefined> = {};
    const ENV_KEYS = [
      "AI_OFFLINE",
      "AI_PROVIDER",
      "AI_MODEL",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_BASE_URL_BILLS_AS",
      "ANTHROPIC_MODEL",
      "ANTHROPIC_PROMPT_CACHE_TTL",
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

    async function newSession(): Promise<{ projectId: string; sessionId: string }> {
      const projectId = `p-${++seq}`;
      await db.project.create({
        data: {
          id: projectId,
          name: projectId,
          slug: projectId,
          createdById: ALICE,
          aiProviderId: "anthropic",
          aiModel: SONNET,
        },
      });
      const res = await post("/api/ai/sessions", { projectId });
      expect(res.status, res.text).toBe(201);
      return { projectId, sessionId: (res.body.data.session as { id: string }).id };
    }
    async function ledgerRow(sessionId: string) {
      for (
        let i = 0;
        i < 200 && (getTokenTracker().inFlight > 0 || getPendingUsageWrites() > 0);
        i++
      ) {
        await new Promise((r) => setTimeout(r, 5));
      }
      const rows = await db.tokenUsage.findMany({ where: { sessionId } });
      expect(rows).toHaveLength(1);
      return rows[0]!;
    }

    beforeAll(async () => {
      sqlite = createMigratedSqlite("chat-tool-loop-cache-1842");
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
      delete process.env.AI_OFFLINE;
      process.env.AI_PROVIDER = "anthropic";
      process.env.ANTHROPIC_API_KEY = "placeholder-not-a-key";
      for (const k of ENV_KEYS.slice(2)) if (k !== "ANTHROPIC_API_KEY") delete process.env[k];
      __resetModelCatalogForTests();
      __resetToolRegistrySingleton();
      __resetToolApprovalBroker();
      __resetCacheHitAggregatorSingleton();
      getToolRegistry().register({
        name: "count_rows",
        description: "Count rows",
        schema: z.object({ table: z.string() }),
        risk: "low",
        exec: async () => ({ text: "rows: 7" }),
      } as ToolDefinition);
      sent = [];
      let n = 0;
      const record = (params: unknown) => sent.push(JSON.parse(JSON.stringify(params)) as Sent);
      state.create.mockReset();
      state.create.mockImplementation(async (params: unknown) => {
        record(params);
        return reply(n++);
      });
      state.stream.mockReset();
      state.stream.mockImplementation((params: unknown) => {
        record(params);
        const final = reply(n++);
        return {
          controller: { abort: () => undefined },
          async *[Symbol.asyncIterator]() {
            const text = final.content[0] as { type: string; text?: string };
            if (text.type === "text") {
              yield { type: "content_block_delta", delta: { type: "text_delta", text: text.text } };
            }
          },
          finalMessage: async () => final,
        };
      });
      setAIProviderForTests(new AnthropicProvider({ apiKey: "k", model: SONNET }));
    });

    afterEach(() => {
      setAIProviderForTests(null);
      for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
    });

    for (const route of ["/api/ai/chat", "/api/ai/stream"] as const) {
      it(`${route}: calls two and three carry a breakpoint after the previous turn's tool results`, async () => {
        const { sessionId } = await newSession();
        const res = await post(route, { sessionId, message: "how many rows?" });
        if (route === "/api/ai/chat") expect(res.status, res.text).toBe(200);
        else expect(res.text).toContain("event: done");
        expect(sent).toHaveLength(3);

        for (const [i, body] of sent.entries()) {
          expect(body.cache_control).toBeUndefined();
          const last = body.messages.at(-1)!;
          expect(last.role).toBe("user");
          const lastBlock = (last.content as Block[]).at(-1)!;
          expect(lastBlock.cache_control).toEqual({ type: "ephemeral" });
          if (i > 0) {
            // The newest tool result carries it — the one answering call i's request.
            expect(lastBlock).toMatchObject({ type: "tool_result", tool_use_id: `toolu_${i}` });
            // The previous call's marked turn is re-sent, now unmarked.
            const prevMarked = sent[i - 1]!.messages.length - 1;
            const resent = body.messages[prevMarked]!;
            const blocks = typeof resent.content === "string" ? [] : resent.content;
            expect(blocks.every((b) => b.cache_control === undefined)).toBe(true);
          }
        }
      });

      it(`${route}: every call's cache reads and writes are persisted and read back`, async () => {
        const { sessionId } = await newSession();
        const res = await post(route, { sessionId, message: "how many rows?" });
        if (route === "/api/ai/chat") expect(res.status, res.text).toBe(200);
        else expect(res.text).toContain("event: done");

        const row = await ledgerRow(sessionId);
        const sum = (k: "input" | "output" | "read" | "write") =>
          CALLS.reduce((n, c) => n + c[k], 0);
        expect(row).toMatchObject({
          agentStep: "chat",
          inputTokens: sum("input"),
          outputTokens: sum("output"),
          cacheReadTokens: sum("read"),
          cacheWriteTokens: sum("write"),
        });
        // Per tool-loop call, through the reader the cost paths use (#1080).
        expect(ledgerRowSummedRequests(row)).toEqual(
          CALLS.map((c) => ({
            inputTokens: c.input,
            outputTokens: c.output,
            cacheReadTokens: c.read,
            cacheWriteTokens: c.write,
          })),
        );
        // The cache-savings report (#1277) over the stored row.
        const [line] = summarizeCacheSavings([row]);
        expect(line).toMatchObject({
          agentStep: "chat",
          cacheReadTokens: sum("read"),
          cacheWriteTokens: sum("write"),
        });
        // The #699 aggregator behind GET /api/admin/cache-telemetry: one sample per call.
        expect(getCacheHitAggregator().snapshot("chat", SONNET)).toMatchObject({
          calls: 3,
          sumCacheReadTokens: sum("read"),
          sumCacheWriteTokens: sum("write"),
        });
      });
    }
  },
);
