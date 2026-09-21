/**
 * Tests for structured-output (`response_format` / JSON-schema) support on the
 * OpenAICompatibleProvider (#336).
 *
 * WHERE THE CODE UNDER TEST LIVES (#1115): `openai-compatible-provider.ts` is a
 * re-export shim, so this suite imports the provider through that canonical
 * entry point but the implementation it exercises sits in
 * `bedrock-direct-provider.ts` — `OpenAICompatibleProvider` and
 * `BedrockDirectProvider` are two exported names for ONE class. Reading the
 * shim and concluding that the `response_format` support asserted below does
 * not exist is the mistake this note exists to prevent.
 *
 * Covers the four acceptance behaviours, HTTP layer fully mocked (no live
 * vLLM/Ollama):
 *   1. When a caller supplies `responseFormat`, the outgoing request body
 *      carries the exact OpenAI-compatible `response_format` payload (chat + stream).
 *   2. Graceful degradation: a runtime that rejects the field with 400/422 gets
 *      ONE automatic retry WITHOUT `response_format`, and the second request
 *      succeeds (free-form parse fallback), logging exactly one warn.
 *   3. Flag off (no `responseFormat` supplied) → the request body has NO
 *      `response_format` field (byte-for-byte unchanged).
 *   4. A non-capability 4xx (e.g. 401/404) is NOT retried — it surfaces as-is.
 *
 * `globalThis.fetch` is stubbed so no network call is made; the stub captures
 * each request body so we can assert the field is present/absent per attempt.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatChunk, JsonSchemaResponseFormat } from "../types.js";

// Capture structured log lines so we can assert exactly ONE warn on the
// graceful-fallback path and that NO secret is ever logged.
const { logWarn, logInfo } = vi.hoisted(() => ({ logWarn: vi.fn(), logInfo: vi.fn() }));
vi.mock("../../logger.js", () => ({
  createChildLogger: () => ({
    debug: vi.fn(),
    info: logInfo,
    warn: logWarn,
    error: vi.fn(),
  }),
}));
vi.mock("../logger.js", () => ({
  createChildLogger: () => ({
    debug: vi.fn(),
    info: logInfo,
    warn: logWarn,
    error: vi.fn(),
  }),
}));

const {
  OpenAICompatibleProvider,
  isStructuredOutputUnsupportedStatus,
  isTemperatureUnsupportedBody,
} = await import("./openai-compatible-provider.js");
const { __resetCacheHitAggregatorSingleton } = await import("../cache-hit-telemetry.js");

type CapturedInit = RequestInit & { dispatcher?: unknown };
const originalFetch = globalThis.fetch;

/** A representative caller-supplied schema payload. */
const SCHEMA: JsonSchemaResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "claim_decomposition",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["claims"],
      properties: { claims: { type: "array", items: { type: "string" } } },
    },
  },
};

function makeProvider() {
  return new OpenAICompatibleProvider({
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKey: "ollama",
    model: "test-model",
    providerKey: "local-gemma",
    // Fast, no real waiting if any retry path sleeps.
    retryBaseDelayMs: 1,
    sleepFn: async () => undefined,
  });
}

/** Minimal non-streaming OK JSON response. */
function jsonOk(content = '{"claims":[]}'): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      model: "test-model",
    }),
    text: async () => "",
  } as unknown as Response;
}

/** A non-OK client-error response (400/401/etc.) with a body excerpt. */
function errorResponse(status: number, body = `simulated ${status}`): Response {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    json: async () => ({}),
    text: async () => body,
  } as unknown as Response;
}

/** A streaming SSE response yielding one delta then [DONE]. */
function sseOk(): Response {
  const frames = ['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', "data: [DONE]\n\n"];
  let i = 0;
  const enc = new TextEncoder();
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: {
      getReader() {
        return {
          read: async () =>
            i < frames.length
              ? { value: enc.encode(frames[i++]), done: false }
              : { value: undefined, done: true },
          cancel: async () => undefined,
        };
      },
    },
    text: async () => "",
  } as unknown as Response;
}

