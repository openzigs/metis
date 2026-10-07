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
    /** #464 — hits for one query only (what the search-knowledge tool asks). */
    toolQuery: null as string | null,
    toolHits: [] as Array<{ filename: string; position: number; score: number; text: string }>,
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
    search: async (projectId: string, query: string) => {
      state.searched.push(projectId);
      return { hits: query === state.toolQuery ? state.toolHits : state.hits };
    },
  }),
}));

const { aiRouter, setAIProviderForTests } = await import("../src/routes/ai.js");
const { aiConversationRouter } = await import("../src/routes/ai-conversation.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { registerSearchKnowledgeTool, __resetSearchKnowledgeRegistration } =
  await import("../src/lib/rag/search-knowledge-tool.js");

/** A scripted `chat()` reply that throws instead of answering. */
const THROW = "__throw__";

class ScriptedProvider implements AIProvider {
  readonly key = "offline-stub" as const;
  readonly model = "stub-model";
  readonly offline = true;
  prompts: ChatMessage[][] = [];
  /** Throw after the first delta: the turn ends as a failed/incomplete reply. */
  failMidStream = false;
  /** #439 — scripted `chat()` replies, in order (the text tool protocol uses chat()). */
  chatReplies: string[] = [];
  async chat(messages: ChatMessage[]) {
    this.prompts.push(messages);
    const next = this.chatReplies.shift();
    if (next === THROW) throw new Error("provider failed mid-investigation");
    return {
      content: next ?? "chat answer",
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

/**
 * #464 — a tool-capable model. METIS registry tools (`search-knowledge`) are
 * offered only as NATIVE tool definitions, so this stub answers its first model
 * call with a native tool call and the next with text.
 */
class NativeToolProvider extends ScriptedProvider {
  readonly capabilities = { responseFormat: false, nativeToolCalls: true };
  /** Native tool calls to make, one per model call, before answering. */
  toolCalls: Array<{ name: string; args: unknown }> = [];
  private next(): { id: string; name: string; args: unknown } | null {
    const call = this.toolCalls.shift();
    return call ? { id: `call-${this.prompts.length}`, ...call } : null;
  }
  override async chat(messages: ChatMessage[]) {
    this.prompts.push(messages);
    const call = this.next();
    return {
      content: call ? "" : "chat answer",
      ...(call ? { toolCalls: [call] } : {}),
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
      model: "stub-model",
      provider: this.key,
    };
  }
  override async *stream(messages: ChatMessage[]): AsyncGenerator<ChatChunk> {
    this.prompts.push(messages);
    const call = this.next();
    if (call) {
      yield {
        type: "tool_call",
        name: call.name,
        arguments: call.args,
        toolCallId: call.id,
        native: true,
      };
    } else {
      yield { type: "delta", content: "stream answer" };
    }
    yield { type: "done", finishReason: call ? "tool_use" : "stop" };
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
      // #439 — a code graph the curated code tools can read.
      await db.codeGraph.create({ data: { id: "cg-payments", projectId: PROJECT } });
      await db.codeSymbol.create({
        data: {
          codeGraphId: "cg-payments",
          projectId: PROJECT,
          kind: "class",
          name: "Validator",
          qualifiedName: "src/validator.ts::Validator",
          filePath: "src/validator.ts",
          startLine: 1,
          endLine: 40,
          language: "ts",
          contentHash: "h",
        },
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
      delete process.env.CHAT_CODE_SEARCH_TOOLS;
      setAIProviderForTests(null);
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(() => {
      delete process.env.CHAT_CODE_SEARCH_TOOLS;
      model = new ScriptedProvider();
      setAIProviderForTests(model);
      state.hits = [];
      state.searched = [];
      state.toolQuery = null;
      state.toolHits = [];
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

    describe("#439 — what the tools read of the project counts as grounding", () => {
      const SEARCH = JSON.stringify({ tool: "search_code_graph", args: { query: "Validator" } });
      const MISS = JSON.stringify({ tool: "search_code_graph", args: { query: "NoSuchThing" } });
      beforeEach(() => {
        // The stub declares no native tool calls, so the curated code tools
        // ride the text protocol through chat().
        process.env.CHAT_CODE_SEARCH_TOOLS = "true";
      });

      it("a streamed turn with no excerpts whose code tool read the project is grounded, live and on reload", async () => {
        model.chatReplies = [SEARCH, "The validator lives in src/validator.ts."];
        const sessionId = await newSession(PROJECT);
        const res = await post("/api/ai/stream", { sessionId, message: "Where is validation?" });
        expect(res.text).toContain("event: done");
        const grounded = {
          status: "grounded",
          projectId: PROJECT,
          projectName: "Payments",
          sources: 0,
          toolReads: 1,
        };
        // First what auto-retrieval supplied, then — after the tool read — the update.
        expect(groundingFrames(res.text)).toEqual([
          { status: "no-context", projectId: PROJECT, projectName: "Payments" },
          grounded,
        ]);
        // The tool really returned the project's symbol to the model.
        expect(JSON.stringify(model.prompts[1])).toContain("src/validator.ts::Validator");
        expect(await replyGroundings(sessionId)).toEqual([grounded]);
      });

      it("a streamed turn that fails after its tool read the project records the read", async () => {
        model.chatReplies = [SEARCH, THROW];
        const sessionId = await newSession(PROJECT);
        const res = await post("/api/ai/stream", { sessionId, message: "Where is validation?" });
        expect(res.text).toContain("event: error");
        expect(await replyGroundings(sessionId)).toEqual([
          {
            status: "grounded",
            projectId: PROJECT,
            projectName: "Payments",
            sources: 0,
            toolReads: 1,
          },
        ]);
      });

      it("a code tool that found nothing leaves the turn no-context", async () => {
        model.chatReplies = [MISS, "I could not find it."];
        const sessionId = await newSession(PROJECT);
        const res = await post("/api/ai/stream", { sessionId, message: "Where is it?" });
        const expected = { status: "no-context", projectId: PROJECT, projectName: "Payments" };
        expect(groundingFrames(res.text)).toEqual([expected]);
        expect(await replyGroundings(sessionId)).toEqual([expected]);
      });

      it("the /chat turn adds its tool reads to the excerpts it retrieved", async () => {
        state.hits = [{ filename: "a.md", position: 0, score: 0.5, text: "alpha" }];
        model.chatReplies = [SEARCH, "answer"];
        const sessionId = await newSession(PROJECT);
        const res = await post("/api/ai/chat", { sessionId, message: "where is validation?" });
        expect(res.status, res.text).toBe(200);
        const expected = {
          status: "grounded",
          projectId: PROJECT,
          projectName: "Payments",
          sources: 1,
          toolReads: 1,
        };
        expect(res.body.data.grounding).toEqual(expected);
        expect(await replyGroundings(sessionId)).toEqual([expected]);
      });
    });

    describe("#464 — the project-scoped search-knowledge tool counts as grounding", () => {
      const QUERY = "rebinding defence";
      let native: NativeToolProvider;
      const searchKnowledge = (projectId: string) => ({
        name: "search-knowledge",
        args: { projectId, query: QUERY },
      });
      beforeAll(() => registerSearchKnowledgeTool());
      afterAll(() => __resetSearchKnowledgeRegistration());
      beforeEach(() => {
        native = new NativeToolProvider();
        setAIProviderForTests(native);
        state.toolQuery = QUERY;
        state.toolHits = [
          { filename: "ssrf.md", position: 0, score: 0.9, text: "resolveAndPin() pins the IP" },
        ];
      });
      const grounded = {
        status: "grounded",
        projectId: PROJECT,
        projectName: "Payments",
        sources: 0,
        toolReads: 1,
      };
      const noContext = { status: "no-context", projectId: PROJECT, projectName: "Payments" };

      it("a scoped streamed reply grounded only by search-knowledge is labelled grounded, live and on reload", async () => {
        native.toolCalls = [searchKnowledge(PROJECT)];
        const sessionId = await newSession(PROJECT);
        const res = await post("/api/ai/stream", { sessionId, message: "How is DNS handled?" });
        expect(res.text).toContain("event: done");
        // Auto-retrieval found nothing; the tool's read is what grounds it.
        expect(groundingFrames(res.text)).toEqual([noContext, grounded]);
        // The knowledge base's excerpt really reached the model.
        expect(JSON.stringify(native.prompts[1])).toContain("resolveAndPin() pins the IP");
        expect(await replyGroundings(sessionId)).toEqual([grounded]);
      });

      it("the /chat turn counts it too", async () => {
        native.toolCalls = [searchKnowledge(PROJECT)];
        const sessionId = await newSession(PROJECT);
        const res = await post("/api/ai/chat", { sessionId, message: "How is DNS handled?" });
        expect(res.status, res.text).toBe(200);
        expect(JSON.stringify(native.prompts[1])).toContain("resolveAndPin() pins the IP");
        expect(res.body.data.grounding).toEqual(grounded);
        expect(await replyGroundings(sessionId)).toEqual([grounded]);
      });

      it("a search naming another project never reaches it: the session's own project is searched (#736)", async () => {
        native.toolCalls = [searchKnowledge("p-other")];
        const sessionId = await newSession(PROJECT);
        const res = await post("/api/ai/stream", { sessionId, message: "How is DNS handled?" });
        expect(res.text).toContain("event: done");
        expect(state.searched).not.toContain("p-other");
        // Auto-retrieval's search, then the tool's — both on the bound project.
        expect(state.searched).toEqual([PROJECT, PROJECT]);
        expect(groundingFrames(res.text)).toEqual([noContext, grounded]);
        expect(await replyGroundings(sessionId)).toEqual([grounded]);
      });

      it("a search that found nothing leaves the turn no-context", async () => {
        state.toolHits = [];
        native.toolCalls = [searchKnowledge(PROJECT)];
        const sessionId = await newSession(PROJECT);
        const res = await post("/api/ai/stream", { sessionId, message: "How is DNS handled?" });
        expect(res.text).toContain("event: done");
        // The tool did run (a second project search after auto-retrieval's).
        expect(state.searched).toEqual([PROJECT, PROJECT]);
        expect(groundingFrames(res.text)).toEqual([noContext]);
        expect(await replyGroundings(sessionId)).toEqual([noContext]);
      });
    });
  },
);
