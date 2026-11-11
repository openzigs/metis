/**
 * #2238 — a chat scoped to several products (or a workspace) searches all of
 * them every turn: real routes over a real SQLite database built by the
 * migration chain; only the model and each project's knowledge-base search are
 * substituted. Assertions read back through the routes the chat page uses
 * (the SSE frames, the transcript, the resume read), never the objects built.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";
import type { AIProvider, ChatChunk, ChatMessage } from "../src/lib/ai/types.js";

type Hit = { chunkId: string; text: string; score: number };

const state = vi.hoisted(() => {
  process.env.AI_RATE_LIMIT_MAX = "10000";
  return {
    db: null as unknown,
    /** Each project's ranked hits. */
    hits: {} as Record<string, Hit[]>,
    /** The project ids searched, and the ACL actor each search ran for. */
    searched: [] as Array<{ projectId: string; actor: unknown }>,
    /** A project whose search never answers (it times out). */
    hang: null as string | null,
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
// Each project's knowledge-base search, stubbed under the REAL federated
// search (access narrowing, ACL actor, relevance fusion, timeouts). Injected
// through the service's own seam: the knowledge-service module is part of an
// import cycle with the retrieval stack, so mocking it would not reach here.
const stubKnowledgeService = {
  search: async (projectId: string, _query: string, opts?: { actor?: unknown }) => {
    state.searched.push({ projectId, actor: opts?.actor });
    if (projectId === state.hang) await new Promise(() => undefined);
    return {
      mode: "hybrid",
      hits: (state.hits[projectId] ?? []).map((h, i) => ({
        chunkId: h.chunkId,
        documentId: `doc-${h.chunkId}`,
        filename: `${h.chunkId}.md`,
        position: i,
        text: h.text,
        score: h.score,
        embeddingModel: "stub",
        source: "upload",
      })),
    };
  },
};
vi.mock("../src/lib/rag/federated-search-service.js", async (original) => {
  const real = await original<typeof import("../src/lib/rag/federated-search-service.js")>();
  return {
    ...real,
    getFederatedSearchService: () =>
      new real.FederatedSearchService({ knowledgeService: stubKnowledgeService as never }),
  };
});

