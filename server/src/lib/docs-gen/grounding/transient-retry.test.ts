/**
 * #246 — which grounding-call failures are retried, how often, and how long
 * the backoff waits.
 */
import { describe, expect, it, vi } from "vitest";
import {
  AIConfigError,
  AIError,
  AIOfflineError,
  AIProviderError,
  AIProviderRetiredError,
} from "../../ai/errors.js";
import {
  abortableSleep,
  classifyGroundingError,
  describeGroundingErrorClass,
  isTransientGroundingError,
  MAX_GROUNDING_RETRY_DELAY_MS,
  withTransientRetry,
} from "./transient-retry.js";

const status = (s: number, msg = "x") => new AIProviderError(msg, s);
const withCode = (code: string, msg = "boom") => Object.assign(new Error(msg), { code });

describe("classifyGroundingError", () => {
  it.each([
    [
      new AIProviderError("anthropic chat failed (TypeError): terminated", 502),
      "stream-terminated",
    ],
    [
      Object.assign(new TypeError("fetch failed"), { cause: withCode("ECONNRESET") }),
      "stream-terminated",
    ],
    [withCode("UND_ERR_SOCKET", "other side closed"), "stream-terminated"],
    [new Error("local-gemma chat request timed out after 600000ms"), "timeout"],
    [withCode("ETIMEDOUT"), "timeout"],
    [status(408), "timeout"],
    [status(429), "rate-limited"],
    [new Error("bedrock-gateway returned 429: slow down"), "rate-limited"],
    [status(500), "server-error"],
    [status(529, "overloaded_error"), "server-error"],
    [new Error("local-gemma returned 503: busy"), "server-error"],
    [status(400, "invalid model"), "client-error"],
    [status(401, "bad key"), "client-error"],
    [new Error("bedrock-gateway returned 404: no such model"), "client-error"],
    [Object.assign(new Error("aborted"), { name: "AbortError" }), "cancelled"],
    [Object.assign(new Error("no first token"), { name: "FirstTokenTimeoutError" }), "other"],
    [new Error("something odd"), "other"],
    ["a string", "other"],
    // PR #252 review — what the Anthropic adapter makes of each failure.
    [new AIProviderError("anthropic chat failed (Error): 502 Bad gateway", 502), "server-error"],
    [
      new AIProviderError("anthropic chat failed (Error): Connection error.", 502),
      "stream-terminated",
    ],
    [new AIProviderError("anthropic chat failed (Error): Request timed out.", 502), "timeout"],
    [
      new AIProviderError("anthropic chat failed (Error): 400 thinking.type: disabled", 400),
      "client-error",
    ],
    // A code bug with no status of its own: the stamped 502 is not a 5xx.
    [
      new AIProviderError(
        "anthropic chat failed (TypeError): Cannot read properties of undefined",
        502,
      ),
      "other",
    ],
    [new AIProviderError("anthropic chat failed (Error): Request was aborted.", 502), "cancelled"],
    [new AIProviderError("anthropic chat failed (AIConfigError): no API key", 500), "config-error"],
    // An explicit 4xx wins over the wording of its message.
    [status(400, "budget_tokens timeout must be positive"), "client-error"],
    [new Error("bedrock-gateway returned 422: request timed out field invalid"), "client-error"],
    [new AIConfigError("anthropic provider requires ANTHROPIC_API_KEY"), "config-error"],
    [new AIProviderRetiredError("copilot"), "config-error"],
    [new AIOfflineError(), "config-error"],
    [new AIError("AI_CANCELLED", "cancelled", 499), "cancelled"],
  ])("%s → %s", (err, expected) => {
    expect(classifyGroundingError(err)).toBe(expected);
  });

  it("a cancelled run is never retried, whatever the error says", () => {
    const ac = new AbortController();
    ac.abort();
    expect(classifyGroundingError(status(503), ac.signal)).toBe("cancelled");
  });

  it("only transport, timeout, 429 and 5xx classes are transient", () => {
    expect(
      (
        [
          "stream-terminated",
          "timeout",
          "rate-limited",
          "server-error",
          "client-error",
          "config-error",
          "cancelled",
          "other",
        ] as const
      ).filter(isTransientGroundingError),
    ).toEqual(["stream-terminated", "timeout", "rate-limited", "server-error"]);
  });

  it("describes every class without echoing the raw error", () => {
    expect(describeGroundingErrorClass("stream-terminated")).toContain("dropped mid-reply");
    expect(describeGroundingErrorClass("client-error")).toContain("4xx");
    expect(describeGroundingErrorClass("rate-limited")).toContain("429");
    expect(describeGroundingErrorClass("server-error")).toContain("5xx");
    expect(describeGroundingErrorClass("timeout")).toContain("timed out");
    expect(describeGroundingErrorClass("cancelled")).toContain("cancelled");
    expect(describeGroundingErrorClass("other")).toBe("the grounding call failed");
    expect(describeGroundingErrorClass("config-error")).toContain("not usable as configured");
    expect(describeGroundingErrorClass("config-error")).not.toContain("5xx");
  });
});

