/**
 * #18 — every chat reply says what it was grounded in, and says it both live
 * (a `grounding` SSE frame before the answer) and on reload (the transcript
 * row read back through `GET /api/ai/sessions/:id/messages`).
 *
 * Real routes over a real SQLite database built by the migration chain; only
 * the model and the knowledge-base search are substituted. Assertions read back
 * through the same HTTP route the chat page uses, never the object just built.
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

const state = vi.hoisted(() => {
  process.env.AI_RATE_LIMIT_MAX = "10000";
  return {
    db: null as unknown,
    hits: [] as Array<{ filename: string; position: number; score: number; text: string }>,
    searched: [] as string[],
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
    search: async (projectId: string) => {
      state.searched.push(projectId);
      return { hits: state.hits };
    },
  }),
}));

const { aiRouter, setAIProviderForTests } = await import("../src/routes/ai.js");
const { aiConversationRouter } = await import("../src/routes/ai-conversation.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

class ScriptedProvider implements AIProvider {
  readonly key = "offline-stub" as const;
  readonly model = "stub-model";
  readonly offline = true;
  prompts: ChatMessage[][] = [];
  /** Throw after the first delta: the turn ends as a failed/incomplete reply. */
  failMidStream = false;
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
    if (this.failMidStream) throw new Error("provider dropped the stream");
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

/** The `grounding` frames of an SSE body, in order. */
function groundingFrames(text: string): unknown[] {
  return text
    .split("\n\n")
    .filter((block) => block.startsWith("event: grounding\n"))
    .map((block) => (JSON.parse(block.split("\ndata: ")[1]!) as { grounding: unknown }).grounding);
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#18 — chat replies say what they were grounded in (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let alice: string;
    let model: ScriptedProvider;
    const ALICE = "u-alice";
    const PROJECT = "p-payments";

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
    async function newSession(projectId?: string): Promise<string> {
      const res = await post("/api/ai/sessions", projectId ? { projectId } : {});
      expect(res.status, res.text).toBe(201);
      return (res.body.data.session as { id: string }).id;
    }
    async function replyGroundings(sessionId: string): Promise<unknown[]> {
      const res = await request(app())
        .get(`/api/ai/sessions/${sessionId}/messages`)
        .set("Authorization", `Bearer ${alice}`);
      expect(res.status, res.text).toBe(200);
      const rows = res.body.data.messages as Array<{ role: string; grounding: unknown }>;
      for (const r of rows.filter((r) => r.role !== "assistant")) expect(r.grounding).toBeNull();
      return rows.filter((r) => r.role === "assistant").map((r) => r.grounding);
    }

    beforeAll(async () => {
      sqlite = createMigratedSqlite("issue-18-grounding");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: ALICE, username: "alice", displayName: "alice", email: "a@example.test" },
      });
      await db.project.create({
        data: { id: PROJECT, name: "Payments", slug: "payments", createdById: ALICE },
      });
      alice = issueTokens({
        userId: ALICE,
        username: "alice",
        role: "developer",
        permissions: [],
      }).accessToken;
      process.env.AI_OFFLINE = "1";
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      setAIProviderForTests(null);
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(() => {
      model = new ScriptedProvider();
      setAIProviderForTests(model);
      state.hits = [];
      state.searched = [];
    });

    it("an 'All projects' (unscoped) reply is marked unscoped, live and on reload, and runs no retrieval", async () => {
      const sessionId = await newSession();
      const res = await post("/api/ai/stream", {
        sessionId,
        message: "How is DNS rebinding handled?",
      });
      expect(res.text).toContain("event: done");
      expect(groundingFrames(res.text)).toEqual([{ status: "unscoped" }]);
      // The grounding frame precedes the answer.
      expect(res.text.indexOf("event: grounding")).toBeLessThan(res.text.indexOf("event: delta"));
      expect(state.searched).toEqual([]);
      expect(await replyGroundings(sessionId)).toEqual([{ status: "unscoped" }]);
    });

    it("a project reply with retrieved excerpts is grounded in that project, with its source count", async () => {
      state.hits = [
        { filename: "ssrf.ts", position: 0, score: 0.9, text: "assertPublicHost()" },
        { filename: "dns.ts", position: 1, score: 0.8, text: "resolveAndPin()" },
      ];
      const sessionId = await newSession(PROJECT);
      const res = await post("/api/ai/stream", {
        sessionId,
        message: "How is DNS rebinding handled?",
      });
      const expected = {
        status: "grounded",
        projectId: PROJECT,
        projectName: "Payments",
        sources: 2,
      };
      expect(groundingFrames(res.text)).toEqual([expected]);
      expect(state.searched).toEqual([PROJECT]);
      // The excerpts really reached the model — the label is not a guess.
      expect(JSON.stringify(model.prompts[0])).toContain("resolveAndPin()");
      expect(await replyGroundings(sessionId)).toEqual([expected]);
    });

    it("a project reply with nothing retrieved says so rather than claiming grounding", async () => {
      const sessionId = await newSession(PROJECT);
      const res = await post("/api/ai/stream", { sessionId, message: "hello" });
      const expected = { status: "no-context", projectId: PROJECT, projectName: "Payments" };
      expect(groundingFrames(res.text)).toEqual([expected]);
      expect(await replyGroundings(sessionId)).toEqual([expected]);
    });

    it("the non-streaming /chat turn records and returns its grounding too", async () => {
      state.hits = [{ filename: "a.md", position: 0, score: 0.5, text: "alpha" }];
      const sessionId = await newSession(PROJECT);
      const res = await post("/api/ai/chat", { sessionId, message: "what is alpha?" });
      expect(res.status, res.text).toBe(200);
      const expected = {
        status: "grounded",
        projectId: PROJECT,
        projectName: "Payments",
        sources: 1,
      };
      expect(res.body.data.grounding).toEqual(expected);
      expect(await replyGroundings(sessionId)).toEqual([expected]);
    });

    it("a reply that fails mid-stream keeps its grounding on reload", async () => {
      // PR #437 panel: the failed-turn write (recordFailedTurn) had no test —
      // the scripted stream never errored.
      state.hits = [{ filename: "a.md", position: 0, score: 0.5, text: "alpha" }];
      model.failMidStream = true;
      const sessionId = await newSession(PROJECT);
      await post("/api/ai/stream", { sessionId, message: "what is alpha?" });
      expect(await replyGroundings(sessionId)).toEqual([
        { status: "grounded", projectId: PROJECT, projectName: "Payments", sources: 1 },
      ]);
    });

    it("each reply carries its own turn's grounding", async () => {
      const sessionId = await newSession(PROJECT);
      await post("/api/ai/stream", { sessionId, message: "first" });
      state.hits = [{ filename: "a.md", position: 0, score: 0.5, text: "alpha" }];
      await post("/api/ai/stream", { sessionId, message: "second" });
      expect(await replyGroundings(sessionId)).toEqual([
        { status: "no-context", projectId: PROJECT, projectName: "Payments" },
        { status: "grounded", projectId: PROJECT, projectName: "Payments", sources: 1 },
      ]);
    });
  },
);
