/**
 * Epic #108 (#110) — generalized OpenAI-compatible provider.
 *
 * Verifies the provider works with `providerKey: "local-gemma"`, that the
 * `BedrockDirectProvider` alias still resolves to the same class, that the
 * `/models` ping path is used, and that SSE streaming yields deltas + usage.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OpenAICompatibleProvider,
  BedrockDirectProvider,
} from "../../../src/lib/ai/providers/openai-compatible-provider.js";

const BASE = "http://localhost:11434/v1";

function sseResponse(frames: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OpenAICompatibleProvider with local-gemma (#110)", () => {
  it("exposes the local-gemma key and configured model", () => {
    const p = new OpenAICompatibleProvider({
      baseUrl: BASE,
      apiKey: "ollama",
      model: "gemma3:4b",
      providerKey: "local-gemma",
    });
    expect(p.key).toBe("local-gemma");
    expect(p.model).toBe("gemma3:4b");
    expect(p.offline).toBe(false);
  });

  it("defaults the key to bedrock-gateway when none supplied (back-compat)", () => {
    const p = new OpenAICompatibleProvider({ baseUrl: BASE, apiKey: "k", model: "m" });
    expect(p.key).toBe("bedrock-gateway");
  });

  it("BedrockDirectProvider alias is the same class", () => {
    expect(BedrockDirectProvider).toBe(OpenAICompatibleProvider);
    const p = new BedrockDirectProvider({
      baseUrl: BASE,
      apiKey: "ollama",
      model: "gemma3:4b",
      providerKey: "local-gemma",
    });
    expect(p).toBeInstanceOf(OpenAICompatibleProvider);
  });

  it("chat() POSTs to /chat/completions and tags the local-gemma provider", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "hello world" } }],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          model: "gemma3:4b",
        }),
        { status: 200 },
      ),
    );
    const p = new OpenAICompatibleProvider({
      baseUrl: BASE,
      apiKey: "ollama",
      model: "gemma3:4b",
      providerKey: "local-gemma",
    });
    const res = await p.chat([{ role: "user", content: "hi" }]);
    expect(res.content).toBe("hello world");
    expect(res.provider).toBe("local-gemma");
    const calledUrl = fetchSpy.mock.calls[0]?.[0];
    expect(String(calledUrl)).toBe("http://localhost:11434/v1/chat/completions");
  });

  it("stream() parses SSE deltas + usage and ends on [DONE]", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: "Hel" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: "lo" } }] })}\n\n`,
        `data: ${JSON.stringify({
          choices: [{ delta: {} }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        })}\n\n`,
        "data: [DONE]\n\n",
      ]),
    );
    const p = new OpenAICompatibleProvider({
      baseUrl: BASE,
      apiKey: "ollama",
      model: "gemma3:4b",
      providerKey: "local-gemma",
    });
    const chunks: string[] = [];
    let usageTotal = 0;
    let done = false;
    for await (const c of p.stream([{ role: "user", content: "hi" }])) {
      if (c.type === "delta") chunks.push(c.content);
      if (c.type === "usage") usageTotal = c.usage.totalTokens;
      if (c.type === "done") done = true;
    }
    expect(chunks.join("")).toBe("Hello");
    expect(usageTotal).toBe(4);
    expect(done).toBe(true);
  });

  it("ping() targets {baseUrl}/models and honors the response status", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const p = new OpenAICompatibleProvider({
      baseUrl: BASE,
      apiKey: "ollama",
      model: "gemma3:4b",
      providerKey: "local-gemma",
    });
    const ok = await p.ping();
    expect(ok).toBe(true);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe("http://localhost:11434/v1/models");
  });

  it("ping() returns false on network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    const p = new OpenAICompatibleProvider({
      baseUrl: BASE,
      apiKey: "ollama",
      model: "gemma3:4b",
      providerKey: "local-gemma",
    });
    expect(await p.ping()).toBe(false);
  });

  it("models() lists ids from /models, falling back to the default", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "gemma3:4b" }, { id: "gemma3:12b" }] }), {
        status: 200,
      }),
    );
    const p = new OpenAICompatibleProvider({
      baseUrl: BASE,
      apiKey: "ollama",
      model: "gemma3:4b",
      providerKey: "local-gemma",
    });
    expect(await p.models()).toEqual(["gemma3:4b", "gemma3:12b"]);
  });

  it("embed() is unsupported and names the provider", async () => {
    const p = new OpenAICompatibleProvider({
      baseUrl: BASE,
      apiKey: "ollama",
      model: "gemma3:4b",
      providerKey: "local-gemma",
    });
    await expect(p.embed(["x"])).rejects.toThrow(
      /local-gemma provider does not support embeddings/,
    );
  });

  it("surfaces non-2xx errors with the provider key", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 503 }));
    const p = new OpenAICompatibleProvider({
      baseUrl: BASE,
      apiKey: "ollama",
      model: "gemma3:4b",
      providerKey: "local-gemma",
    });
    await expect(p.chat([{ role: "user", content: "hi" }])).rejects.toThrow(
      /local-gemma returned 503/,
    );
  });
});

describe("OpenAICompatibleProvider sampling parameters (#116)", () => {
  async function captureBody(
    opts: ConstructorParameters<typeof OpenAICompatibleProvider>[0],
    chatOpts?: Parameters<OpenAICompatibleProvider["chat"]>[1],
  ): Promise<Record<string, unknown>> {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200 },
      ),
    );
    const p = new OpenAICompatibleProvider(opts);
    await p.chat([{ role: "user", content: "hi" }], chatOpts);
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    return JSON.parse(String(init.body)) as Record<string, unknown>;
  }

  it("omits top_p / frequency_penalty / seed by default (Bedrock unchanged)", async () => {
    const body = await captureBody({ baseUrl: BASE, apiKey: "k", model: "claude" });
    expect(body.temperature).toBe(0.2);
    expect(body).not.toHaveProperty("top_p");
    expect(body).not.toHaveProperty("frequency_penalty");
    expect(body).not.toHaveProperty("presence_penalty");
    expect(body).not.toHaveProperty("seed");
  });

  it("emits configured Gemma sampling defaults", async () => {
    const body = await captureBody({
      baseUrl: BASE,
      apiKey: "ollama",
      model: "gemma4:12b",
      providerKey: "local-gemma",
      defaultTemperature: 1.0,
      defaultTopP: 0.95,
      disableThinking: true,
    });
    expect(body.temperature).toBe(1.0);
    expect(body.top_p).toBe(0.95);
    expect(body.think).toBe(false);
    expect(body).not.toHaveProperty("frequency_penalty");
  });

  it("per-call ChatOptions override provider defaults", async () => {
    const body = await captureBody(
      {
        baseUrl: BASE,
        apiKey: "ollama",
        model: "gemma4:12b",
        providerKey: "local-gemma",
        defaultTemperature: 0.1,
        defaultTopP: 0.95,
      },
      { temperature: 0.05, topP: 0.8, frequencyPenalty: 0.5 },
    );
    expect(body.temperature).toBe(0.05);
    expect(body.top_p).toBe(0.8);
    expect(body.frequency_penalty).toBe(0.5);
  });
});
