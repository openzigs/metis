/**
 * #52 — a failed generation's `errorMessage` is always one of a fixed set of
 * user-safe strings, never the raw exception text.
 */
import { describe, expect, it } from "vitest";
import {
  GENERATION_BUDGET_EXCEEDED_MESSAGE,
  GENERATION_FAILED_MESSAGE,
  GENERATION_PROVIDER_AUTH_MESSAGE,
  GENERATION_PROVIDER_BALANCE_MESSAGE,
  GENERATION_PROVIDER_RATE_LIMITED_MESSAGE,
  generationFailureMessage,
  publicGenerationErrorMessage,
} from "./generation-failure-message.js";
import { GENERATION_INTERRUPTED_MESSAGE } from "./interrupted-generations.js";
import { AIProviderError } from "../ai/errors.js";
import { BudgetExceededError } from "../finops/budget-enforcer.js";

const SECRET =
  'deepseek returned 500: {"error":"boom"} at /srv/metis/server/src/lib/x.ts:12 SELECT * FROM "User"';

describe("generationFailureMessage", () => {
  it("never echoes an unrecognised error", () => {
    const msg = generationFailureMessage(new Error(SECRET));
    expect(msg).toBe(GENERATION_FAILED_MESSAGE);
    expect(msg).not.toContain("/srv");
    expect(msg).not.toContain("SELECT");
  });

  it("handles non-Error throws", () => {
    expect(generationFailureMessage(undefined)).toBe(GENERATION_FAILED_MESSAGE);
    expect(generationFailureMessage({ weird: true })).toBe(GENERATION_FAILED_MESSAGE);
  });

  it("keeps a provider's 402 Insufficient Balance recognisable", () => {
    // The OpenAI-compatible provider's own shape (bedrock-direct-provider.ts).
    const raw = new Error(
      'deepseek returned 402: {"error":{"message":"Insufficient Balance","type":"unknown_error"}}',
    );
    const msg = generationFailureMessage(raw);
    expect(msg).toBe(GENERATION_PROVIDER_BALANCE_MESSAGE);
    expect(msg).toMatch(/402 Insufficient Balance/);
    expect(msg).not.toContain("unknown_error");
    expect(generationFailureMessage(new AIProviderError("anthropic chat failed", 402))).toBe(
      GENERATION_PROVIDER_BALANCE_MESSAGE,
    );
    expect(generationFailureMessage(new Error("402 Insufficient Balance"))).toBe(
      GENERATION_PROVIDER_BALANCE_MESSAGE,
    );
    expect(generationFailureMessage(new Error("insufficient_quota"))).toBe(
      GENERATION_PROVIDER_BALANCE_MESSAGE,
    );
  });

  it("tells the project budget apart from the provider balance", () => {
    expect(generationFailureMessage(new BudgetExceededError(1_000, 900))).toBe(
      GENERATION_BUDGET_EXCEEDED_MESSAGE,
    );
  });

  it("recognises rate limiting", () => {
    expect(generationFailureMessage(new AIProviderError("slow down", 429))).toBe(
      GENERATION_PROVIDER_RATE_LIMITED_MESSAGE,
    );
    expect(generationFailureMessage(new Error("bedrock returned 429: ThrottlingException"))).toBe(
      GENERATION_PROVIDER_RATE_LIMITED_MESSAGE,
    );
    expect(generationFailureMessage(new Error('openai returned 429: {"error":{}}'))).toBe(
      GENERATION_PROVIDER_RATE_LIMITED_MESSAGE,
    );
    expect(generationFailureMessage(new Error("Rate limit reached for requests"))).toBe(
      GENERATION_PROVIDER_RATE_LIMITED_MESSAGE,
    );
  });

  it("recognises rejected credentials", () => {
    expect(generationFailureMessage(new AIProviderError("denied", 401))).toBe(
      GENERATION_PROVIDER_AUTH_MESSAGE,
    );
    expect(generationFailureMessage(new Error("openai returned 403: forbidden"))).toBe(
      GENERATION_PROVIDER_AUTH_MESSAGE,
    );
    expect(generationFailureMessage(new Error("Incorrect API key provided: sk-abc"))).toBe(
      GENERATION_PROVIDER_AUTH_MESSAGE,
    );
  });

  it("does not read a bare number in a message as a status", () => {
    expect(generationFailureMessage(new Error("parsed 402 tables in 429 ms"))).toBe(
      GENERATION_FAILED_MESSAGE,
    );
  });
});

describe("publicGenerationErrorMessage", () => {
  it("passes every safe message through unchanged, including the #53 restart message", () => {
    for (const safe of [
      GENERATION_INTERRUPTED_MESSAGE,
      GENERATION_FAILED_MESSAGE,
      GENERATION_PROVIDER_BALANCE_MESSAGE,
      GENERATION_BUDGET_EXCEEDED_MESSAGE,
      GENERATION_PROVIDER_RATE_LIMITED_MESSAGE,
      GENERATION_PROVIDER_AUTH_MESSAGE,
    ]) {
      expect(publicGenerationErrorMessage("failed", safe)).toBe(safe);
    }
  });

  it("sanitises raw text a pre-#52 failed row still holds", () => {
    expect(publicGenerationErrorMessage("failed", `Error: ${SECRET}`)).toBe(
      GENERATION_FAILED_MESSAGE,
    );
    expect(publicGenerationErrorMessage("failed", "Error: deepseek returned 402: {...}")).toBe(
      GENERATION_PROVIDER_BALANCE_MESSAGE,
    );
  });

  it("returns null for no message and leaves a non-failed row's field alone", () => {
    expect(publicGenerationErrorMessage("failed", null)).toBeNull();
    expect(publicGenerationErrorMessage("failed", undefined)).toBeNull();
    const legacyWarnings = JSON.stringify([{ kind: "ungrounded", message: "m" }]);
    expect(publicGenerationErrorMessage("degraded", legacyWarnings)).toBe(legacyWarnings);
  });
});
