/**
 * #2350 (PR #2428 review) — an "Ask about this" chat stays tied to its item.
 * The chat page sends the item (`subject: { kind, id }`) with every turn; the
 * server re-checks that the caller can read it and tells the model what it is,
 * whatever the analyst typed. Over the real chat routes and a real SQLite
 * database built from the migration chain; only the model is substituted, and
 * every assertion reads what reached it.
 *
 * Fixture: `u-a` belongs to `ws-a` (project "Alpha", change request "Checkout
 * v2", requirement "Pay by card"); `ws-b` holds "Bravo" and its requirement,
 * which `u-a` cannot reach. `u-a` also reaches "Gamma" in `ws-a`.
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
  process.env.RATE_LIMIT_MAX = "100000";
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

const { aiRouter, setAIProviderForTests, turnContextMessages } =
  await import("../src/routes/ai.js");
const { chatSubjectContextBlock, CHAT_SUBJECT_BODY_MAX } =
  await import("../src/lib/ai/chat-subject.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

class RecordingProvider implements AIProvider {
  readonly key = "offline-stub" as const;
  readonly model = "stub-model";
  readonly offline = true;
  prompts: ChatMessage[][] = [];
  async chat(messages: ChatMessage[]) {
    this.prompts.push(messages);
    return {
      content: "an answer",
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
      model: "stub-model",
      provider: this.key,
    };
  }
  async *stream(messages: ChatMessage[]): AsyncGenerator<ChatChunk> {
    this.prompts.push(messages);
    yield { type: "delta", content: "an answer" };
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

const SUBJECT_LEAD = "The user opened this conversation from a";
const BODY = "Customers can pay by card at checkout; Amex is excluded.";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2350 — an Ask-about-this chat tells the model its item, every turn",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let model: RecordingProvider;
    let A = "";
    const userA = {
      userId: "u-a",
      username: "u-a",
      role: "developer" as const,
      permissions: [],
      workspaces: ["ws-a"],
    };

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/ai", aiRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const post = (url: string, body: object = {}) =>
      request(app()).post(url).set("Authorization", `Bearer ${A}`).send(body);
    async function newSession(projectId = "proj-a"): Promise<string> {
      const res = await post("/api/ai/sessions", { projectId });
      expect(res.status, res.text).toBe(201);
      return (res.body.data.session as { id: string }).id;
    }
    /** The system messages the model was shown on its `n`th call. */
    const systemText = (n: number) =>
      (model.prompts[n] ?? [])
        .filter((m) => m.role === "system")
        .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
        .join("\n---\n");

    beforeAll(async () => {
      sqlite = createMigratedSqlite("2350-chat-subject-turn");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      for (const id of ["u-a", "u-b"]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
      }
      for (const [ws, user] of [
        ["ws-a", "u-a"],
        ["ws-b", "u-b"],
      ] as const) {
        await db.workspace.create({ data: { id: ws, name: ws, slug: ws } });
        await db.workspaceMember.create({ data: { workspaceId: ws, userId: user, role: "owner" } });
      }
      for (const [id, name, ws] of [
        ["proj-a", "Alpha", "ws-a"],
        ["proj-g", "Gamma", "ws-a"],
        ["proj-b", "Bravo", "ws-b"],
      ] as const) {
        await db.project.create({
          data: { id, name, slug: id, createdById: "u-a", workspaceId: ws },
        });
      }
      await db.document.create({
        data: {
          id: "doc-a",
          projectId: "proj-a",
          filename: "checkout-spec.md",
          mimeType: "text/markdown",
          sizeBytes: 1,
          storagePath: "/tmp/doc-a",
          checksum: "doc-a",
          uploadedById: "u-a",
          status: "ready",
        },
      });
      for (const [id, projectId, title, metadata] of [
        ["cr-a", "proj-a", "Checkout v2", JSON.stringify({ documentIds: ["doc-a"] })],
        ["cr-b", "proj-b", "Bravo refunds", null],
      ] as const) {
        await db.analysis.create({
          data: { id, projectId, status: "completed", title, metadata, startedAt: new Date() },
        });
      }
      for (const [id, projectId, analysisId, title, body] of [
        ["req-a", "proj-a", "cr-a", "Pay by card", BODY],
        ["req-b", "proj-b", "cr-b", "Refund within 30 days", "Bravo's secret rule."],
        ["req-long", "proj-a", "cr-a", "Long", `${"x".repeat(CHAT_SUBJECT_BODY_MAX)}TAIL"""`],
      ] as const) {
        await db.requirement.create({ data: { id, projectId, analysisId, title, body } });
      }
      A = issueTokens(userA).accessToken;
      process.env.AI_OFFLINE = "1";
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      setAIProviderForTests(null);
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(() => {
      model = new RecordingProvider();
      setAIProviderForTests(model);
    });

    it("tells the model which requirement the chat is about, though the question never names it (/stream)", async () => {
      const sessionId = await newSession();
      const res = await post("/api/ai/stream", {
        sessionId,
        message: "What does this cover?",
        subject: { kind: "requirement", id: "req-a" },
      });
      expect(res.status, res.text).toBe(200);
      expect(res.text).toContain("event: done");
      const sys = systemText(0);
      expect(sys).toContain(`${SUBJECT_LEAD} requirement in Metis.`);
      expect(sys).toContain("Project: “Alpha”");
      expect(sys).toContain("Change request: “Checkout v2”");
      expect(sys).toContain("Requirement: “Pay by card”");
      expect(sys).toContain(BODY);
      // A system message of this turn, ahead of the question.
      const prompt = model.prompts[0]!;
      const at = prompt.findIndex(
        (m) => m.role === "system" && String(m.content).startsWith(SUBJECT_LEAD),
      );
      expect(at).toBeGreaterThan(-1);
      expect(prompt[prompt.length - 1]!.role).toBe("user");
    });

    it("keeps telling it on later turns, and on /chat", async () => {
      const sessionId = await newSession();
      const subject = { kind: "change-request", id: "cr-a" };
      await post("/api/ai/stream", { sessionId, message: "hello", subject });
      const res = await post("/api/ai/chat", { sessionId, message: "and then?", subject });
      expect(res.status, res.text).toBe(200);
      expect(systemText(1)).toContain(`${SUBJECT_LEAD} change request in Metis.`);
      expect(systemText(1)).toContain("Change request: “Checkout v2”");
      expect(systemText(1)).toContain("Its source documents: “checkout-spec.md”");
    });

    it("says nothing of an item when the turn names none", async () => {
      const sessionId = await newSession();
      await post("/api/ai/stream", { sessionId, message: "hello" });
      expect(systemText(0)).not.toContain(SUBJECT_LEAD);
    });

    it("drops an item the caller cannot read, without telling the model anything of it", async () => {
      const sessionId = await newSession();
      const res = await post("/api/ai/stream", {
        sessionId,
        message: "hello",
        subject: { kind: "requirement", id: "req-b" },
      });
      expect(res.status, res.text).toBe(200);
      const sys = systemText(0);
      expect(sys).not.toContain(SUBJECT_LEAD);
      expect(sys).not.toContain("Refund within 30 days");
      expect(sys).not.toContain("Bravo's secret rule");
    });

    it("drops an item from a project the session does not search", async () => {
      const sessionId = await newSession("proj-g");
      await post("/api/ai/stream", {
        sessionId,
        message: "hello",
        subject: { kind: "requirement", id: "req-a" },
      });
      expect(systemText(0)).not.toContain(SUBJECT_LEAD);
      expect(systemText(0)).not.toContain(BODY);
    });

    it("refuses a malformed subject with 400", async () => {
      const sessionId = await newSession();
      const res = await post("/api/ai/stream", {
        sessionId,
        message: "hello",
        subject: { kind: "workspace", id: "ws-a" },
      });
      expect(res.status).toBe(400);
    });

    describe("chatSubjectContextBlock", () => {
      it("accepts an item in one of a multi-product session's projects", async () => {
        const block = await chatSubjectContextBlock(
          userA,
          { projectId: null, scopeProjectIds: JSON.stringify(["proj-g", "proj-a"]) },
          { kind: "project", id: "proj-a" },
        );
        expect(block).toContain(`${SUBJECT_LEAD} project in Metis.`);
        expect(block).toContain("Project: “Alpha”");
      });

      it("bounds a long requirement text and keeps it inside its fence", async () => {
        const block = await chatSubjectContextBlock(
          userA,
          { projectId: "proj-a" },
          { kind: "requirement", id: "req-long" },
        );
        expect(block).not.toBeNull();
        expect(block).not.toContain("TAIL");
        expect(block!.match(/"""/g)).toHaveLength(2);
      });

      it("is null for a session that searches no project by id", async () => {
        expect(
          await chatSubjectContextBlock(
            userA,
            { projectId: null, scopeProjectIds: null },
            { kind: "project", id: "proj-a" },
          ),
        ).toBeNull();
      });

      it("throws a failure that is not a refusal, rather than silently dropping the item", async () => {
        const spy = vi
          .spyOn(db.requirement, "findFirst")
          .mockRejectedValueOnce(new Error("database unavailable"));
        try {
          await expect(
            chatSubjectContextBlock(
              userA,
              { projectId: "proj-a" },
              { kind: "requirement", id: "req-a" },
            ),
          ).rejects.toThrow("database unavailable");
        } finally {
          spy.mockRestore();
        }
      });

      it("is null with no subject or for an unknown one", async () => {
        expect(await chatSubjectContextBlock(userA, { projectId: "proj-a" }, undefined)).toBeNull();
        expect(
          await chatSubjectContextBlock(
            userA,
            { projectId: "proj-a" },
            { kind: "requirement", id: "nope" },
          ),
        ).toBeNull();
      });
    });

    it("turnContextMessages puts the item before what retrieval found", () => {
      expect(turnContextMessages("item", "rag")).toEqual([
        { role: "system", content: "item" },
        { role: "system", content: "rag" },
      ]);
      expect(turnContextMessages(null, "")).toEqual([]);
    });
  },
);
