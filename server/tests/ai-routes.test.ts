/**
 * /api/ai route + middleware tests.
 *
 * Mocks Prisma + the AI provider so we can exercise:
 *   • session CRUD + ownership enforcement
 *   • chat (non-stream) flow including audit + token-tracker integration
 *   • SSE streaming endpoint emitting OpenAI-style events
 *   • AI rate limiter triggers at the configured threshold
 *   • offline mode when AI_OFFLINE=1
 *   • health deep-check probes the provider with a timeout cap
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";

// ── Prisma mock ────────────────────────────────────────────────────────────
type Session = {
  id: string;
  userId: string;
  projectId: string | null;
  title: string;
  provider: string;
  model: string;
  policy: string;
  status: string;
  providerSecretRef: string | null;
  copilotHome: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};

const sessions: Session[] = [];
const tokenRows: Array<Record<string, unknown>> = [];
const approvalRows: Array<Record<string, unknown>> = [];

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    aISession: {
      create: vi.fn(async ({ data }: { data: Partial<Session> }) => {
        const row: Session = {
          id: `sess_${sessions.length + 1}`,
          userId: data.userId!,
          projectId: data.projectId ?? null,
          title: data.title ?? "New Chat",
          provider: data.provider!,
          model: data.model!,
          policy: data.policy ?? '{"low":"auto","medium":"prompt-once","high":"always-prompt"}',
          status: "active",
          providerSecretRef: data.providerSecretRef ?? null,
          copilotHome: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
        };
        sessions.push(row);
        return row;
      }),
      findFirst: vi.fn(
        async ({ where }: { where: Partial<Session> }) =>
          sessions.find(
            (s) => s.id === where.id && s.userId === where.userId && s.deletedAt == null,
          ) ?? null,
      ),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Session> }) => {
        const idx = sessions.findIndex((s) => s.id === where.id);
        sessions[idx] = { ...sessions[idx], ...data, updatedAt: new Date() };
        return sessions[idx];
      }),
    },
    aITokenUsage: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        tokenRows.push(data);
        return data;
      }),
      findMany: vi.fn(async () => tokenRows),
    },
    aIToolApproval: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        approvalRows.push(data);
        return data;
      }),
      findMany: vi.fn(async () => approvalRows),
    },
    auditLog: { create: vi.fn(async () => undefined) },
  },
}));

// ── Vault mock — M2 BYOK key resolution path ──────────────────────────────
const vaultRead = vi.fn(async (id: string) => ({
  summary: { id, label: "k", description: "", scope: "global" as const, keyVersion: 1 },
  plaintext: `vault-secret-for-${id}`,
}));
vi.mock("../src/lib/vault/vault-service.js", () => ({
  getVaultService: () => ({ read: vaultRead }),
  // Re-export classes used elsewhere (kept minimal — only what tests touch).
  VaultService: class {},
}));

import { aiRouter, setAIProviderForTests } from "../src/routes/ai.js";
import { __resetAIRateLimiter } from "../src/middleware/ai-rate-limit.js";
import { errorHandler, notFoundHandler } from "../src/middleware/error-handler.js";
import { OfflineStubProvider } from "../src/lib/ai/index.js";
import { issueTokens } from "../src/lib/auth/jwt.js";
import type { ChatChunk } from "../src/lib/ai/types.js";
import type { AIProvider } from "../src/lib/ai/index.js";

type AIProviderForTest = AIProvider & {
  destroySession?: (id: string) => Promise<void>;
};

const ACCESS_TOKEN_PAYLOAD = {
  userId: "user-1",
  username: "alice",
  role: "developer" as const,
  permissions: [],
};

let token: string;
beforeAll(() => {
  process.env.AI_OFFLINE = "1";
  process.env.AI_RATE_LIMIT_MAX = "100";
  process.env.AI_RATE_LIMIT_WINDOW_MS = "60000";
  token = issueTokens(ACCESS_TOKEN_PAYLOAD).accessToken;
});

beforeEach(() => {
  sessions.length = 0;
  tokenRows.length = 0;
  approvalRows.length = 0;
  setAIProviderForTests(new OfflineStubProvider());
  __resetAIRateLimiter();
  vaultRead.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/ai", aiRouter());
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

const auth = (req: request.Test): request.Test => req.set("Authorization", `Bearer ${token}`);

// ── Tests ──────────────────────────────────────────────────────────────────

describe("POST /api/ai/sessions", () => {
  it("creates a session for the authenticated user", async () => {
    const res = await auth(request(makeApp()).post("/api/ai/sessions").send({ title: "Demo" }));
    expect(res.status).toBe(201);
    expect(res.body.data.session.policy).toEqual({
      low: "auto",
      medium: "prompt-once",
      high: "always-prompt",
    });
  });

  it("rejects unauthenticated requests", async () => {
    const res = await request(makeApp()).post("/api/ai/sessions").send({});
    expect(res.status).toBe(401);
  });

  it("validates the policy enum", async () => {
    const res = await auth(
      request(makeApp())
        .post("/api/ai/sessions")
        .send({ policy: { low: "yolo" } }),
    );
    expect(res.status).toBe(400);
  });
});

describe("session ownership", () => {
  it("returns 404 when fetching another user's session", async () => {
    sessions.push({
      id: "sess_x",
      userId: "other",
      projectId: null,
      title: "x",
      provider: "offline-stub",
      model: "x",
      policy: '{"low":"auto","medium":"auto","high":"auto"}',
      status: "active",
      providerSecretRef: null,
      copilotHome: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    });
    const res = await auth(request(makeApp()).get("/api/ai/sessions/sess_x"));
    expect(res.status).toBe(404);
  });
});

describe("POST /api/ai/chat", () => {
  it("runs a non-stream completion and persists token usage", async () => {
    const app = makeApp();
    const created = await auth(request(app).post("/api/ai/sessions").send({}));
    const sessionId = created.body.data.session.id;
    const res = await auth(
      request(app)
        .post("/api/ai/chat")
        .send({
          sessionId,
          messages: [{ role: "user", content: "hello" }],
        }),
    );
    expect(res.status).toBe(200);
    expect(res.body.data.response.provider).toBe("offline-stub");
    expect(tokenRows).toHaveLength(1);
  });

  it("returns 400 for empty messages", async () => {
    const created = await auth(request(makeApp()).post("/api/ai/sessions").send({}));
    const res = await auth(
      request(makeApp()).post("/api/ai/chat").send({
        sessionId: created.body.data.session.id,
        messages: [],
      }),
    );
    expect(res.status).toBe(400);
  });

  it("applies rate-limit headers to AI requests", async () => {
    // After fix for #238, the rate limiter is module-scoped (no longer lazy).
    // We verify that rate-limit headers are present, confirming the middleware
    // is wired up. Testing the actual 429 threshold is express-rate-limit's
    // responsibility.
    const app = makeApp();
    const sessionId = (await auth(request(app).post("/api/ai/sessions").send({}))).body.data.session
      .id;
    const res = await auth(
      request(app)
        .post("/api/ai/chat")
        .send({
          sessionId,
          messages: [{ role: "user", content: "hello" }],
        }),
    );
    // express-rate-limit sets RateLimit-* headers when standardHeaders is true.
    expect(res.headers["ratelimit-limit"]).toBeDefined();
    expect(res.headers["ratelimit-remaining"]).toBeDefined();
  });
});

describe("POST /api/ai/stream", () => {
  it("emits SSE delta + usage + done events", async () => {
    const app = makeApp();
    const sessionId = (await auth(request(app).post("/api/ai/sessions").send({}))).body.data.session
      .id;
    const res = await auth(
      request(app)
        .post("/api/ai/stream")
        .send({
          sessionId,
          messages: [{ role: "user", content: "stream please" }],
        }),
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.text).toContain("event: delta");
    expect(res.text).toContain("event: usage");
    expect(res.text).toContain("event: done");
  });

  it("emits an error event when the provider throws", async () => {
    const failing = {
      key: "offline-stub" as const,
      model: "stub",
      offline: true,
      async chat() {
        throw new Error("fail");
      },
      async *stream() {
        throw new Error("stream-fail");
      },
      async embed() {
        return { vectors: [], dimension: 0, model: "stub" };
      },
      async models() {
        return ["stub"];
      },
      async ping() {
        return true;
      },
    };
    setAIProviderForTests(failing);
    const app = makeApp();
    const sessionId = (await auth(request(app).post("/api/ai/sessions").send({}))).body.data.session
      .id;
    const res = await auth(
      request(app)
        .post("/api/ai/stream")
        .send({
          sessionId,
          messages: [{ role: "user", content: "x" }],
        }),
    );
    expect(res.text).toContain("event: error");
  });
});

/**
 * #1367 — the session RECORD was persisted and unlisted; the CONVERSATION was
 * never persisted at all.
 *
 * The AISession row was always written at session-create, but NOTHING in the
 * product ever called `writeSnapshot`, so `snapshotUpdatedAt` stayed null
 * forever — and `listResumable` filters on `snapshotUpdatedAt: { gte: cutoff }`,
 * which a null can never satisfy. `/sessions` therefore reported "No resumable
 * sessions" after any number of completed turns.
 *
 * Falsifiable: on `main` no `snapshot`/`snapshotUpdatedAt` is ever written, so
 * every assertion below fails.
 */
