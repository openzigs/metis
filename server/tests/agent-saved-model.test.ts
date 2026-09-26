/**
 * Epic #129 (#145), adversarial panel on PR #239 — an agent's SAVED model is
 * never dropped because a discovery cache happens to be cold, and never swapped
 * silently.
 *
 * The model on the wire is a provider option, so it is asserted against the
 * REAL provider classes talking to a loopback HTTP server (the P2 lesson): the
 * local runtime (`OpenAICompatibleProvider`, `local-gemma`) and Anthropic
 * (`AnthropicProvider`). The model catalog's discovery cache is reset before
 * every test — the state of a process that has never served `GET /api/ai/models`
 * (every restart). Copilot has no loopback-able wire (its SDK owns the
 * transport), so its case asserts the model handed to `provider.chat`.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomAgentDto } from "@metis/shared";
import type { AIProvider, ChatResponse } from "../src/lib/ai/types.js";
import { invokeCustomAgent } from "../src/lib/custom-agents/invoke.js";
import { resolveAgentModel } from "../src/lib/agent-runtime/definition.js";
import { __resetModelCatalogForTests } from "../src/lib/ai/model-catalog.js";
import { AnthropicProvider } from "../src/lib/ai/providers/anthropic-provider.js";
import { OpenAICompatibleProvider } from "../src/lib/ai/providers/bedrock-direct-provider.js";
import { resetLocalConcurrencyLimitersForTests } from "../src/lib/ai/providers/local-concurrency-limiter.js";

type Body = Record<string, unknown>;

const agent = (model: string | null): CustomAgentDto => ({
  id: "ag_model",
  projectId: "p1",
  name: "Modelled",
  description: "",
  systemPrompt: "You are modelled.",
  tools: [],
  model,
  reasoningEffort: null,
  isBuiltIn: false,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

describe("an agent's saved model (#145) — real providers, cold catalog", () => {
  let server: Server;
  let base = "";
  const bodies: Body[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
      req.on("end", () => {
        const body = (raw ? JSON.parse(raw) : {}) as Body;
        bodies.push(body);
        res.writeHead(200, { "content-type": "application/json" });
        if ((req.url ?? "").includes("/messages")) {
          res.end(
            JSON.stringify({
              id: "msg_1",
              type: "message",
              role: "assistant",
              model: body.model,
              content: [{ type: "text", text: "ok" }],
              stop_reason: "end_turn",
              stop_sequence: null,
              usage: { input_tokens: 3, output_tokens: 1 },
            }),
          );
          return;
        }
        res.end(
          JSON.stringify({
            id: "c1",
            object: "chat.completion",
            model: body.model,
            choices: [
              { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
          }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  beforeEach(() => {
    bodies.length = 0;
    __resetModelCatalogForTests(); // a process that never served GET /api/ai/models
    resetLocalConcurrencyLimitersForTests();
    delete process.env.AI_MODEL_CATALOG_OVERRIDES;
  });

  const local = () =>
    new OpenAICompatibleProvider({
      baseUrl: `${base}/v1`,
      apiKey: "ollama",
      model: "gemma4:e4b",
      providerKey: "local-gemma",
      maxAttempts: 1,
    });
  const anthropic = () =>
    new AnthropicProvider({ apiKey: "k", baseUrl: base, model: "claude-sonnet-4-6" });

  it("local-gemma, cold cache: the agent's saved model is what goes on the wire, with no warning", async () => {
    const res = await invokeCustomAgent({
      provider: local(),
      agent: agent("qwen3:8b"),
      input: "hi",
    });
    const chat = bodies.filter((b) => Array.isArray(b.messages));
    expect(chat).toHaveLength(1);
    expect(chat[0]!.model).toBe("qwen3:8b");
    expect(res.warnings).toBeUndefined();
  });

  it("an agent with no saved model runs the provider's default, with no warning", async () => {
    const res = await invokeCustomAgent({ provider: local(), agent: agent(null), input: "hi" });
    expect(bodies[0]!.model).toBe("gemma4:e4b");
    expect(res.warnings).toBeUndefined();
  });

  it("Anthropic: a catalog-known saved model is sent", async () => {
    await invokeCustomAgent({
      provider: anthropic(),
      agent: agent("claude-haiku-4-5-20251001"),
      input: "hi",
    });
    expect(bodies[0]!.model).toBe("claude-haiku-4-5-20251001");
  });

  it("Anthropic: a saved model the catalog cannot vouch for is NOT swapped silently — the result carries the warning", async () => {
    const res = await invokeCustomAgent({
      provider: anthropic(),
      agent: agent("made-up-model"),
      input: "hi",
    });
    expect(bodies[0]!.model).toBe("claude-sonnet-4-6");
    expect(res.warnings).toEqual([expect.stringContaining('"made-up-model"')]);
    expect(res.warnings![0]).toContain("the provider's default model");
  });

  it("copilot-native: the saved model reaches provider.chat (Copilot owns its model list until P4)", async () => {
    const chat = vi.fn(
      async (): Promise<ChatResponse> => ({
        content: "ok",
        model: "gpt-5",
        provider: "copilot-native",
      }),
    );
    const copilot = { key: "copilot-native", model: "gpt-4.1", chat } as unknown as AIProvider;
    const res = await invokeCustomAgent({ provider: copilot, agent: agent("gpt-5"), input: "hi" });
    expect((chat.mock.calls[0] as unknown[])[1]).toMatchObject({ model: "gpt-5" });
    expect(res.warnings).toBeUndefined();
  });
});

describe("resolveAgentModel — the decision itself (cold catalog)", () => {
  beforeEach(() => __resetModelCatalogForTests());

  it("open-vocabulary providers keep a well-formed saved model without any catalog entry", () => {
    for (const p of ["local-gemma", "copilot-native", "azure"]) {
      expect(resolveAgentModel(p, "my-deployment:1b", "fallback", {})).toEqual({
        model: "my-deployment:1b",
        usedPreferred: true,
      });
    }
  });

  it("a malformed name is refused on every provider — with a warning", () => {
    const r = resolveAgentModel("local-gemma", "bad model; rm -rf /", "fallback", {});
    expect(r.model).toBe("fallback");
    expect(r.warning).toMatch(/is not a valid model name; it ran on "fallback" instead/);
  });

  it("a closed-catalog provider refuses an unknown or other-provider model — with a warning naming the override", () => {
    const r = resolveAgentModel("openai", "claude-sonnet-4-6", "gpt-4.1", {});
    expect(r).toMatchObject({ model: "gpt-4.1", usedPreferred: false });
    expect(r.warning).toContain("AI_MODEL_CATALOG_OVERRIDES");
    // …and an operator override vouches for it.
    const env = { AI_MODEL_CATALOG_OVERRIDES: JSON.stringify({ "openai:ft-mine": {} }) };
    __resetModelCatalogForTests();
    expect(resolveAgentModel("openai", "ft-mine", "gpt-4.1", env).model).toBe("ft-mine");
  });
});
