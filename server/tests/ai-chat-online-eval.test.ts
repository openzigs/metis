/**
 * Issue #1321 — the online-eval observer's REAL consumers: `POST /api/ai/chat`
 * and `POST /api/ai/stream`.
 *
 * `/stream` is the one the product actually calls (`ui/src/lib/ai-client.ts`
 * `streamChat`, used by the chat and workbench pages); wiring only `/chat`
 * produced a sampler that was structurally correct and sampled nothing.
 *
 * The acceptance criterion is that scoring is "fully out-of-band: no added
 * latency, no change to any user-visible output, failures never fail the run".
 * A comment cannot prove that, so this exercises the real routes:
 *
 *   • the observer is handed the question, the answer and the RAG contexts
 *   • the response body / SSE frames are identical with the observer wired in
 *   • an observer that throws synchronously does not turn the chat into a 500
 *   • the observer is invoked AFTER the response has been written
 *   • an answer is only accumulated on the stream path when the sampler is ON
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";

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
          providerSecretRef: null,
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
    aITokenUsage: { create: vi.fn(async () => undefined), findMany: vi.fn(async () => []) },
    aIToolApproval: { create: vi.fn(async () => undefined), findMany: vi.fn(async () => []) },
    auditLog: { create: vi.fn(async () => undefined) },
  },
}));

vi.mock("../src/lib/vault/vault-service.js", () => ({
  getVaultService: () => ({ read: vi.fn(async () => ({ plaintext: "x" })) }),
  VaultService: class {},
}));

const { aiRouter, setAIProviderForTests } = await import("../src/routes/ai.js");
const { __resetAIRateLimiter } = await import("../src/middleware/ai-rate-limit.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { OfflineStubProvider } = await import("../src/lib/ai/index.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { __setOnlineEvalScorer } = await import("../src/lib/eval/online/scorer.js");
type OnlineEvalScorer = import("../src/lib/eval/online/scorer.js").OnlineEvalScorer;
type LiveRunCandidate = Parameters<OnlineEvalScorer["observe"]>[0];

let token: string;
beforeAll(() => {
  process.env.AI_OFFLINE = "1";
  process.env.AI_RATE_LIMIT_MAX = "1000";
  process.env.AI_RATE_LIMIT_WINDOW_MS = "60000";
  token = issueTokens({
    userId: "user-1",
    username: "alice",
    role: "developer" as const,
    permissions: [],
  }).accessToken;
});

/** A stand-in scorer that records what it was handed. */
class RecordingScorer {
  seen: LiveRunCandidate[] = [];
  throwOnObserve = false;
  /** Mirrors the real scorer's cheap sync probe (default ON for these tests). */
  isEnabled = true;
  enabledCalls = 0;
  enabled(): boolean {
    this.enabledCalls += 1;
    return this.isEnabled;
  }
  observe(c: LiveRunCandidate): void {
    this.seen.push(c);
    if (this.throwOnObserve) throw new Error("observer exploded");
  }
  async drain(): Promise<void> {}
}

let recorder: RecordingScorer;

beforeEach(() => {
  sessions.length = 0;
  setAIProviderForTests(new OfflineStubProvider());
  __resetAIRateLimiter();
  recorder = new RecordingScorer();
  __setOnlineEvalScorer(recorder as unknown as OnlineEvalScorer);
});

afterEach(() => {
  __setOnlineEvalScorer(null);
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

async function chat(app: express.Express, content = "how do refunds work?") {
  const sessionId = (await auth(request(app).post("/api/ai/sessions").send({}))).body.data.session
    .id;
  return await auth(
    request(app)
      .post("/api/ai/chat")
      .send({ sessionId, messages: [{ role: "user", content }] }),
  );
}

describe("POST /api/ai/chat — online eval observer (#1321)", () => {
  it("hands the observer the user's question and the answer that was sent", async () => {
    const app = makeApp();
    const res = await chat(app);
    expect(res.status).toBe(200);
    expect(recorder.seen).toHaveLength(1);
    expect(recorder.seen[0].surface).toBe("chat");
    expect(recorder.seen[0].question).toBe("how do refunds work?");
    expect(recorder.seen[0].answer).toBe(res.body.data.response.content);
  });

  it("does not alter the user-visible response", async () => {
    const app = makeApp();
    const withObserver = await chat(app);

    // Same request with a no-op observer that records nothing.
    __setOnlineEvalScorer(new RecordingScorer() as unknown as OnlineEvalScorer);
    const control = await chat(app);
    expect(withObserver.body.data.response.content).toBe(control.body.data.response.content);
    expect(withObserver.status).toBe(control.status);
  });

  it("a throwing observer does not fail the user's chat", async () => {
    recorder.throwOnObserve = true;
    const res = await chat(makeApp());
    // The route must still have answered 200 with a body.
    expect(res.status).toBe(200);
    expect(res.body.data.response.content).toBeTruthy();
  });

  it("observes AFTER the response has been written", async () => {
    let headersSentAtObserve: boolean | null = null;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      const original = recorder.observe.bind(recorder);
      recorder.observe = (c: LiveRunCandidate) => {
        headersSentAtObserve = res.headersSent;
        original(c);
      };
      next();
    });
    app.use("/api/ai", aiRouter());
    app.use(notFoundHandler);
    app.use(errorHandler);

    await chat(app);
    expect(headersSentAtObserve).toBe(true);
  });
});

