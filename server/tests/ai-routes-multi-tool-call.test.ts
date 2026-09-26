/**
 * #15 — chat-route proof that a multi-tool-call reply is EXECUTED and that no
 * tool markup ever reaches the rendered answer.
 *
 * Observed live: in project chat the model replied with the nested
 * `<tool_calls>` form DeepSeek emits, the agent loop did not recognise it, and
 * the markup itself was rendered to the user as the assistant's answer. These
 * tests drive the real `/api/ai/chat` and `/api/ai/stream` routes with the
 * code-search tools enabled for a project-scoped session; only Prisma, the
 * provider and the two code tools are stubbed.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import type { FakeAiMessageRow } from "./helpers/fake-ai-message.js";

type Row = Record<string, unknown>;
const sessions: Row[] = [];

/**
 * Prisma stub: the AI-session model is real enough to create/read a session;
 * every other model the route touches on a project-scoped session (skills,
 * safety settings, usage rows, snapshots) answers with "nothing stored".
 */
// #136 — the transcript store needs a working `aIMessage` model.
const aiMessageRows = vi.hoisted(() => [] as FakeAiMessageRow[]);

vi.mock("../src/lib/prisma.js", async () => {
  const { createFakeAiMessageDelegate } = await import("./helpers/fake-ai-message.js");
  const generic = (): Record<string, unknown> =>
    new Proxy(
      {},
      {
        get: (_t, method: string) =>
          vi.fn(async () => (method === "findMany" ? [] : method === "count" ? 0 : null)),
      },
    );
  const aISession = {
    create: vi.fn(async ({ data }: { data: Row }) => {
      const row: Row = {
        id: `sess_${sessions.length + 1}`,
        userId: data.userId,
        projectId: data.projectId ?? null,
        title: data.title ?? "New Chat",
        provider: data.provider,
        model: data.model,
        policy: '{"low":"auto","medium":"prompt-once","high":"always-prompt"}',
        status: "active",
        providerSecretRef: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      };
      sessions.push(row);
      return row;
    }),
    findFirst: vi.fn(
      async ({ where }: { where: Row }) =>
        sessions.find((s) => s.id === where.id && s.userId === where.userId) ?? null,
    ),
    update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const row = sessions.find((s) => s.id === where.id) as Row;
      Object.assign(row, data);
      return row;
    }),
  };
  // #136 — chat reads now check project access; the project exists and has no
  // workspace (open to every authenticated user, as legacy projects are).
  const project = {
    findUnique: vi.fn(async () => ({ workspaceId: null, contextCompactionThreshold: null })),
    findFirst: vi.fn(async () => ({ aiProviderId: null, aiModel: null })),
  };
  const models: Record<string, unknown> = {
    aISession,
    project,
    aIMessage: createFakeAiMessageDelegate(aiMessageRows),
  };
  const prisma: Record<string, unknown> = new Proxy(models, {
    get: (target, key: string) => {
      if (key === "$transaction") return async (fn: (tx: unknown) => unknown) => fn(prisma);
      if (!(key in target)) target[key] = generic();
      return target[key];
    },
  });
  return { prisma };
});

/** Stub code tools that record the order they ran in. */
const executed: string[] = [];
vi.mock("../src/lib/analysis/tools/index.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const tool = (name: string) => ({
    name,
    description: name,
    parameters: { type: "object", properties: { query: { type: "string" } } },
    async execute(args: { query?: string }) {
      executed.push(`${name}:${args.query ?? ""}`);
      return { content: `RESULT(${name}:${args.query ?? ""})`, resultCount: 1 };
    },
  });
  return {
    ...actual,
    getChatCodeTools: () => [tool("search_code_graph"), tool("search_code_symbols")],
  };
});

import { aiRouter, setAIProviderForTests } from "../src/routes/ai.js";
import { __resetAIRateLimiter } from "../src/middleware/ai-rate-limit.js";
import { errorHandler, notFoundHandler } from "../src/middleware/error-handler.js";
import { issueTokens } from "../src/lib/auth/jwt.js";
import type { AIProvider, ChatMessage, ChatResponse } from "../src/lib/ai/types.js";

const DEEPSEEK_NESTED = [
  "<tool_calls>",
  '  <tool_calls>{"tool": "search_code_symbols", "args": {"query": "DNS rebinding SSRF", "limit": 15}}</tool_calls>',
  '  <tool_calls>{"tool": "search_code_symbols", "args": {"query": "pinned lookup"}}</tool_calls>',
  '  <tool_calls>{"tool": "search_code_graph", "args": {"query": "safeFetch"}}</tool_calls>',
  "</tool_calls>",
].join("\n");
const ANSWER = "DNS rebinding is blocked: safeFetch pins the resolved address.";

