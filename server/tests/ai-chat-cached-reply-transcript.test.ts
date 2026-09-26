/**
 * #136 — a semantic-cache hit is still an answer the user saw, so it must be
 * recorded in the server transcript. Without it the history would hold a
 * question with no reply, and the next turn's model would never see the answer.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import type { FakeAiMessageRow } from "./helpers/fake-ai-message.js";

const aiMessageRows = vi.hoisted(() => [] as FakeAiMessageRow[]);
const sessions = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("../src/lib/prisma.js", async () => {
  const { createFakeAiMessageDelegate } = await import("./helpers/fake-ai-message.js");
  const prisma: Record<string, unknown> = {
    aIMessage: createFakeAiMessageDelegate(aiMessageRows),
    $transaction: async (fn: (tx: unknown) => unknown) => fn(prisma),
    aISession: {
      findFirst: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          sessions.find((s) => s.id === where.id && s.userId === where.userId) ?? null,
      ),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = sessions.find((s) => s.id === where.id)!;
          Object.assign(row, data);
          return row;
        },
      ),
    },
    aITokenUsage: { create: vi.fn(async () => undefined) },
    auditLog: { create: vi.fn(async () => undefined) },
  };
  return { prisma };
});
vi.mock("../src/lib/ai/semantic-cache.js", () => ({
  getSemanticCache: () => ({
    enabled: true,
    lookup: async () => ({ response: "the cached answer" }),
    store: async () => undefined,
  }),
  shouldSkipCache: () => false,
}));

const { aiRouter, setAIProviderForTests } = await import("../src/routes/ai.js");
const { errorHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

let token: string;
beforeAll(() => {
  process.env.AI_RATE_LIMIT_MAX = "1000";
  token = issueTokens({
    userId: "u1",
    username: "u",
    role: "developer",
    permissions: [],
  }).accessToken;
});

beforeEach(() => {
  aiMessageRows.length = 0;
  sessions.length = 0;
  sessions.push({
    id: "s1",
    userId: "u1",
    projectId: null,
    provider: "offline-stub",
    model: "stub",
    currentModel: null,
    currentReasoningEffort: null,
    agentId: null,
    loadedSkillIds: "[]",
    providerSecretRef: null,
    snapshot: null,
    deletedAt: null,
  });
  setAIProviderForTests({
    key: "offline-stub",
    model: "stub",
    offline: true,
    chat: vi.fn(async () => {
      throw new Error("the model must not be called on a cache hit");
    }),
    async *stream() {},
    embed: async () => ({ vectors: [[1, 0]], dimension: 2, model: "e" }),
    models: async () => [],
    ping: async () => true,
  });
});

describe("POST /api/ai/chat — semantic-cache hit (#136)", () => {
  it("records the cached answer as the reply, marked cached", async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/ai", aiRouter());
    app.use(errorHandler);
    const res = await request(app)
      .post("/api/ai/chat")
      .set("Authorization", `Bearer ${token}`)
      .send({ sessionId: "s1", message: "same question" });
    expect(res.status).toBe(200);
    expect(res.body.data.response).toMatchObject({ content: "the cached answer", cached: true });
    expect(res.body.data.transcript).toEqual({ userOrdinal: 1, replyOrdinal: 2 });
    const reply = aiMessageRows.find((r) => r.ordinal === 2)!;
    expect(JSON.parse(reply.content)).toEqual([{ type: "text", text: "the cached answer" }]);
    expect(JSON.parse(reply.meta!)).toEqual({ cached: true });
    expect(reply.inputTokens).toBeNull();
    expect(JSON.parse(String(sessions[0]!.snapshot)).messages).toHaveLength(2);
  });
});
