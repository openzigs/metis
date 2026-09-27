/**
 * #254 — Spec Kit's per-project provider override must route to the OVERRIDE
 * provider's own endpoint with its own credential.
 *
 * `resolveProjectProvider` used to copy the global `AIConfig` and swap only
 * `provider` / `model`, so the global provider's `sdkProvider` (base URL + API
 * key) went along: a project overridden to `anthropic` on an `openai`
 * deployment sent Anthropic requests to the OpenAI endpoint with the OpenAI key.
 *
 * Real config loader, real provider factory and real provider classes; only
 * Prisma is mocked. Two loopback servers stand in for the two providers, and
 * each test asserts which one received the request and with which credential.
 * The last block drives the real Spec Kit route, so the resolver the route
 * calls is the one on the wire (the command body is stubbed to one model call).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const projectFindFirst = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/prisma.js", () => ({
  prisma: { project: { findFirst: (...args: unknown[]) => projectFindFirst(...args) } },
}));

// Spec Kit route collaborators that need a DB or auth: stubbed. The provider
// path (route → resolveProjectProvider → loader → factory → HTTP) stays real.
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { userId: "u1", username: "tester", role: "admin", permissions: ["*"] };
    next();
  },
}));
vi.mock("../src/middleware/require-permission.js", () => ({
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../src/lib/spec-kit/artifacts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/spec-kit/artifacts.js")>()),
  isSpecKitEnabled: async () => true,
}));
vi.mock("../src/lib/spec-kit/commands/specify.js", () => ({
  runSpecify: async (input: {
    prompt: string;
    deps: { provider: import("../src/lib/ai/types.js").AIProvider };
  }) => {
    const out = await input.deps.provider.chat([{ role: "user", content: input.prompt }], {
      callType: "spec-kit",
    });
    return { artifact: null, tokensUsed: 1, message: out.content };
  },
}));

import express from "express";
import request from "supertest";
import { specKitRouter } from "../src/routes/spec-kit.js";
import { errorHandler } from "../src/middleware/error-handler.js";
import { resolveProjectProvider } from "../src/lib/ai/project-provider.js";
import { AIProviderError } from "../src/lib/ai/errors.js";
import { resetLocalConcurrencyLimitersForTests } from "../src/lib/ai/providers/local-concurrency-limiter.js";
import { __resetConfigSingleton, getConfigService } from "../src/lib/config/index.js";

type Body = Record<string, unknown>;
interface Seen {
  path: string;
  body: Body;
  headers: IncomingMessage["headers"];
}

function readBody(req: IncomingMessage): Promise<Body> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
    req.on("end", () => resolve(raw ? (JSON.parse(raw) as Body) : {}));
  });
}

function openAiReply(res: ServerResponse): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      id: "c1",
      object: "chat.completion",
      model: "gpt-4.1",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "openai says hi" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    }),
  );
}

function anthropicReply(res: ServerResponse): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "anthropic says hi" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 11, output_tokens: 3 },
    }),
  );
}

const ENV_KEYS = [
  "AI_OFFLINE",
  "AI_PROVIDER",
  "AI_MODEL",
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_API_KEY",
  "AI_MAX_RETRIES",
] as const;
const savedEnv: Record<string, string | undefined> = {};
/** The deployment-wide model (`AI_MODEL`), a model of the global `openai`. */
const GLOBAL_MODEL = "gpt-deployment-pinned";

let openaiServer: Server;
let anthropicServer: Server;
let openaiBase = "";
let anthropicBase = "";
const openaiSeen: Seen[] = [];
const anthropicSeen: Seen[] = [];