const { aiRouter, setAIProviderForTests } = await import("../src/routes/ai.js");
const { aiConversationRouter } = await import("../src/routes/ai-conversation.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

class ScriptedProvider implements AIProvider {
  readonly key = "offline-stub" as const;
  readonly model = "stub-model";
  readonly offline = true;
  prompts: ChatMessage[][] = [];
  async chat(messages: ChatMessage[]) {
    this.prompts.push(messages);
    return {
      content: "chat answer",
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
      model: "stub-model",
      provider: this.key,
    };
  }
  async *stream(messages: ChatMessage[]): AsyncGenerator<ChatChunk> {
    this.prompts.push(messages);
    yield { type: "delta", content: "stream answer" };
    yield { type: "done", finishReason: "stop" };
  }
  async embed() {
    return { vectors: [], dimension: 0, model: "stub" };
  }
  async models() {
    return ["stub-model"];
  }
  async ping() {
    return true;
  }
}

function groundingFrames(text: string): unknown[] {
  return text
    .split("\n\n")
    .filter((block) => block.startsWith("event: grounding\n"))
    .map((block) => (JSON.parse(block.split("\ndata: ")[1]!) as { grounding: unknown }).grounding);
}

const promptText = (m: ChatMessage[]) => JSON.stringify(m);

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2238 — multi-product chat searches every product in its scope (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let alice: string;
    let model: ScriptedProvider;
    const ALICE = "u-alice";
    const BOB = "u-bob";
    const ALPHA = "p-alpha";
    const BETA = "p-beta";
    const GAMMA = "p-gamma";
    const SECRET = "p-secret";
    const MINE = "w-mine";
    const THEIRS = "w-theirs";

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
    const get = (url: string) => request(app()).get(url).set("Authorization", `Bearer ${alice}`);
    async function newSession(body: object): Promise<string> {
      const res = await post("/api/ai/sessions", body);
      expect(res.status, res.text).toBe(201);
      return (res.body.data.session as { id: string }).id;
    }
    async function replyGroundings(sessionId: string): Promise<unknown[]> {
      const res = await get(`/api/ai/sessions/${sessionId}/messages`);
      expect(res.status, res.text).toBe(200);
      const rows = res.body.data.messages as Array<{ role: string; grounding: unknown }>;
      return rows.filter((r) => r.role === "assistant").map((r) => r.grounding);
    }

    beforeAll(async () => {
      sqlite = createMigratedSqlite("issue-2238-multi-product-chat");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      for (const [id, username] of [
        [ALICE, "alice"],
        [BOB, "bob"],
      ]) {
        await db.user.create({
          data: { id, username, displayName: username, email: `${username}@example.test` },
        });
      }
      await db.workspace.create({ data: { id: MINE, name: "Mine", slug: "mine" } });
      await db.workspace.create({ data: { id: THEIRS, name: "Theirs", slug: "theirs" } });
      await db.workspaceMember.create({ data: { workspaceId: MINE, userId: ALICE } });
      await db.workspaceMember.create({ data: { workspaceId: THEIRS, userId: BOB } });
      for (const [id, name, workspaceId] of [
        [ALPHA, "Alpha", MINE],
        [BETA, "Beta", MINE],
        [GAMMA, "Gamma", MINE],
        [SECRET, "Secret", THEIRS],
      ] as const) {
        await db.project.create({
          data: { id, name, slug: id, createdById: ALICE, workspaceId },
        });
      }
      alice = issueTokens({
        userId: ALICE,
        username: "alice",
        role: "developer",
        permissions: [],
        workspaces: [MINE],
      }).accessToken;
      process.env.AI_OFFLINE = "1";
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      setAIProviderForTests(null);
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(async () => {
      model = new ScriptedProvider();
      setAIProviderForTests(model);
      state.hits = {};
      state.searched = [];
      state.hang = null;
      await db.project.update({ where: { id: BETA }, data: { workspaceId: MINE } });
    });

    it("a two-product turn searches both, labels each excerpt with its product, and grounds per product", async () => {
      state.hits = {
        [ALPHA]: [
          { chunkId: "a1", text: "Alpha retries a failed payment three times.", score: 0.8 },
        ],
        [BETA]: [{ chunkId: "b1", text: "Beta never retries a failed payment.", score: 0.78 }],
      };
      const sessionId = await newSession({ projectIds: [ALPHA, BETA] });
      const res = await post("/api/ai/stream", {
        sessionId,
        message: "How do A and B handle a failed payment?",
      });
      expect(res.text).toContain("event: done");
      const expected = {
        status: "multi",
        projects: [
          { projectId: ALPHA, projectName: "Alpha", sources: 1 },
          { projectId: BETA, projectName: "Beta", sources: 1 },
        ],
      };
      expect(groundingFrames(res.text)).toEqual([expected]);
      expect(state.searched.map((s) => s.projectId).sort()).toEqual([ALPHA, BETA]);
      // #2225 — each per-project search ran with alice as the chunk-ACL actor.
      for (const s of state.searched) expect(s.actor).toMatchObject({ userId: ALICE });

      const prompt = promptText(model.prompts[0]!);
      expect(prompt).toContain("[Alpha] a1.md#0");
      expect(prompt).toContain("[Beta] b1.md#0");
      expect(prompt).toContain("Beta never retries a failed payment.");
      expect(prompt).toContain("attribute every claim to its product by name");
      expect(await replyGroundings(sessionId)).toEqual([expected]);

      // The resume read the chat page uses carries the scope back.
      const resumed = await post(`/api/ai/sessions/${sessionId}/resume`);
      expect(resumed.status, resumed.text).toBe(200);
      expect(resumed.body.data.session.scopeProjectIds).toEqual([ALPHA, BETA]);
      expect(resumed.body.data.session.scopeWorkspaceId).toBeNull();
      expect(resumed.body.data.session.projectId).toBeNull();
      const read = await get(`/api/ai/sessions/${sessionId}`);
      expect(read.body.data.session.scopeProjectIds).toEqual([ALPHA, BETA]);
    });

    it("leaves out a product that has nothing relevant, and names it as searched", async () => {
      state.hits = {
        [ALPHA]: [{ chunkId: "a1", text: "Alpha retry policy.", score: 0.82 }],
        [GAMMA]: [{ chunkId: "g1", text: "Gamma onboarding checklist.", score: 0.2 }],
      };
      const sessionId = await newSession({ projectIds: [ALPHA, GAMMA] });
      const res = await post("/api/ai/chat", { sessionId, message: "What is the retry policy?" });
      expect(res.status, res.text).toBe(200);
      const prompt = promptText(model.prompts[0]!);
      expect(prompt).toContain("Alpha retry policy.");
      expect(prompt).not.toContain("Gamma onboarding checklist.");
      expect(prompt).toContain('Searched, but no excerpt from it is included above: \\"Gamma\\"');
      expect(await replyGroundings(sessionId)).toEqual([
        {
          status: "multi",
          projects: [
            { projectId: ALPHA, projectName: "Alpha", sources: 1 },
            { projectId: GAMMA, projectName: "Gamma", sources: 0 },
          ],
        },
      ]);
    });

    it("re-checks access every turn: a product the caller lost is not searched, and is counted", async () => {
      state.hits = {
        [ALPHA]: [{ chunkId: "a1", text: "alpha", score: 0.8 }],
        [BETA]: [{ chunkId: "b1", text: "beta-secret-text", score: 0.8 }],
      };
      const sessionId = await newSession({ projectIds: [ALPHA, BETA] });
      // Beta moves to a workspace alice is not in, after the session was created.
      await db.project.update({ where: { id: BETA }, data: { workspaceId: THEIRS } });
      const res = await post("/api/ai/stream", { sessionId, message: "q" });
      expect(state.searched.map((s) => s.projectId)).toEqual([ALPHA]);
      expect(promptText(model.prompts[0]!)).not.toContain("beta-secret-text");
      expect(groundingFrames(res.text)).toEqual([
        {
          status: "multi",
          projects: [{ projectId: ALPHA, projectName: "Alpha", sources: 1 }],
          unavailable: 1,
        },
      ]);
    });

    it("names a product whose search timed out, in the prompt and on the badge", async () => {
      state.hits = { [ALPHA]: [{ chunkId: "a1", text: "alpha", score: 0.8 }] };
      state.hang = BETA;
      const sessionId = await newSession({ projectIds: [ALPHA, BETA] });
      const res = await post("/api/ai/stream", { sessionId, message: "q" });
      expect(promptText(model.prompts[0]!)).toContain(
        'Could not be searched this turn: \\"Beta\\" (timed out)',
      );
      expect(groundingFrames(res.text)).toEqual([
        {
          status: "multi",
          projects: [{ projectId: ALPHA, projectName: "Alpha", sources: 1 }],
          unsearched: [{ projectId: BETA, projectName: "Beta", reason: "timeout" }],
        },
      ]);
    }, 15_000);

    it("a workspace-scoped chat searches every project of it the caller can open", async () => {
      state.hits = {
        [ALPHA]: [{ chunkId: "a1", text: "alpha", score: 0.8 }],
        [GAMMA]: [{ chunkId: "g1", text: "gamma", score: 0.8 }],
      };
      const sessionId = await newSession({ workspaceId: MINE });
      await post("/api/ai/stream", { sessionId, message: "q" });
      expect(state.searched.map((s) => s.projectId).sort()).toEqual([ALPHA, BETA, GAMMA]);
      expect(state.searched.map((s) => s.projectId)).not.toContain(SECRET);
    });

    it("refuses a scope naming another workspace's project, or another workspace", async () => {
      expect((await post("/api/ai/sessions", { projectIds: [ALPHA, SECRET] })).status).toBe(404);
      expect((await post("/api/ai/sessions", { workspaceId: THEIRS })).status).toBe(404);
      expect(state.searched).toEqual([]);
    });
  },
);