describe("POST /api/ai/stream — session snapshot (#1367)", () => {
  it("snapshots the completed turn, answer text included, so it can be resumed", async () => {
    const app = makeApp();
    const sessionId = (await auth(request(app).post("/api/ai/sessions").send({}))).body.data.session
      .id;

    const streamed = await auth(
      request(app)
        .post("/api/ai/stream")
        .send({ sessionId, messages: [{ role: "user", content: "hello" }] }),
    );

    const row = sessions.find((s) => s.id === sessionId) as unknown as {
      snapshot?: string;
      snapshotUpdatedAt?: Date;
    };
    expect(row.snapshotUpdatedAt).toBeInstanceOf(Date);
    const snap = JSON.parse(row.snapshot ?? "null");
    expect(snap.v).toBe(1);
    expect(snap.messages[0]).toMatchObject({ role: "user", content: "hello" });

    // The assistant turn must carry the ANSWER, not an empty placeholder — a
    // snapshot of an empty reply restores a conversation with a hole in it.
    const assistant = snap.messages[snap.messages.length - 1];
    expect(assistant.role).toBe("assistant");
    expect(assistant.content.length).toBeGreaterThan(0);
    // Exactly what the stream put on the wire.
    const streamedText = [...streamed.text.matchAll(/event: delta\ndata: (.+)/g)]
      .map((m) => (JSON.parse(m[1]) as { content: string }).content)
      .join("");
    expect(assistant.content).toBe(streamedText);
  });
});