beforeAll(async () => {
  openaiServer = createServer((req, res) => {
    void readBody(req).then((body) => {
      openaiSeen.push({ path: req.url ?? "", body, headers: req.headers });
      openAiReply(res);
    });
  });
  anthropicServer = createServer((req, res) => {
    void readBody(req).then((body) => {
      anthropicSeen.push({ path: req.url ?? "", body, headers: req.headers });
      anthropicReply(res);
    });
  });
  await new Promise<void>((r) => openaiServer.listen(0, "127.0.0.1", () => r()));
  await new Promise<void>((r) => anthropicServer.listen(0, "127.0.0.1", () => r()));
  openaiBase = `http://127.0.0.1:${(openaiServer.address() as AddressInfo).port}`;
  anthropicBase = `http://127.0.0.1:${(anthropicServer.address() as AddressInfo).port}`;
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});

afterAll(async () => {
  openaiServer.closeAllConnections();
  anthropicServer.closeAllConnections();
  await new Promise<void>((r) => openaiServer.close(() => r()));
  await new Promise<void>((r) => anthropicServer.close(() => r()));
});

beforeEach(() => {
  // The deployment's GLOBAL provider is `openai` (loopback A). Anthropic is
  // configured too (loopback B), with its own credential.
  delete process.env.AI_OFFLINE;
  process.env.AI_PROVIDER = "openai";
  // The deployment pins a model for ITS provider — the value that leaked into a
  // provider-only override before (review of #284). Never delete it here, or
  // the only "global model" a test can rule out is the built-in OpenAI default.
  process.env.AI_MODEL = GLOBAL_MODEL;
  process.env.OPENAI_BASE_URL = `${openaiBase}/v1`;
  process.env.OPENAI_API_KEY = "k-openai-global";
  process.env.ANTHROPIC_API_KEY = "k-anthropic-project";
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  process.env.ANTHROPIC_BASE_URL = anthropicBase;
  delete process.env.ANTHROPIC_MODEL;
  delete process.env.AZURE_OPENAI_ENDPOINT;
  delete process.env.AZURE_OPENAI_API_KEY;
  process.env.AI_MAX_RETRIES = "1";
  openaiSeen.length = 0;
  anthropicSeen.length = 0;
  projectFindFirst.mockReset();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetLocalConcurrencyLimitersForTests();
  __resetConfigSingleton();
});

async function ask(projectId: string): Promise<string> {
  const provider = await resolveProjectProvider(projectId);
  const out = await provider.chat([{ role: "user", content: "specify a feature" }], {
    callType: "spec-kit",
  });
  return out.content;
}