/** Parse the JSON request body captured from a stubbed fetch call. */
function bodyOf(init: CapturedInit | undefined): Record<string, unknown> {
  return JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
}

async function drain(gen: AsyncGenerator<ChatChunk>): Promise<void> {
  for await (const _ of gen) {
    // consume
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  logWarn.mockClear();
  logInfo.mockClear();
  __resetCacheHitAggregatorSingleton();
  vi.restoreAllMocks();
});

describe("isStructuredOutputUnsupportedStatus", () => {
  it("classifies 400 and 422 as structured-output-unsupported", () => {
    expect(isStructuredOutputUnsupportedStatus(400)).toBe(true);
    expect(isStructuredOutputUnsupportedStatus(422)).toBe(true);
  });

  it("does NOT classify auth/not-found/transient statuses", () => {
    for (const s of [401, 403, 404, 429, 500, 503, 200]) {
      expect(isStructuredOutputUnsupportedStatus(s)).toBe(false);
    }
  });
});

describe("chat() structured-output request payload (#336)", () => {
  it("sends response_format verbatim when the caller supplies a schema", async () => {
    let captured: CapturedInit | undefined;
    globalThis.fetch = vi.fn(async (_url: unknown, init?: CapturedInit) => {
      captured = init;
      return jsonOk();
    }) as unknown as typeof fetch;

    await makeProvider().chat([{ role: "user", content: "hi" }], { responseFormat: SCHEMA });

    expect(bodyOf(captured).response_format).toEqual(SCHEMA);
  });

  it("omits response_format entirely when no schema is supplied (unchanged request)", async () => {
    let captured: CapturedInit | undefined;
    globalThis.fetch = vi.fn(async (_url: unknown, init?: CapturedInit) => {
      captured = init;
      return jsonOk();
    }) as unknown as typeof fetch;

    await makeProvider().chat([{ role: "user", content: "hi" }]);

    expect(bodyOf(captured)).not.toHaveProperty("response_format");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("chat() graceful degradation when runtime rejects response_format", () => {
  it.each([400, 422])(
    "retries ONCE without response_format after a %d rejection and succeeds",
    async (status) => {
      const bodies: Array<Record<string, unknown>> = [];
      let call = 0;
      globalThis.fetch = vi.fn(async (_url: unknown, init?: CapturedInit) => {
        bodies.push(bodyOf(init));
        call++;
        return call === 1 ? errorResponse(status) : jsonOk();
      }) as unknown as typeof fetch;

      const res = await makeProvider().chat([{ role: "user", content: "hi" }], {
        responseFormat: SCHEMA,
      });

      // Two attempts: first WITH the field, second WITHOUT it.
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
      expect(bodies[0]).toHaveProperty("response_format");
      expect(bodies[1]).not.toHaveProperty("response_format");
      // Fallback succeeded — the free-form response is returned to the caller.
      expect(res.content).toBe('{"claims":[]}');
      // Exactly one diagnostic warn, and it never leaks the API key.
      expect(logWarn).toHaveBeenCalledTimes(1);
      const logged = JSON.stringify(logWarn.mock.calls);
      expect(logged).not.toContain("ollama"); // apiKey value
      expect(logged).not.toContain("Bearer");
    },
  );

  it("does NOT retry a 400 when no response_format was sent — surfaces the error", async () => {
    globalThis.fetch = vi.fn(async () => errorResponse(400)) as unknown as typeof fetch;

    await expect(makeProvider().chat([{ role: "user", content: "hi" }])).rejects.toThrow(
      /returned 400/,
    );
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a non-capability 4xx (404) even with a schema — surfaces as-is", async () => {
    globalThis.fetch = vi.fn(async () => errorResponse(404)) as unknown as typeof fetch;

    await expect(
      makeProvider().chat([{ role: "user", content: "hi" }], { responseFormat: SCHEMA }),
    ).rejects.toThrow(/returned 404/);
    // No fallback retry for a non-capability status.
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(logWarn).not.toHaveBeenCalled();
  });
});

describe("stream() structured-output request payload + degradation (#336)", () => {
  it("sends response_format on the streaming request when a schema is supplied", async () => {
    let captured: CapturedInit | undefined;
    globalThis.fetch = vi.fn(async (_url: unknown, init?: CapturedInit) => {
      captured = init;
      return sseOk();
    }) as unknown as typeof fetch;

    await drain(
      makeProvider().stream([{ role: "user", content: "hi" }], { responseFormat: SCHEMA }),
    );

    const body = bodyOf(captured);
    expect(body.response_format).toEqual(SCHEMA);
    expect(body.stream).toBe(true);
  });

  it("reconnects ONCE without response_format after a 400 rejection pre-first-byte", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let call = 0;
    globalThis.fetch = vi.fn(async (_url: unknown, init?: CapturedInit) => {
      bodies.push(bodyOf(init));
      call++;
      return call === 1 ? errorResponse(400) : sseOk();
    }) as unknown as typeof fetch;

    const chunks: string[] = [];
    for await (const chunk of makeProvider().stream([{ role: "user", content: "hi" }], {
      responseFormat: SCHEMA,
    })) {
      if (chunk.type === "delta") chunks.push(chunk.content);
    }

    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(bodies[0]).toHaveProperty("response_format");
    expect(bodies[1]).not.toHaveProperty("response_format");
    expect(chunks.join("")).toBe("hi");
    expect(logWarn).toHaveBeenCalledTimes(1);
  });

  it("omits response_format on the streaming request when no schema is supplied", async () => {
    let captured: CapturedInit | undefined;
    globalThis.fetch = vi.fn(async (_url: unknown, init?: CapturedInit) => {
      captured = init;
      return sseOk();
    }) as unknown as typeof fetch;

    await drain(makeProvider().stream([{ role: "user", content: "hi" }]));

    expect(bodyOf(captured)).not.toHaveProperty("response_format");
  });
});

describe("isTemperatureUnsupportedBody", () => {
  it("classifies a 400 body mentioning temperature + deprecated as unsupported", () => {
    expect(
      isTemperatureUnsupportedBody(
        400,
        '{"detail":"An error occurred (ValidationException) when calling the Converse operation: The model returned the following errors: `temperature` is deprecated for this model."}',
      ),
    ).toBe(true);
  });

  it("does NOT classify an unrelated 400 or a 400 without both keywords", () => {
    expect(isTemperatureUnsupportedBody(400, "some other validation error")).toBe(false);
    expect(isTemperatureUnsupportedBody(400, "temperature must be between 0 and 1")).toBe(false);
    expect(isTemperatureUnsupportedBody(404, "temperature is deprecated")).toBe(false);
  });
});

describe("chat() graceful degradation when runtime rejects temperature", () => {
  it("retries ONCE without temperature after a deprecation rejection and succeeds", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let call = 0;
    globalThis.fetch = vi.fn(async (_url: unknown, init?: CapturedInit) => {
      bodies.push(bodyOf(init));
      call++;
      return call === 1
        ? errorResponse(
            400,
            '{"detail":"ValidationException: `temperature` is deprecated for this model."}',
          )
        : jsonOk();
    }) as unknown as typeof fetch;

    const res = await makeProvider().chat([{ role: "user", content: "hi" }]);

    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(bodies[0]).toHaveProperty("temperature");
    expect(bodies[1]).not.toHaveProperty("temperature");
    expect(res.content).toBe('{"claims":[]}');
    expect(logWarn).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a 400 that isn't about temperature — surfaces the error", async () => {
    globalThis.fetch = vi.fn(async () =>
      errorResponse(400, "some unrelated validation error"),
    ) as unknown as typeof fetch;

    await expect(makeProvider().chat([{ role: "user", content: "hi" }])).rejects.toThrow(
      /returned 400/,
    );
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("stream() graceful degradation when runtime rejects temperature", () => {
  it("reconnects ONCE without temperature after a deprecation rejection pre-first-byte", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let call = 0;
    globalThis.fetch = vi.fn(async (_url: unknown, init?: CapturedInit) => {
      bodies.push(bodyOf(init));
      call++;
      return call === 1
        ? errorResponse(400, '{"detail":"`temperature` is deprecated for this model."}')
        : sseOk();
    }) as unknown as typeof fetch;

    const chunks: string[] = [];
    for await (const chunk of makeProvider().stream([{ role: "user", content: "hi" }])) {
      if (chunk.type === "delta") chunks.push(chunk.content);
    }

    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(bodies[0]).toHaveProperty("temperature");
    expect(bodies[1]).not.toHaveProperty("temperature");
    expect(chunks.join("")).toBe("hi");
    expect(logWarn).toHaveBeenCalledTimes(1);
  });
});

/**
 * #1229 — the degradation above used to be re-learned per call, so every single
 * request to a model that rejects `temperature` paid a wasted 400 round-trip.
 */
describe("temperature rejection is remembered per model (#1229)", () => {
  /** Rejects `temperature` whenever the body carries it; otherwise succeeds. */
  function rejectWhenTemperaturePresent(
    bodies: Array<Record<string, unknown>>,
    ok: () => Response,
  ) {
    return vi.fn(async (_url: unknown, init?: CapturedInit) => {
      const body = bodyOf(init);
      bodies.push(body);
      return "temperature" in body
        ? errorResponse(400, '{"detail":"`temperature` is deprecated for this model."}')
        : ok();
    }) as unknown as typeof fetch;
  }

  it("does not re-probe on later chat() calls to the same model", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = rejectWhenTemperaturePresent(bodies, jsonOk);
    const provider = makeProvider();

    await provider.chat([{ role: "user", content: "one" }]);
    await provider.chat([{ role: "user", content: "two" }]);
    await provider.chat([{ role: "user", content: "three" }]);

    // 2 for the first call (probe + retry), then 1 each — not 2 each.
    expect(globalThis.fetch).toHaveBeenCalledTimes(4);
    expect(bodies[0]).toHaveProperty("temperature");
    expect(bodies.slice(1).every((b) => !("temperature" in b))).toBe(true);
    // The warn is diagnostic, so it must not repeat once the answer is known.
    expect(logWarn).toHaveBeenCalledTimes(1);
  });

  it("carries what chat() learned over to stream() on the same provider", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = vi.fn(async (_url: unknown, init?: CapturedInit) => {
      const body = bodyOf(init);
      bodies.push(body);
      if ("temperature" in body) {
        return errorResponse(400, '{"detail":"`temperature` is deprecated for this model."}');
      }
      return body.stream === true ? sseOk() : jsonOk();
    }) as unknown as typeof fetch;
    const provider = makeProvider();

    await provider.chat([{ role: "user", content: "hi" }]);
    for await (const _chunk of provider.stream([{ role: "user", content: "hi" }])) {
      // drain
    }

    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    expect(bodies[2]).not.toHaveProperty("temperature");
  });

  it("still probes a DIFFERENT model — the answer is per model, not per provider", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = rejectWhenTemperaturePresent(bodies, jsonOk);
    const provider = makeProvider();

    await provider.chat([{ role: "user", content: "hi" }]);
    await provider.chat([{ role: "user", content: "hi" }], { model: "some-other-model" });

    expect(globalThis.fetch).toHaveBeenCalledTimes(4);
    expect(bodies[2]).toHaveProperty("temperature");
  });

  it("does not leak the memo across provider instances", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = rejectWhenTemperaturePresent(bodies, jsonOk);

    await makeProvider().chat([{ role: "user", content: "hi" }]);
    await makeProvider().chat([{ role: "user", content: "hi" }]);

    expect(globalThis.fetch).toHaveBeenCalledTimes(4);
    expect(bodies[2]).toHaveProperty("temperature");
  });
});
