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
    hits: [] as Array<{
      filename: string;
      position: number;
      score: number;
      text: string;
      path?: string;
      source?: string;
      /** #2241 — the relevance floor's default applies only to a calibrated embedder. */
      embeddingModel?: string;
    }>,
    searched: [] as string[],
    /** #2225 — the ACL actor each search ran for, in order. */
    actors: [] as unknown[],
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
    search: async (projectId: string, query: string, opts?: { actor?: unknown }) => {
      state.searched.push(projectId);
      state.actors.push(opts?.actor);
      return { hits: query === state.toolQuery ? state.toolHits : state.hits };
    },
  }),
}));

const { aiRouter, setAIProviderForTests } = await import("../src/routes/ai.js");
// #1864 — search-knowledge is now cached even while the graph has no commit
// SHA, so each test starts from an empty tool-result cache.
const { __resetToolResultCacheForTests } =
  await import("../src/lib/ai/tool-runtime/tool-result-cache.js");
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
  /** #2242 — what `stream()` answers. */
  streamText = "stream answer";
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
    yield { type: "delta", content: this.streamText };
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

/** #2242 — the `citations` frames of an SSE body, in order. */
function citationFrames(text: string): unknown[] {
  return text
    .split("\n\n")
    .filter((block) => block.startsWith("event: citations\n"))
    .map((block) => (JSON.parse(block.split("\ndata: ")[1]!) as { citations: unknown }).citations);
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
    const INDEXED_SHA = "0123456789abcdef0123456789abcdef01234567";

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
      // #2325 — indexed at a known commit, which every code citation states.
      await db.codeGraph.create({
        data: { id: "cg-payments", projectId: PROJECT, commitSha: INDEXED_SHA },
      });
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
      __resetToolResultCacheForTests();
      model = new ScriptedProvider();
      setAIProviderForTests(model);
      state.hits = [];
      state.searched = [];
      state.actors = [];
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
        // #2241 — the label lists the files the excerpts came from.
        sourcesUsed: [
          { name: "ssrf.ts", excerpts: 1, relevance: 0.9 },
          { name: "dns.ts", excerpts: 1, relevance: 0.8 },
        ],
      };
      expect(groundingFrames(res.text)).toEqual([expected]);
      expect(state.searched).toEqual([PROJECT]);
      // #2225 — retrieved for the requester, on their DURABLE role: alice has
      // no role rows (reader), whatever her token's `developer` claim says.
      expect(state.actors).toEqual([{ userId: ALICE, role: "reader" }]);
      // The excerpts really reached the model — the label is not a guess.
      expect(JSON.stringify(model.prompts[0])).toContain("resolveAndPin()");
      expect(await replyGroundings(sessionId)).toEqual([expected]);
    });

    it("a project reply with nothing retrieved says so rather than claiming grounding", async () => {
      const sessionId = await newSession(PROJECT);
      const res = await post("/api/ai/stream", { sessionId, message: "hello" });
      const expected = {
        status: "no-context",
        projectId: PROJECT,
        projectName: "Payments",
        reason: "nothing-found",
      };
      expect(groundingFrames(res.text)).toEqual([expected]);
      expect(await replyGroundings(sessionId)).toEqual([expected]);
    });

    // #2241 — embedded by the model the default floor was calibrated on, and
    // well under that floor.
    const weakCalibratedHit = {
      filename: "weak.md",
      position: 0,
      score: 0.2,
      text: "unrelated-text",
      embeddingModel: "Alibaba-NLP/gte-modernbert-base",
    };

    it("#2241 — a reply whose matches were all too weak says the evidence was insufficient, live and on reload", async () => {
      state.hits = [weakCalibratedHit];
      const sessionId = await newSession(PROJECT);
      const res = await post("/api/ai/stream", { sessionId, message: "What is the SLA?" });
      const expected = {
        status: "no-context",
        projectId: PROJECT,
        projectName: "Payments",
        reason: "insufficient-evidence",
        belowFloor: 1,
      };
      expect(groundingFrames(res.text)).toEqual([expected]);
      expect(await replyGroundings(sessionId)).toEqual([expected]);
      // The weak excerpt never reached the model; it was told the sources don't show this.
      const prompt = JSON.stringify(model.prompts[0]);
      expect(prompt).not.toContain("unrelated-text");
      expect(prompt).toContain("sources don't show this");
    });

    it("#2241 — an attached document's weak matches still reach the model: the user chose it", async () => {
      state.hits = [weakCalibratedHit];
      const sessionId = await newSession(PROJECT);
      const res = await post("/api/ai/stream", {
        sessionId,
        message: "Summarise this",
        documentIds: ["doc-frd"],
      });
      const [frame] = groundingFrames(res.text) as Array<Record<string, unknown>>;
      expect(frame).toMatchObject({ status: "grounded", sources: 1 });
      expect(frame).not.toHaveProperty("belowFloor");
      const prompt = JSON.stringify(model.prompts[0]);
      expect(prompt).toContain("unrelated-text");
      expect(prompt).toContain("The user attached documents to this question");
      expect(prompt).not.toContain("nothing in it was relevant enough to use");
    });

    it("the non-streaming /chat turn records and returns its grounding too", async () => {
      state.hits = [{ filename: "a.md", position: 0, score: 0.9, text: "alpha" }];
      const sessionId = await newSession(PROJECT);
      const res = await post("/api/ai/chat", { sessionId, message: "what is alpha?" });
      expect(res.status, res.text).toBe(200);
      const expected = {
        status: "grounded",
        projectId: PROJECT,
        projectName: "Payments",
        sources: 1,
        sourcesUsed: [{ name: "a.md", excerpts: 1, relevance: 0.9 }],
      };
      expect(res.body.data.grounding).toEqual(expected);
      expect(await replyGroundings(sessionId)).toEqual([expected]);
      expect(state.actors).toEqual([{ userId: ALICE, role: "reader" }]);
    });

    it("a reply that fails mid-stream keeps its grounding on reload", async () => {
      // PR #437 panel: the failed-turn write (recordFailedTurn) had no test —
      // the scripted stream never errored.
      state.hits = [{ filename: "a.md", position: 0, score: 0.9, text: "alpha" }];
      model.failMidStream = true;
      const sessionId = await newSession(PROJECT);
      await post("/api/ai/stream", { sessionId, message: "what is alpha?" });
      expect(await replyGroundings(sessionId)).toEqual([
        {
          status: "grounded",
          projectId: PROJECT,
          projectName: "Payments",
          sources: 1,
          sourcesUsed: [{ name: "a.md", excerpts: 1, relevance: 0.9 }],
        },
      ]);
    });

    it("each reply carries its own turn's grounding", async () => {
      const sessionId = await newSession(PROJECT);
      await post("/api/ai/stream", { sessionId, message: "first" });
      state.hits = [{ filename: "a.md", position: 0, score: 0.9, text: "alpha" }];
      await post("/api/ai/stream", { sessionId, message: "second" });
      expect(await replyGroundings(sessionId)).toEqual([
        {
          status: "no-context",
          projectId: PROJECT,
          projectName: "Payments",
          reason: "nothing-found",
        },
        {
          status: "grounded",
          projectId: PROJECT,
          projectName: "Payments",
          sources: 1,
          sourcesUsed: [{ name: "a.md", excerpts: 1, relevance: 0.9 }],
        },
      ]);
    });

    describe("#2242 — a reply's citations are checked against what the turn read", () => {
      async function replyCitations(sessionId: string): Promise<unknown[]> {
        const res = await request(app())
          .get(`/api/ai/sessions/${sessionId}/messages`)
          .set("Authorization", `Bearer ${alice}`);
        expect(res.status, res.text).toBe(200);
        const rows = res.body.data.messages as Array<{ role: string; citations?: unknown }>;
        return rows.filter((r) => r.role === "assistant").map((r) => r.citations);
      }

      it("marks a retrieved file verified and a fabricated one not read, live and on reload", async () => {
        // #2243 — the code tools are on by default; this is the non-loop stream path.
        process.env.CHAT_CODE_SEARCH_TOOLS = "false";
        state.hits = [
          {
            filename: "connector:repo:c1:src/net/ssrf.ts",
            path: "src/net/ssrf.ts",
            source: "repo",
            position: 0,
            score: 0.9,
            text: "assertPublicHost()",
          },
        ];
        model.streamText =
          "Rebinding is blocked in `src/net/ssrf.ts`, and pinned in `src/net/pin.ts:10-20`.";
        const sessionId = await newSession(PROJECT);
        const res = await post("/api/ai/stream", {
          sessionId,
          message: "How is DNS rebinding handled?",
        });
        const expected = [
          {
            text: "src/net/ssrf.ts",
            path: "src/net/ssrf.ts",
            status: "verified",
            source: "repo",
            // #2325 — an excerpt states no commit: the version is not known.
            commitSha: null,
          },
          {
            text: "src/net/pin.ts:10-20",
            path: "src/net/pin.ts",
            lines: [10, 20],
            status: "not-read",
          },
        ];
        expect(citationFrames(res.text)).toEqual([expected]);
        // Sent before the turn is done, so the client has it when the answer ends.
        expect(res.text.indexOf("event: citations")).toBeLessThan(res.text.indexOf("event: done"));
        expect(await replyCitations(sessionId)).toEqual([expected]);
      });

      it("#2241 — an excerpt the relevance floor set aside is not evidence: citing it is not-read", async () => {
        // #2243 — the code tools are on by default; this is the non-loop stream path.
        process.env.CHAT_CODE_SEARCH_TOOLS = "false";
        state.hits = [
          {
            filename: "kept.md",
            position: 0,
            score: 0.9,
            text: "kept-text",
            embeddingModel: "Alibaba-NLP/gte-modernbert-base",
          },
          { ...weakCalibratedHit, filename: "floored.md" },
        ];
        model.streamText = "Per [1] and [2]; `floored.md:1` says so.";
        const sessionId = await newSession(PROJECT);
        const res = await post("/api/ai/stream", { sessionId, message: "What is the SLA?" });
        // Only the kept excerpt reached the prompt, so only `[1]` names one.
        expect(JSON.stringify(model.prompts[0])).not.toContain("unrelated-text");
        const expected = [
          { text: "[1]", path: "kept.md", status: "verified", source: "document" },
          { text: "[2]", path: "", status: "not-read" },
          { text: "floored.md:1", path: "floored.md", lines: [1, 1], status: "not-read" },
        ];
        expect(citationFrames(res.text)).toEqual([expected]);
        expect(await replyCitations(sessionId)).toEqual([expected]);
      });

      it("#2241 — an attached document's excerpt under the floor still reached the model, so citing it is verified", async () => {
        // #2243 — the code tools are on by default; this is the non-loop stream path.
        process.env.CHAT_CODE_SEARCH_TOOLS = "false";
        state.hits = [weakCalibratedHit];
        model.streamText = "Summarised from [1] in `weak.md`.";
        const sessionId = await newSession(PROJECT);
        const res = await post("/api/ai/stream", {
          sessionId,
          message: "Summarise this",
          documentIds: ["doc-frd"],
        });
        const expected = [
          { text: "[1]", path: "weak.md", status: "verified", source: "document" },
          { text: "weak.md", path: "weak.md", status: "verified", source: "document" },
        ];
        expect(citationFrames(res.text)).toEqual([expected]);
        expect(await replyCitations(sessionId)).toEqual([expected]);
      });

      it("sends no citations frame, and records none, for an answer that cites nothing", async () => {
        const sessionId = await newSession(PROJECT);
        const res = await post("/api/ai/stream", { sessionId, message: "hello" });
        expect(citationFrames(res.text)).toEqual([]);
        expect(await replyCitations(sessionId)).toEqual([undefined]);
      });

      it("the /chat turn checks a cited line range against the lines a code tool returned", async () => {
        process.env.CHAT_CODE_SEARCH_TOOLS = "true";
        model.chatReplies = [
          JSON.stringify({ tool: "search_code_graph", args: { query: "Validator" } }),
          "It is `src/validator.ts:5-12`, not `src/validator.ts:50-60`.",
        ];
        const sessionId = await newSession(PROJECT);
        const res = await post("/api/ai/chat", { sessionId, message: "where is validation?" });
        expect(res.status, res.text).toBe(200);
        const expected = [
          {
            text: "src/validator.ts:5-12",
            path: "src/validator.ts",
            lines: [5, 12],
            status: "verified",
            source: "repo",
            commitSha: INDEXED_SHA,
          },
          {
            text: "src/validator.ts:50-60",
            path: "src/validator.ts",
            lines: [50, 60],
            status: "span-unverified",
            source: "repo",
            commitSha: INDEXED_SHA,
          },
        ];
        expect(res.body.data.citations).toEqual(expected);
        expect(await replyCitations(sessionId)).toEqual([expected]);
      });

      const SEARCH = JSON.stringify({ tool: "search_code_graph", args: { query: "Validator" } });
      const validatorAt = (lines: [number, number], status: string) => ({
        text: `src/validator.ts:${lines[0]}-${lines[1]}`,
        path: "src/validator.ts",
        lines,
        status,
        source: "repo",
        // #2325 — the version the tool stated, kept on the row and read back
        // from an earlier turn's stored tool result.
        commitSha: INDEXED_SHA,
      });

      it("the /stream tool loop checks the answer against what its tools read, live and on reload", async () => {
        process.env.CHAT_CODE_SEARCH_TOOLS = "true";
        model.chatReplies = [SEARCH, "It is `src/validator.ts:5-12`."];
        const sessionId = await newSession(PROJECT);
        const res = await post("/api/ai/stream", { sessionId, message: "where is validation?" });
        expect(res.text).toContain("event: done");
        const expected = [validatorAt([5, 12], "verified")];
        expect(citationFrames(res.text)).toEqual([expected]);
        expect(res.text.indexOf("event: citations")).toBeLessThan(res.text.indexOf("event: done"));
        expect(await replyCitations(sessionId)).toEqual([expected]);
      });

      it.each(["/api/ai/stream", "/api/ai/chat"])(
        "%s: a follow-up re-citing lines an earlier turn's tool read is verified-earlier, not not-read",
        async (route) => {
          process.env.CHAT_CODE_SEARCH_TOOLS = "true";
          const sessionId = await newSession(PROJECT);
          model.chatReplies = [SEARCH, "It is `src/validator.ts:5-12`."];
          await post(route, { sessionId, message: "where is validation?" });
          // The follow-up calls no tool: it answers from what the first turn read.
          model.chatReplies = ["As above, `src/validator.ts:5-12`; not `src/validator.ts:90-99`."];
          const res = await post(route, { sessionId, message: "and where exactly?" });
          const expected = [
            validatorAt([5, 12], "verified-earlier"),
            validatorAt([90, 99], "span-unverified"),
          ];
          if (route.endsWith("/chat")) expect(res.body.data.citations).toEqual(expected);
          else expect(citationFrames(res.text)).toEqual([expected]);
          expect(await replyCitations(sessionId)).toEqual([
            [validatorAt([5, 12], "verified")],
            expected,
          ]);
        },
      );
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
          {
            status: "no-context",
            projectId: PROJECT,
            projectName: "Payments",
            reason: "nothing-found",
          },
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
        const expected = {
          status: "no-context",
          projectId: PROJECT,
          projectName: "Payments",
          reason: "nothing-found",
        };
        expect(groundingFrames(res.text)).toEqual([expected]);
        expect(await replyGroundings(sessionId)).toEqual([expected]);
      });

      it("the /chat turn adds its tool reads to the excerpts it retrieved", async () => {
        state.hits = [{ filename: "a.md", position: 0, score: 0.9, text: "alpha" }];
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
          sourcesUsed: [{ name: "a.md", excerpts: 1, relevance: 0.9 }],
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
      const noContext = {
        status: "no-context",
        projectId: PROJECT,
        projectName: "Payments",
        reason: "nothing-found",
      };

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
        // #2225 — auto-RAG and the search-knowledge tool both search as alice.
        expect(state.actors).toEqual([
          { userId: ALICE, role: "reader" },
          { userId: ALICE, role: "reader" },
        ]);
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