describe("resolveProjectProvider — override routing (#254)", () => {
  it("a project overridden to anthropic reaches ANTHROPIC's endpoint with ANTHROPIC's credential", async () => {
    projectFindFirst.mockResolvedValue({
      aiProviderId: "anthropic",
      aiModel: "claude-pinned-model",
    });

    expect(await ask("p-anth")).toBe("anthropic says hi");

    expect(openaiSeen).toHaveLength(0);
    expect(anthropicSeen).toHaveLength(1);
    const [s] = anthropicSeen;
    expect(s!.path).toBe("/v1/messages");
    expect(s!.body.model).toBe("claude-pinned-model");
    expect(s!.headers["x-api-key"]).toBe("k-anthropic-project");
  });

  it("the override's model defaults to the override provider's own default, not the global model", async () => {
    // The deployment pins AI_MODEL for openai; the project names only a provider.
    projectFindFirst.mockResolvedValue({ aiProviderId: "anthropic", aiModel: null });
    process.env.ANTHROPIC_MODEL = "claude-project-default";

    await ask("p-anth");

    expect(anthropicSeen).toHaveLength(1);
    expect(anthropicSeen[0]!.body.model).toBe("claude-project-default");
  });

  it("with no ANTHROPIC_MODEL, a provider-only override gets anthropic's built-in default, never the deployment's AI_MODEL", async () => {
    projectFindFirst.mockResolvedValue({ aiProviderId: "anthropic", aiModel: null });

    await ask("p-anth");

    expect(anthropicSeen).toHaveLength(1);
    expect(anthropicSeen[0]!.body.model).toBe("claude-sonnet-4-6");
    expect(JSON.stringify(anthropicSeen[0]!.body)).not.toContain(GLOBAL_MODEL);
  });

  it("an Admin runtime AI_DEFAULT_MODEL does not leak into a provider-only override either", async () => {
    delete process.env.AI_MODEL;
    const svc = getConfigService();
    // @ts-expect-error — test seam: an admin-set runtime_config value.
    svc["tunableCache"].set("AI_DEFAULT_MODEL", "gpt-admin-runtime");
    // @ts-expect-error — see above.
    svc["tunableDbBacked"].add("AI_DEFAULT_MODEL");
    projectFindFirst.mockResolvedValue({ aiProviderId: "anthropic", aiModel: null });

    await ask("p-anth");
    projectFindFirst.mockResolvedValue({ aiProviderId: null, aiModel: null });
    await ask("p-plain");

    expect(anthropicSeen[0]!.body.model).toBe("claude-sonnet-4-6");
    // The runtime value is live — it still reaches the deployment's own provider.
    expect(openaiSeen[0]!.body.model).toBe("gpt-admin-runtime");
  });

  it("an override naming the deployment's own provider keeps the deployment's AI_MODEL", async () => {
    projectFindFirst.mockResolvedValue({ aiProviderId: "openai", aiModel: null });

    await ask("p-same");

    expect(openaiSeen).toHaveLength(1);
    expect(openaiSeen[0]!.body.model).toBe(GLOBAL_MODEL);
  });

  it("a non-empty project aiModel still wins over every default", async () => {
    projectFindFirst.mockResolvedValue({ aiProviderId: "openai", aiModel: "gpt-project-pin" });

    await ask("p-same");

    expect(openaiSeen[0]!.body.model).toBe("gpt-project-pin");
  });

  it("a project with no override still runs on the global provider", async () => {
    projectFindFirst.mockResolvedValue({ aiProviderId: null, aiModel: null });

    expect(await ask("p-plain")).toBe("openai says hi");

    expect(anthropicSeen).toHaveLength(0);
    expect(openaiSeen).toHaveLength(1);
    expect(openaiSeen[0]!.path).toBe("/v1/chat/completions");
    expect(openaiSeen[0]!.headers.authorization).toBe("Bearer k-openai-global");
    expect(openaiSeen[0]!.body.model).toBe(GLOBAL_MODEL);
  });

  it("the reverse override (global anthropic, project openai) routes to openai with its own key", async () => {
    // Global = anthropic; project overrides to openai.
    process.env.AI_PROVIDER = "anthropic";
    projectFindFirst.mockResolvedValue({ aiProviderId: "openai", aiModel: "gpt-4.1" });

    expect(await ask("p-oai")).toBe("openai says hi");

    expect(anthropicSeen).toHaveLength(0);
    expect(openaiSeen).toHaveLength(1);
    expect(openaiSeen[0]!.headers.authorization).toBe("Bearer k-openai-global");
    expect(openaiSeen[0]!.body.model).toBe("gpt-4.1");
  });
});