/** A provider whose non-streaming `chat` plays a script (the tool loop is non-streaming). */
function scriptedProvider(script: string[]): { provider: AIProvider; seen: ChatMessage[][] } {
  let i = 0;
  const seen: ChatMessage[][] = [];
  const provider = {
    key: "offline-stub",
    model: "stub",
    offline: true,
    async chat(messages: ChatMessage[]): Promise<ChatResponse> {
      seen.push(messages.map((m) => ({ ...m })));
      const content = script[Math.min(i, script.length - 1)] as string;
      i += 1;
      return {
        content,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        model: "stub",
        provider: "offline-stub",
      };
    },
    async *stream() {
      throw new Error("the code-tool path must not stream");
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
  } as unknown as AIProvider;
  return { provider, seen };
}

let token: string;
beforeAll(() => {
  process.env.AI_OFFLINE = "1";
  process.env.AI_RATE_LIMIT_MAX = "100";
  process.env.AI_RATE_LIMIT_WINDOW_MS = "60000";
  process.env.CHAT_CODE_SEARCH_TOOLS = "true";
  token = issueTokens({
    userId: "user-1",
    username: "alice",
    role: "developer",
    permissions: [],
  }).accessToken;
});

beforeEach(() => {
  sessions.length = 0;
  aiMessageRows.length = 0;
  executed.length = 0;
  __resetAIRateLimiter();
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

async function projectSession(app: express.Express): Promise<string> {
  const created = await auth(
    request(app).post("/api/ai/sessions").send({ projectId: "proj-1", title: "p" }),
  );
  expect(created.status).toBe(201);
  const id = created.body.data.session.id as string;
  // Pin the project scope directly: the code tools are offered only to a
  // project-scoped session, whatever the create route chose to persist.
  const row = sessions.find((s) => s.id === id) as Row;
  row.projectId = "proj-1";
  return id;
}

/** The SSE `delta` payloads, concatenated — i.e. exactly what the UI renders. */
function renderedDeltas(sse: string): string {
  return sse
    .split("\n\n")
    .filter((frame) => frame.startsWith("event: delta"))
    .map((frame) => {
      const data = frame.split("\n").find((l) => l.startsWith("data: ")) ?? "data: {}";
      return (JSON.parse(data.slice(6)) as { content?: string }).content ?? "";
    })
    .join("");
}

describe("#15 POST /api/ai/chat — multi-tool-call reply", () => {
  it("executes every requested tool and renders only the model's real answer", async () => {
    const { provider, seen } = scriptedProvider([DEEPSEEK_NESTED, ANSWER]);
    setAIProviderForTests(provider);
    const app = makeApp();
    const sessionId = await projectSession(app);

    const res = await auth(
      request(app)
        .post("/api/ai/chat")
        .send({
          sessionId,
          messages: [{ role: "user", content: "How is DNS rebinding blocked?" }],
        }),
    );

    expect(res.status).toBe(200);
    expect(executed).toEqual([
      "search_code_symbols:DNS rebinding SSRF",
      "search_code_symbols:pinned lookup",
      "search_code_graph:safeFetch",
    ]);
    // All three results went back to the model on the next turn.
    const lastTurn = (seen[1] as ChatMessage[]).at(-1)?.content ?? "";
    expect(lastTurn).toContain("RESULT(search_code_graph:safeFetch)");

    const content = JSON.stringify(res.body.data);
    expect(content).toContain(ANSWER);
    expect(content).not.toContain("tool_calls");
    expect(content).not.toContain('\\"tool\\"');
  });

  it("never renders tool markup the loop could not parse", async () => {
    const broken = '<tool_calls>\n  <tool_calls>{"tool": "search_code_symbols", "args": {"query"';
    const { provider } = scriptedProvider([broken]);
    setAIProviderForTests(provider);
    const app = makeApp();
    const sessionId = await projectSession(app);

    const res = await auth(
      request(app)
        .post("/api/ai/chat")
        .send({ sessionId, messages: [{ role: "user", content: "q" }] }),
    );

    expect(res.status).toBe(200);
    const content = JSON.stringify(res.body.data);
    expect(content).not.toContain("tool_calls");
    expect(content).not.toContain('\\"tool\\"');
  });
});

describe("#15 POST /api/ai/stream — multi-tool-call reply", () => {
  it("emits one tool_call frame per call and streams only the real answer", async () => {
    const { provider } = scriptedProvider([DEEPSEEK_NESTED, ANSWER]);
    setAIProviderForTests(provider);
    const app = makeApp();
    const sessionId = await projectSession(app);

    const res = await auth(
      request(app)
        .post("/api/ai/stream")
        .send({
          sessionId,
          messages: [{ role: "user", content: "How is DNS rebinding blocked?" }],
        }),
    );

    expect(res.status).toBe(200);
    expect(res.text.match(/event: tool_call/g)).toHaveLength(3);
    expect(renderedDeltas(res.text)).toBe(ANSWER);
  });

  it("never streams tool markup the loop could not parse", async () => {
    const broken = '<tool_calls>{"tool": "search_code_graph", "args": {';
    const { provider } = scriptedProvider([broken]);
    setAIProviderForTests(provider);
    const app = makeApp();
    const sessionId = await projectSession(app);

    const res = await auth(
      request(app)
        .post("/api/ai/stream")
        .send({ sessionId, messages: [{ role: "user", content: "q" }] }),
    );

    expect(res.status).toBe(200);
    const rendered = renderedDeltas(res.text);
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered).not.toContain("tool_calls");
    expect(rendered).not.toContain('"tool"');
  });
});