describe("withTransientRetry", () => {
  const ctx = { stage: "verdicts" as const };

  it("retries a dropped stream and returns the next answer", async () => {
    const call = vi
      .fn()
      .mockRejectedValueOnce(
        new AIProviderError("anthropic chat failed (TypeError): terminated", 502),
      )
      .mockResolvedValueOnce("ok");
    const sleep = vi.fn(async () => {});
    await expect(withTransientRetry(call, ctx, { sleep })).resolves.toBe("ok");
    expect(call).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 4xx configuration error", async () => {
    const err = status(400, "invalid model");
    const call = vi.fn().mockRejectedValue(err);
    const sleep = vi.fn(async () => {});
    await expect(withTransientRetry(call, ctx, { sleep })).rejects.toBe(err);
    expect(call).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing API key", new AIConfigError("anthropic provider requires ANTHROPIC_API_KEY")],
    [
      "a code bug the Anthropic adapter stamped 502",
      new AIProviderError("anthropic chat failed (TypeError): x is not a function", 502),
    ],
    ["a 400 whose message says timeout", status(400, "timeout must be an integer")],
  ])("does not retry %s (PR #252 review)", async (_label, err) => {
    const call = vi.fn().mockRejectedValue(err);
    const sleep = vi.fn(async () => {});
    await expect(withTransientRetry(call, ctx, { sleep })).rejects.toBe(err);
    expect(call).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("gives up after the configured number of tries, re-throwing the last error", async () => {
    const call = vi.fn().mockRejectedValue(status(503));
    const sleep = vi.fn(async () => {});
    await expect(withTransientRetry(call, ctx, { sleep, attempts: 3 })).rejects.toMatchObject({
      status: 503,
    });
    expect(call).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("backs off exponentially within [window/2, window], capped", async () => {
    const delays: number[] = [];
    const call = vi.fn().mockRejectedValue(status(429));
    await expect(
      withTransientRetry(call, ctx, {
        attempts: 6,
        baseDelayMs: 1000,
        random: () => 1,
        sleep: async (ms) => {
          delays.push(ms);
        },
      }),
    ).rejects.toBeDefined();
    expect(delays).toEqual([1000, 2000, 4000, 8000, MAX_GROUNDING_RETRY_DELAY_MS]);
    delays.length = 0;
    await expect(
      withTransientRetry(call, ctx, {
        attempts: 2,
        baseDelayMs: 1000,
        random: () => 0,
        sleep: async (ms) => {
          delays.push(ms);
        },
      }),
    ).rejects.toBeDefined();
    expect(delays).toEqual([500]);
  });

  it("clamps the number of tries to [1, 6]", async () => {
    const call = vi.fn().mockRejectedValue(status(500));
    const sleep = vi.fn(async () => {});
    await expect(withTransientRetry(call, ctx, { sleep, attempts: 0 })).rejects.toBeDefined();
    expect(call).toHaveBeenCalledTimes(1);
    call.mockClear();
    await expect(withTransientRetry(call, ctx, { sleep, attempts: 99 })).rejects.toBeDefined();
    expect(call).toHaveBeenCalledTimes(6);
  });

  it("stops waiting when the run is cancelled during the backoff", async () => {
    const ac = new AbortController();
    const call = vi.fn().mockRejectedValue(status(503));
    const pending = withTransientRetry(
      call,
      { ...ctx, signal: ac.signal },
      { baseDelayMs: 60_000 },
    );
    await Promise.resolve();
    await Promise.resolve();
    ac.abort(new Error("cancelled by user"));
    await expect(pending).rejects.toThrow("cancelled by user");
    expect(call).toHaveBeenCalledTimes(1);
  });
});

describe("abortableSleep", () => {
  it("resolves after the delay", async () => {
    await expect(abortableSleep(1)).resolves.toBeUndefined();
  });
  it("rejects at once when already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(abortableSleep(10_000, ac.signal)).rejects.toBeDefined();
  });
});