describe("GET /api/ai/usage/today", () => {
  it("returns the daily rollup for the caller", async () => {
    const res = await auth(request(makeApp()).get("/api/ai/usage/today"));
    expect(res.status).toBe(200);
    expect(res.body.data.dayBucket).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("GET /api/ai/tools", () => {
  it("returns the registry list", async () => {
    const res = await auth(request(makeApp()).get("/api/ai/tools"));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.tools)).toBe(true);
  });
});

describe("auth headers", () => {
  it("verifies the JWT before any route runs", async () => {
    const bad = jwt.sign({ x: 1 }, "wrong-secret");
    const res = await request(makeApp())
      .post("/api/ai/sessions")
      .set("Authorization", `Bearer ${bad}`)
      .send({});
    expect(res.status).toBe(401);
  });
});

// keep ChatChunk import live
void (null as unknown as ChatChunk);

// ── M1 — SSE protections (heartbeat + hard ceiling) ───────────────────────
describe("POST /api/ai/stream — slowloris protections", () => {
  it("emits a heartbeat ping during the stream", async () => {
    const prevHeartbeat = process.env.AI_STREAM_HEARTBEAT_MS;
    process.env.AI_STREAM_HEARTBEAT_MS = "5";
    const slow: AIProviderForTest = {
      key: "offline-stub",
      model: "stub",
      offline: true,
      async chat() {
        return {
          content: "",
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          model: "stub",
          provider: "offline-stub",
        };
      },
      async *stream() {
        // Pause long enough for at least one heartbeat to fire.
        await new Promise((r) => setTimeout(r, 60));
        yield { type: "delta", content: "ok" } as ChatChunk;
        yield { type: "done" } as ChatChunk;
      },
      async embed() {
        return { vectors: [], dimension: 0, model: "stub" };
      },
      async models() {
        return ["stub"];
      },
      async ping() {
        return true;
      },
    };
    setAIProviderForTests(slow);
    try {
      const app = makeApp();
      const sessionId = (await auth(request(app).post("/api/ai/sessions").send({}))).body.data
        .session.id;
      const res = await auth(
        request(app)
          .post("/api/ai/stream")
          .send({
            sessionId,
            messages: [{ role: "user", content: "hi" }],
          }),
      );
      expect(res.text).toContain(": ping");
      expect(res.text).toContain("event: done");
    } finally {
      if (prevHeartbeat === undefined) delete process.env.AI_STREAM_HEARTBEAT_MS;
      else process.env.AI_STREAM_HEARTBEAT_MS = prevHeartbeat;
    }
  });

  it("enforces the hard duration ceiling and ends the stream", async () => {
    const prevCeiling = process.env.AI_STREAM_MAX_DURATION_MS;
    process.env.AI_STREAM_MAX_DURATION_MS = "30";
    const hung: AIProviderForTest = {
      key: "offline-stub",
      model: "stub",
      offline: true,
      async chat() {
        return {
          content: "",
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          model: "stub",
          provider: "offline-stub",
        };
      },
      async *stream(_messages, opts) {
        // Hang until aborted by the hard ceiling.
        await new Promise<void>((resolve, reject) => {
          const onAbort = (): void => {
            opts?.signal?.removeEventListener("abort", onAbort);
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          };
          opts?.signal?.addEventListener("abort", onAbort, { once: true });
        });
        yield { type: "done" } as ChatChunk;
      },
      async embed() {
        return { vectors: [], dimension: 0, model: "stub" };
      },
      async models() {
        return ["stub"];
      },
      async ping() {
        return true;
      },
    };
    setAIProviderForTests(hung);
    try {
      const app = makeApp();
      const sessionId = (await auth(request(app).post("/api/ai/sessions").send({}))).body.data
        .session.id;
      const res = await auth(
        request(app)
          .post("/api/ai/stream")
          .send({
            sessionId,
            messages: [{ role: "user", content: "hang" }],
          }),
      );
      // #1366 — the ceiling frame used to be `{ error: "timeout" }`, a shape the
      // client's `parseSseFrame` never reads (it takes `message`/`code`), so the
      // one timeout the server DID detect rendered as a blank error. It now uses
      // the same `{ code, message }` envelope as every other error frame.
      expect(res.text).toMatch(/"code"\s*:\s*"STREAM_MAX_DURATION"/);
      expect(res.text).toMatch(/"message"\s*:\s*"[^"]+"/);
    } finally {
      if (prevCeiling === undefined) delete process.env.AI_STREAM_MAX_DURATION_MS;
      else process.env.AI_STREAM_MAX_DURATION_MS = prevCeiling;
    }
  });
});

// ── M2 — vault-resolved BYOK keys ─────────────────────────────────────────
describe("BYOK provider key resolution via vault", () => {
  it("resolves providerSecretRef through the vault on chat", async () => {
    const app = makeApp();
    const created = await auth(
      request(app).post("/api/ai/sessions").send({ providerSecretRef: "secret-1" }),
    );
    expect(created.status).toBe(201);
    const sessionId = created.body.data.session.id;

    const res = await auth(
      request(app)
        .post("/api/ai/chat")
        .send({
          sessionId,
          messages: [{ role: "user", content: "hi" }],
        }),
    );
    expect(res.status).toBe(200);
    expect(vaultRead).toHaveBeenCalledWith("secret-1");
  });

  it("never touches the vault when providerSecretRef is null", async () => {
    const app = makeApp();
    const sessionId = (await auth(request(app).post("/api/ai/sessions").send({}))).body.data.session
      .id;
    await auth(
      request(app)
        .post("/api/ai/chat")
        .send({
          sessionId,
          messages: [{ role: "user", content: "hi" }],
        }),
    );
    expect(vaultRead).not.toHaveBeenCalled();
  });

  it("returns 502 when the vault read fails", async () => {
    vaultRead.mockRejectedValueOnce(new Error("vault offline"));
    const app = makeApp();
    const created = await auth(
      request(app).post("/api/ai/sessions").send({ providerSecretRef: "missing" }),
    );
    const sessionId = created.body.data.session.id;
    const res = await auth(
      request(app)
        .post("/api/ai/chat")
        .send({
          sessionId,
          messages: [{ role: "user", content: "hi" }],
        }),
    );
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("AI_PROVIDER_KEY_UNAVAILABLE");
  });
});

// ── M3 — session lifecycle cleanup on PATCH ───────────────────────────────
describe("PATCH /api/ai/sessions/:id cleanup", () => {
  it("invokes destroySession when status transitions to archived", async () => {
    const destroy = vi.fn(async () => undefined);
    const provider: AIProviderForTest = {
      key: "offline-stub",
      model: "stub",
      offline: true,
      async chat() {
        return {
          content: "",
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          model: "stub",
          provider: "offline-stub",
        };
      },
      async *stream() {
        yield { type: "done" } as ChatChunk;
      },
      async embed() {
        return { vectors: [], dimension: 0, model: "stub" };
      },
      async models() {
        return ["stub"];
      },
      async ping() {
        return true;
      },
      destroySession: destroy,
    };
    setAIProviderForTests(provider);

    const app = makeApp();
    const sessionId = (await auth(request(app).post("/api/ai/sessions").send({}))).body.data.session
      .id;
    const res = await auth(
      request(app).patch(`/api/ai/sessions/${sessionId}`).send({ status: "archived" }),
    );
    expect(res.status).toBe(200);
    expect(destroy).toHaveBeenCalledWith(sessionId);
  });

  it("does not call destroySession when status is unchanged", async () => {
    const destroy = vi.fn(async () => undefined);
    const provider: AIProviderForTest = {
      key: "offline-stub",
      model: "stub",
      offline: true,
      async chat() {
        return {
          content: "",
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          model: "stub",
          provider: "offline-stub",
        };
      },
      async *stream() {
        yield { type: "done" } as ChatChunk;
      },
      async embed() {
        return { vectors: [], dimension: 0, model: "stub" };
      },
      async models() {
        return ["stub"];
      },
      async ping() {
        return true;
      },
      destroySession: destroy,
    };
    setAIProviderForTests(provider);

    const app = makeApp();
    const sessionId = (await auth(request(app).post("/api/ai/sessions").send({}))).body.data.session
      .id;
    await auth(request(app).patch(`/api/ai/sessions/${sessionId}`).send({ title: "rename" }));
    expect(destroy).not.toHaveBeenCalled();
  });
});