describe("resolveProjectProvider — credential isolation (#254, security)", () => {
  it("one project's override never carries another provider's credential on the wire", async () => {
    projectFindFirst.mockImplementation(async (args: { where: { id: string } }) =>
      args.where.id === "p-anth"
        ? { aiProviderId: "anthropic", aiModel: "claude-sonnet-4-6" }
        : { aiProviderId: "openai", aiModel: "gpt-4.1" },
    );

    await ask("p-anth");
    await ask("p-oai");
    await ask("p-anth");

    expect(anthropicSeen).toHaveLength(2);
    expect(openaiSeen).toHaveLength(1);
    for (const s of anthropicSeen) {
      const wire = JSON.stringify(s.headers) + JSON.stringify(s.body);
      expect(wire).not.toContain("k-openai-global");
      expect(s.headers.authorization).toBeUndefined();
    }
    for (const s of openaiSeen) {
      const wire = JSON.stringify(s.headers) + JSON.stringify(s.body);
      expect(wire).not.toContain("k-anthropic-project");
      expect(s.headers["x-api-key"]).toBeUndefined();
    }
  });

  it("an override whose provider is not configured fails with the typed 502 and never falls back to the global provider", async () => {
    projectFindFirst.mockResolvedValue({ aiProviderId: "azure", aiModel: null });

    const err = await resolveProjectProvider("p-azure").then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(AIProviderError);
    expect(err).toMatchObject({ status: 502 });
    expect((err as Error).message).toContain('"azure"');
    // The loader's reason names env variables / endpoints: server log only.
    expect((err as Error).message).not.toContain("AZURE_OPENAI_ENDPOINT");
    expect((err as Error).message).not.toContain("k-openai-global");
    expect(openaiSeen).toHaveLength(0);
    expect(anthropicSeen).toHaveLength(0);
  });

  it("an override to a provider whose credential is missing is refused, not sent with the global credential", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    projectFindFirst.mockResolvedValue({ aiProviderId: "anthropic", aiModel: null });

    await expect(resolveProjectProvider("p-anth")).rejects.toMatchObject({ status: 502 });
    expect(openaiSeen).toHaveLength(0);
    expect(anthropicSeen).toHaveLength(0);
  });

  it("a retired override is still refused with 409 AI_PROVIDER_RETIRED by the real loader, reaching no provider (#149)", async () => {
    projectFindFirst.mockResolvedValue({ aiProviderId: "copilot-native", aiModel: null });

    const err = await resolveProjectProvider("p-retired").then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toMatchObject({ status: 409, code: "AI_PROVIDER_RETIRED" });
    expect(err).not.toBeInstanceOf(AIProviderError);
    expect((err as Error).message).toContain(
      `This project's AI provider override is "copilot-native"`,
    );
    expect(openaiSeen).toHaveLength(0);
    expect(anthropicSeen).toHaveLength(0);
  });
});

describe("Spec Kit route — the command reaches the project's provider (#254)", () => {
  function app(): express.Express {
    const a = express();
    a.use(express.json());
    a.use("/api/projects/:projectId/spec-kit", specKitRouter());
    a.use(errorHandler);
    return a;
  }

  it("POST /commands/specify on a project overridden to anthropic calls anthropic with its own key", async () => {
    projectFindFirst.mockResolvedValue({ aiProviderId: "anthropic", aiModel: null });

    const res = await request(app())
      .post("/api/projects/p-anth/spec-kit/commands/specify")
      .send({ input: "a feature" });

    expect(res.status).toBe(200);
    expect(res.body.data.message).toBe("anthropic says hi");
    expect(openaiSeen).toHaveLength(0);
    expect(anthropicSeen).toHaveLength(1);
    expect(anthropicSeen[0]!.headers["x-api-key"]).toBe("k-anthropic-project");
    expect(anthropicSeen[0]!.body.model).toBe("claude-sonnet-4-6");
    expect(JSON.stringify(anthropicSeen[0]!.headers)).not.toContain("k-openai-global");
  });

  it("an override the server cannot build answers 502 AI_PROVIDER_KEY_UNAVAILABLE and calls nobody", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    projectFindFirst.mockResolvedValue({ aiProviderId: "anthropic", aiModel: null });

    const res = await request(app())
      .post("/api/projects/p-anth/spec-kit/commands/specify")
      .send({ input: "a feature" });

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("AI_PROVIDER_KEY_UNAVAILABLE");
    expect(openaiSeen).toHaveLength(0);
    expect(anthropicSeen).toHaveLength(0);
  });

  it("a retired override answers 409 AI_PROVIDER_RETIRED (#149)", async () => {
    projectFindFirst.mockResolvedValue({ aiProviderId: "copilot-native", aiModel: null });

    const res = await request(app())
      .post("/api/projects/p-retired/spec-kit/commands/specify")
      .send({ input: "a feature" });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("AI_PROVIDER_RETIRED");
    expect(openaiSeen).toHaveLength(0);
    expect(anthropicSeen).toHaveLength(0);
  });
});
