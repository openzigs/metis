/**
 * #1844 — the semantic answer cache on the real `/api/ai/chat` route, switched
 * on as a trial would switch it on: an answer stored before a re-ingest is not
 * served after it, and a turn that called a tool is never stored.
 *
 * A project-scoped session over a real SQLite database built by the real
 * migration chain; the provider is a scripted double that counts its calls,
 * so "served from the cache" means the model was not called.
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
const { __resetSemanticCacheSingleton } = await import("../src/lib/ai/semantic-cache.js");
const { __resetToolRegistrySingleton, getToolRegistry } =
  await import("../src/lib/ai/tool-registry.js");
const { __resetToolApprovalBroker } = await import("../src/lib/ai/tool-runtime/approval-broker.js");
const { __resetModelCatalogForTests } = await import("../src/lib/ai/model-catalog.js");

const ALICE = "u-alice";
const SONNET = "claude-sonnet-5-5";
const QUESTION = "Which files handle refunds?";

/** Answers every call, counting them; calls `count_rows` first when `callTool` is set. */
class CountingProvider implements AIProvider {
  readonly key = "anthropic" as const;
  readonly offline = false;
  readonly capabilities = { responseFormat: false, nativeToolCalls: true };
  readonly model = SONNET;
  calls = 0;
  answer = "billing/refunds.go";
  callTool = false;
  private toolCalled = false;

  async chat(): Promise<ChatResponse> {
    this.calls += 1;
    const tool = this.callTool && !this.toolCalled;
    if (tool) this.toolCalled = true;
    return {
      content: tool ? "" : `${this.answer} (call ${this.calls})`,
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
      model: SONNET,
      provider: this.key,
      finishReason: tool ? "tool_use" : "end_turn",
      ...(tool
        ? { toolCalls: [{ id: `call_${this.calls}`, name: "count_rows", args: { table: "t" } }] }
        : {}),
    };
  }
  async *stream(): AsyncGenerator<ChatChunk> {
    throw new Error("not used");
  }
  async embed() {
    return { vectors: [[1, 0, 0]], dimension: 3, model: "e" };
  }
  async models() {
    return [SONNET];
  }
  async ping() {
    return true;
  }
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1844 — the semantic answer cache, keyed on the content version",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let alice: string;
    let seq = 0;
    let provider: CountingProvider;
    const savedEnv: Record<string, string | undefined> = {};
    const ENV_KEYS = ["AI_OFFLINE", "AI_PROVIDER", "ANTHROPIC_API_KEY", "SEMANTIC_CACHE_ENABLED"];

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

    /** A project whose one repository graph finished at `sha`. */
    async function project(sha: string): Promise<{ projectId: string; graphId: string }> {
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
      const repo = await db.repoConnection.create({ data: { projectId, label: "r" } });
      const graph = await db.codeGraph.create({
        data: { projectId, repoConnectionId: repo.id, commitSha: sha, lastIndexedAt: new Date() },
      });
      return { projectId, graphId: graph.id };
    }
    async function ask(projectId: string) {
      const s = await post("/api/ai/sessions", { projectId });
      expect(s.status, s.text).toBe(201);
      const res = await post("/api/ai/chat", {
        sessionId: (s.body.data.session as { id: string }).id,
        message: QUESTION,
      });
      expect(res.status, res.text).toBe(200);
      return res.body.data.response as { content: string; cached?: boolean };
    }

    beforeAll(async () => {
      sqlite = createMigratedSqlite("semantic-cache-1844");
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
      process.env.SEMANTIC_CACHE_ENABLED = "1";
      __resetSemanticCacheSingleton();
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
      provider = new CountingProvider();
      setAIProviderForTests(provider);
    });

    afterEach(() => {
      setAIProviderForTests(null);
      __resetSemanticCacheSingleton();
      for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
    });

    it("control: the same question in a fresh session on unchanged content is served from the cache", async () => {
      const { projectId } = await project("a".repeat(40));
      const first = await ask(projectId);
      const second = await ask(projectId);
      expect(second.cached).toBe(true);
      expect(second.content).toBe(first.content);
      expect(provider.calls).toBe(1);
    });

    it("an answer stored before a re-ingest is not served after it", async () => {
      const { projectId, graphId } = await project("a".repeat(40));
      const before = await ask(projectId);
      expect(before.content).toBe("billing/refunds.go (call 1)");

      // The re-ingest finishes on a new commit, and the code now says otherwise.
      await db.codeGraph.update({
        where: { id: graphId },
        data: { commitSha: "b".repeat(40), lastIndexedAt: new Date(Date.now() + 1_000) },
      });
      provider.answer = "billing/refund-approvals.go";

      const after = await ask(projectId);
      expect(after.cached).toBeUndefined();
      expect(after.content).toBe("billing/refund-approvals.go (call 2)");
      expect(provider.calls).toBe(2);
    });

    it("a turn whose answer used a tool is never stored", async () => {
      const { projectId } = await project("a".repeat(40));
      provider.callTool = true;
      const first = await ask(projectId);
      expect(provider.calls).toBe(2); // the tool call, then the answer
      expect(first.content).toContain("billing/refunds.go");

      const second = await ask(projectId);
      expect(second.cached).toBeUndefined();
      expect(provider.calls).toBe(3);
    });

    it("a project whose graph has no commit SHA is neither looked up nor stored", async () => {
      const { projectId, graphId } = await project("a".repeat(40));
      await db.codeGraph.update({ where: { id: graphId }, data: { commitSha: null } });
      await ask(projectId);
      const second = await ask(projectId);
      expect(second.cached).toBeUndefined();
      expect(provider.calls).toBe(2);
    });
  },
);