async function stream(app: express.Express, content = "how do refunds work?") {
  const sessionId = (await auth(request(app).post("/api/ai/sessions").send({}))).body.data.session
    .id;
  return await auth(
    request(app)
      .post("/api/ai/stream")
      .send({ sessionId, messages: [{ role: "user", content }] }),
  );
}

/** Reassemble the answer the user saw from the SSE `delta` frames. */
function answerFromSse(text: string): string {
  return text
    .split("\n\n")
    .filter((f) => f.startsWith("event: delta"))
    .map((f) => {
      const line = f.split("\n").find((l) => l.startsWith("data: "));
      return line ? (JSON.parse(line.slice(6)) as { content: string }).content : "";
    })
    .join("");
}

describe("POST /api/ai/stream — online eval observer (#1321)", () => {
  it("hands the observer the question and the answer the user was streamed", async () => {
    const res = await stream(makeApp());
    expect(res.status).toBe(200);
    const streamed = answerFromSse(res.text);
    expect(streamed).toBeTruthy();
    expect(recorder.seen).toHaveLength(1);
    expect(recorder.seen[0].surface).toBe("chat");
    expect(recorder.seen[0].question).toBe("how do refunds work?");
    expect(recorder.seen[0].answer).toBe(streamed);
  });

  it("does not alter the streamed frames", async () => {
    const withObserver = await stream(makeApp());
    recorder.isEnabled = false;
    const control = await stream(makeApp());
    expect(answerFromSse(withObserver.text)).toBe(answerFromSse(control.text));
    expect(withObserver.status).toBe(control.status);
  });

  it("observes nothing while the sampler is OFF, having only probed the flag", async () => {
    recorder.isEnabled = false;
    const res = await stream(makeApp());
    expect(res.status).toBe(200);
    // The user still gets the whole answer…
    expect(answerFromSse(res.text)).toBeTruthy();
    // …the cheap sync probe ran (that is what suppresses the accumulation)…
    expect(recorder.enabledCalls).toBeGreaterThan(0);
    // …and nothing was handed to the observer.
    expect(recorder.seen).toEqual([]);
  });

  it("a throwing observer does not break the stream", async () => {
    recorder.throwOnObserve = true;
    const res = await stream(makeApp());
    expect(res.status).toBe(200);
    expect(answerFromSse(res.text)).toBeTruthy();
    expect(res.text).toContain("event: done");
  });

  it("observes only AFTER every frame — including `done` — is on the wire", async () => {
    let writtenAtObserve: string | null = null;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      // Only the stream request; the session-create request has no frames and
      // would otherwise overwrite the capture through the wrapper chain.
      if (!req.path.endsWith("/stream")) return next();
      const chunks: string[] = [];
      const write = res.write.bind(res);
      res.write = ((chunk: unknown, ...rest: unknown[]) => {
        chunks.push(String(chunk));
        return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof res.write;
      const original = recorder.observe.bind(recorder);
      recorder.observe = (c: LiveRunCandidate) => {
        writtenAtObserve = chunks.join("");
        original(c);
      };
      next();
    });
    app.use("/api/ai", aiRouter());
    app.use(notFoundHandler);
    app.use(errorHandler);

    await stream(app);
    expect(writtenAtObserve).toContain("event: done");
    // The whole answer was already streamed before the observer ran.
    expect(answerFromSse(writtenAtObserve ?? "")).toBe(recorder.seen[0].answer);
  });
});
