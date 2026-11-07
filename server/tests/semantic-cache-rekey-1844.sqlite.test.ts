/**
 * #1844 — the semantic answer cache on the real `/api/ai/chat` route, switched
 * on as a trial would switch it on: an answer stored before a re-ingest is not
 * served after it, and a turn that called a tool is never stored.
 *
 * A project-scoped session over a real SQLite database built by the real
 * migration chain; the provider is a scripted double that counts its calls,
 * so "served from the cache" means the model was not called.
 *
 * #1865 — also: a content change during the turn (during retrieval, or during
 * the model call) keeps the answer out of the cache; a second user asking the
 * same question misses; and an exact repeat is served without embedding.
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
  return {
    db: null as unknown,
    /** #1865 — run once, inside the next auto-RAG search. */
    duringSearch: null as null | (() => Promise<void>),
  };
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
  getKnowledgeService: () => ({
    search: async () => {
      const hook = state.duringSearch;
      state.duringSearch = null;
      await hook?.();
      return { hits: [] };
    },
  }),
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
const BOB = "u-bob";
const WORKSPACE = "ws-1865";
const SONNET = "claude-sonnet-5-5";
const QUESTION = "Which files handle refunds?";

/** Answers every call, counting them; calls `count_rows` first when `callTool` is set. */
class CountingProvider implements AIProvider {
  readonly key = "anthropic" as const;
  readonly offline = false;
  readonly capabilities = { responseFormat: false, nativeToolCalls: true };
  readonly model = SONNET;
  calls = 0;
  embeds = 0;
  answer = "billing/refunds.go";
  callTool = false;
  /** #1865 — run once, inside the next model call. */
  duringChat: null | (() => Promise<void>) = null;
  private toolCalled = false;

  async chat(): Promise<ChatResponse> {
    this.calls += 1;
    const hook = this.duringChat;
    this.duringChat = null;
    await hook?.();
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
    this.embeds += 1;
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
    let bob: string;
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
    const post = (url: string, body: object = {}, token = alice) =>
      request(app()).post(url).set("Authorization", `Bearer ${token}`).send(body);

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
          workspaceId: WORKSPACE,
        },
      });
      const repo = await db.repoConnection.create({ data: { projectId, label: "r" } });
      const graph = await db.codeGraph.create({
        data: { projectId, repoConnectionId: repo.id, commitSha: sha, lastIndexedAt: new Date() },
      });
      return { projectId, graphId: graph.id };
    }
    async function ask(projectId: string, token = alice) {
      const s = await post("/api/ai/sessions", { projectId }, token);
      expect(s.status, s.text).toBe(201);
      const res = await post(
        "/api/ai/chat",
        { sessionId: (s.body.data.session as { id: string }).id, message: QUESTION },
        token,
      );
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
      await db.user.create({
        data: { id: BOB, username: "bob", displayName: "bob", email: "b@example.test" },
      });
      // #1865 — one workspace both users belong to, so Bob can open the project too.
      await db.workspace.create({ data: { id: WORKSPACE, name: "WS", slug: "ws-1865" } });
      for (const userId of [ALICE, BOB]) {
        await db.workspaceMember.create({ data: { workspaceId: WORKSPACE, userId } });
      }
      const token = (userId: string, username: string) =>
        issueTokens({
          userId,
          username,
          role: "developer",
          permissions: [],
          workspaces: [WORKSPACE],
        }).accessToken;
      alice = token(ALICE, "alice");
      bob = token(BOB, "bob");
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
      state.duringSearch = null;
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

    it("#1865 an exact repeat is served without embedding the question", async () => {
      const { projectId } = await project("a".repeat(40));
      await ask(projectId);
      expect(provider.embeds).toBe(1);
      const second = await ask(projectId);
      expect(second.cached).toBe(true);
      expect(provider.embeds).toBe(1);
    });

    it("#1865 another user asking the same question on the same project misses", async () => {
      const { projectId } = await project("a".repeat(40));
      const first = await ask(projectId);
      const forBob = await ask(projectId, bob);
      expect(forBob.cached).toBeUndefined();
      expect(forBob.content).not.toBe(first.content);
      expect(provider.calls).toBe(2);
      // Each user's own repeat is still served: the miss was the caller, nothing else.
      expect((await ask(projectId)).cached).toBe(true);
      expect((await ask(projectId, bob)).cached).toBe(true);
      expect(provider.calls).toBe(2);
    });

    // A re-ingest that finishes while the turn runs: the answer may rest on the old code.
    const reingest = (graphId: string) => async () => {
      await db.codeGraph.update({
        where: { id: graphId },
        data: { commitSha: "b".repeat(40), lastIndexedAt: new Date(Date.now() + 1_000) },
      });
    };

    // The pre-store re-check: a version can come back (a document uploaded and
    // removed again leaves the same version), so an answer given while the
    // upload was there must not be stored under the version from before it.
    it("#1865 an answer given while a document briefly existed is not served once it is gone", async () => {
      const { projectId } = await project("a".repeat(40));
      let doc = "";
      provider.duringChat = async () => {
        const d = await db.document.create({
          data: {
            projectId,
            filename: "refund-approvals.md",
            mimeType: "text/markdown",
            sizeBytes: 1,
            storagePath: "/refund-approvals.md",
            checksum: "sum",
            uploadedById: ALICE,
          },
        });
        doc = d.id;
      };
      await ask(projectId);
      await db.document.delete({ where: { id: doc } });
      const second = await ask(projectId);
      expect(second.cached).toBeUndefined();
      expect(provider.calls).toBe(2);
    });

    it("#1865 an answer is not stored when the content changes during auto-RAG retrieval", async () => {
      const { projectId, graphId } = await project("a".repeat(40));
      state.duringSearch = reingest(graphId);
      await ask(projectId);
      expect(state.duringSearch).toBeNull(); // retrieval ran, and the change landed in it
      const second = await ask(projectId);
      expect(second.cached).toBeUndefined();
      expect(provider.calls).toBe(2);
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
