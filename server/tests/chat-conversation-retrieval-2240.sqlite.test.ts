/**
 * #2240 — conversation-aware chat retrieval, over the real routes and a real
 * SQLite database built by the migration chain. Only the model and the
 * knowledge-base search are substituted; cited excerpts are read back from the
 * real `knowledge_chunks` table, and every assertion reads what reached the
 * model on the NEXT turn — the consumer of what a reply recorded.
 *
 *   - a BA's answer to the model's question is searched with that question and
 *     the one before it, not on its own;
 *   - the excerpts an answer cited stay in the next turn's prompt (both chat
 *     routes), read for the requester — a chunk whose ACL now excludes them, or
 *     whose document was deleted, is not brought back;
 *   - documents attached to a question limit the search to them.
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

interface Hit {
  chunkId: string;
  documentId: string;
  filename: string;
  position: number;
  score: number;
  text: string;
  source: string;
  embeddingModel: string;
}

const state = vi.hoisted(() => {
  process.env.AI_RATE_LIMIT_MAX = "10000";
  return {
    db: null as unknown,
    hits: [] as Hit[],
    searches: [] as Array<{ projectId: string; query: string; opts: Record<string, unknown> }>,
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
    search: async (projectId: string, query: string, opts: Record<string, unknown> = {}) => {
      state.searches.push({ projectId, query, opts });
      return { hits: state.hits };
    },
  }),
}));

const { aiRouter, setAIProviderForTests } = await import("../src/routes/ai.js");
const { aiConversationRouter } = await import("../src/routes/ai-conversation.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { loadChunksById } = await import("../src/lib/rag/chunk-lookup.js");

/** Answers each model call with the next scripted reply. */
class ScriptedProvider implements AIProvider {
  readonly key = "offline-stub" as const;
  readonly model = "stub-model";
  readonly offline = true;
  prompts: ChatMessage[][] = [];
  replies: string[] = [];
  private next(): string {
    return this.replies.shift() ?? "an answer";
  }
  async chat(messages: ChatMessage[]) {
    this.prompts.push(messages);
    return {
      content: this.next(),
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
      model: "stub-model",
      provider: this.key,
    };
  }
  async *stream(messages: ChatMessage[]): AsyncGenerator<ChatChunk> {
    this.prompts.push(messages);
    yield { type: "delta", content: this.next() };
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

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2240 — chat retrieval reads the conversation (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let alice: string;
    let model: ScriptedProvider;
    const ALICE = "u-alice";
    const PROJECT = "p-reader";
    const OTHER = "p-other";

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
    async function newSession(): Promise<string> {
      const res = await post("/api/ai/sessions", { projectId: PROJECT });
      expect(res.status, res.text).toBe(201);
      return (res.body.data.session as { id: string }).id;
    }
    async function doc(id: string, projectId: string, filename: string): Promise<void> {
      await db.document.create({
        data: {
          id,
          projectId,
          filename,
          mimeType: "text/markdown",
          sizeBytes: 1,
          storagePath: `/tmp/${id}`,
          checksum: id,
          uploadedById: ALICE,
          status: "ready",
        },
      });
    }
    async function chunk(id: string, projectId: string, documentId: string, text: string) {
      await db.knowledgeChunk.create({
        data: { id, projectId, documentId, position: 0, text, md5: id },
      });
    }
    const hitOf = (chunkId: string, documentId: string, filename: string, text: string): Hit => ({
      chunkId,
      documentId,
      filename,
      position: 0,
      score: 0.7,
      text,
      source: "upload",
      embeddingModel: "test",
    });
    /** Everything the model was shown on its `n`th call. */
    const promptText = (n: number) => JSON.stringify(model.prompts[n]);

    beforeAll(async () => {
      sqlite = createMigratedSqlite("issue-2240-conversation-retrieval");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: ALICE, username: "alice", displayName: "alice", email: "a@example.test" },
      });
      for (const [id, name] of [
        [PROJECT, "Reader"],
        [OTHER, "Other"],
      ] as const) {
        await db.project.create({ data: { id, name, slug: id, createdById: ALICE } });
      }
      await doc("d-rules", PROJECT, "refund-rules.md");
      await chunk("k-refund", PROJECT, "d-rules", "Refunds are issued within 30 days.");
      await chunk("k-fees", PROJECT, "d-rules", "Fees are never refunded.");
      await doc("d-faq", PROJECT, "faq.md");
      await chunk("k-faq", PROJECT, "d-faq", "The FAQ says nothing of refunds.");
      await doc("d-other", OTHER, "secret.md");
      await chunk("k-other", OTHER, "d-other", "Another project's text.");
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

    beforeEach(async () => {
      model = new ScriptedProvider();
      setAIProviderForTests(model);
      state.hits = [];
      state.searches = [];
      await db.knowledgeChunk.updateMany({ data: { aclSubjects: "[]" } });
      await db.document.updateMany({ data: { deletedAt: null } });
    });

    it("searches the BA's answer to the model's question with that question and the one before", async () => {
      const sessionId = await newSession();
      model.replies = ["Refunds differ by product. Which product do you mean, Reader or Server?"];
      await post("/api/ai/stream", { sessionId, message: "How does the refund rule work?" });
      state.searches = [];
      await post("/api/ai/stream", { sessionId, message: "Server" });
      expect(state.searches.map((s) => s.query)).toEqual([
        "Server",
        "Server\nWhich product do you mean, Reader or Server?\nHow does the refund rule work?",
      ]);
      expect(state.searches.every((s) => s.projectId === PROJECT)).toBe(true);
    });

    it("keeps the excerpt an answer cited in the next turn's prompt (/stream)", async () => {
      const sessionId = await newSession();
      state.hits = [
        hitOf("k-refund", "d-rules", "refund-rules.md", "Refunds are issued within 30 days."),
        hitOf("k-faq", "d-faq", "faq.md", "The FAQ says nothing of refunds."),
      ];
      model.replies = ["Refunds are issued within 30 days [1]."];
      await post("/api/ai/stream", { sessionId, message: "How long do refunds take?" });
      // The next search finds something else entirely.
      state.hits = [hitOf("k-fees", "d-rules", "refund-rules.md", "Fees are never refunded.")];
      const res = await post("/api/ai/stream", { sessionId, message: "and for annual plans?" });
      expect(res.text).toContain("event: done");
      const second = promptText(1);
      expect(second).toContain(
        "[2] refund-rules.md#0 (cited in your previous answer)\\nRefunds are issued within 30 days.",
      );
      // The excerpt the answer did not cite is not carried.
      expect(second).not.toContain("The FAQ says nothing");
      // The grounding label counts the carried excerpt the model was shown.
      expect(res.text).toContain('"sources":2');
    });

    it("keeps the excerpt an answer cited in the next turn's prompt (/chat)", async () => {
      const sessionId = await newSession();
      state.hits = [
        hitOf("k-refund", "d-rules", "refund-rules.md", "Refunds are issued within 30 days."),
      ];
      model.replies = ["Per refund-rules.md, 30 days."];
      const first = await post("/api/ai/chat", { sessionId, message: "How long do refunds take?" });
      expect(first.status, first.text).toBe(200);
      state.hits = [];
      await post("/api/ai/chat", { sessionId, message: "and for annual plans?" });
      expect(promptText(1)).toContain(
        "[1] refund-rules.md#0 (cited in your previous answer)\\nRefunds are issued within 30 days.",
      );
    });

    it("drops a cited excerpt the requester may no longer read, or whose document was deleted", async () => {
      const sessionId = await newSession();
      state.hits = [
        hitOf("k-refund", "d-rules", "refund-rules.md", "Refunds are issued within 30 days."),
        hitOf("k-faq", "d-faq", "faq.md", "The FAQ says nothing of refunds."),
      ];
      model.replies = ["See [1] and [2]."];
      await post("/api/ai/stream", { sessionId, message: "How long do refunds take?" });
      await db.knowledgeChunk.update({
        where: { id: "k-refund" },
        data: { aclSubjects: JSON.stringify([{ kind: "user", value: "u-bob" }]) },
      });
      await db.document.update({ where: { id: "d-faq" }, data: { deletedAt: new Date() } });
      state.hits = [];
      await post("/api/ai/stream", { sessionId, message: "and for annual plans?" });
      const second = promptText(1);
      expect(second).not.toContain("Refunds are issued within 30 days");
      expect(second).not.toContain("The FAQ says nothing");
    });

    it("carries only what the most recent answer cited", async () => {
      const sessionId = await newSession();
      state.hits = [
        hitOf("k-refund", "d-rules", "refund-rules.md", "Refunds are issued within 30 days."),
      ];
      model.replies = ["30 days [1].", "I cannot tell from the sources.", "ok"];
      await post("/api/ai/stream", { sessionId, message: "How long do refunds take?" });
      state.hits = [];
      await post("/api/ai/stream", { sessionId, message: "and for annual plans?" });
      await post("/api/ai/stream", { sessionId, message: "and monthly?" });
      expect(promptText(1)).toContain("cited in your previous answer");
      expect(promptText(2)).not.toContain("Refunds are issued within 30 days");
    });

    it("limits the search to the documents attached to the question", async () => {
      const sessionId = await newSession();
      await post("/api/ai/stream", {
        sessionId,
        message: "Summarise the refund rules",
        documentIds: ["d-rules"],
      });
      expect(state.searches).toHaveLength(1);
      expect(state.searches[0]!.query).toBe("Summarise the refund rules");
      expect(state.searches[0]!.opts.documentIds).toEqual(["d-rules"]);
    });

    it("limits the search to the documents attached to the question (/chat)", async () => {
      const sessionId = await newSession();
      const res = await post("/api/ai/chat", {
        sessionId,
        message: "Summarise the refund rules",
        documentIds: ["d-rules", "d-faq"],
      });
      expect(res.status, res.text).toBe(200);
      expect(state.searches).toHaveLength(1);
      expect(state.searches[0]!.query).toBe("Summarise the refund rules");
      expect(state.searches[0]!.opts.documentIds).toEqual(["d-rules", "d-faq"]);
    });

    it("refuses an oversized attachment list before any retrieval", async () => {
      const sessionId = await newSession();
      const res = await post("/api/ai/stream", {
        sessionId,
        message: "Summarise",
        documentIds: Array.from({ length: 51 }, (_, i) => `d${i}`),
      });
      expect(res.status).toBe(400);
      expect(state.searches).toEqual([]);
    });

    it("reads chunks back for one project only, in the order asked", async () => {
      const actor = { userId: ALICE, role: "reader" };
      const got = await loadChunksById(PROJECT, ["k-fees", "k-other", "k-refund", "k-fees"], actor);
      expect(got.map((c) => c.chunkId)).toEqual(["k-fees", "k-refund"]);
      expect(got[0]).toMatchObject({
        documentId: "d-rules",
        filename: "refund-rules.md",
        source: "upload",
        text: "Fees are never refunded.",
      });
      expect(await loadChunksById(PROJECT, [], actor)).toEqual([]);
    });

    it("reads a repository chunk back with its path, and a generated one as derived", async () => {
      await doc("d-repo", PROJECT, "connector:repo:c1:src/lib/fees.ts");
      await db.document.update({ where: { id: "d-repo" }, data: { source: "repo" } });
      await chunk("k-repo", PROJECT, "d-repo", "export const fee = 1;");
      await doc("d-gen", PROJECT, "OVERVIEW.md");
      await db.document.update({ where: { id: "d-gen" }, data: { source: "generated" } });
      await chunk("k-gen", PROJECT, "d-gen", "Generated overview.");
      const got = await loadChunksById(PROJECT, ["k-repo", "k-gen"], {
        userId: ALICE,
        role: "reader",
      });
      expect(got[0]).toMatchObject({ source: "repo", path: "lib/fees.ts" });
      expect(got[0]).not.toHaveProperty("derived");
      expect(got[1]).toMatchObject({ source: "generated", derived: {} });
      expect(got[1]).not.toHaveProperty("path");
    });
  },
);
