/**
 * #1059 — a failed Spec Kit job stores the error the synchronous route would
 * have answered with. `toSpecKitJobError` is that mapping: the route's own
 * `rethrow`, turned into `{ status, code, message, details }`.
 *
 * The end-to-end proof (the same failure on both routes, compared) is in
 * `spec-kit-jobs-1059.sqlite.test.ts`; this covers every class the mapping
 * knows, and what it does with one it does not.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toSpecKitJobError } from "../src/routes/spec-kit.js";
import { AppError } from "../src/middleware/error-handler.js";
import { SpecKitArtifactError } from "../src/lib/spec-kit/artifacts.js";
import { GateUnmetError } from "../src/lib/spec-kit/gates.js";
import { SpecKitFeatureLifecycleError } from "../src/lib/spec-kit/features.js";
import { BudgetExceededError } from "../src/lib/finops/budget-enforcer.js";
import { SafetyDeniedError } from "../src/lib/safety/safety-hook.js";
import { AIProviderError, AIProviderRetiredError } from "../src/lib/ai/errors.js";
import {
  SPEC_KIT_EMPTY_OUTPUT_CODE,
  SPEC_KIT_OUTPUT_EXHAUSTED_CODE,
} from "../src/lib/spec-kit/commands/runner.js";

describe("toSpecKitJobError — the synchronous route's statuses and codes", () => {
  it.each([SPEC_KIT_OUTPUT_EXHAUSTED_CODE, SPEC_KIT_EMPTY_OUTPUT_CODE])(
    "keeps 502 %s and its message",
    (code) => {
      expect(toSpecKitJobError(new SpecKitArtifactError(502, code, "Nothing was saved."))).toEqual({
        status: 502,
        code,
        message: "Nothing was saved.",
      });
    },
  );

  it("keeps a gate's 412 and names the gate in details", () => {
    expect(toSpecKitJobError(new GateUnmetError("planGate", "plan.md is required"))).toEqual({
      status: 412,
      code: "SPECKIT_GATE_UNMET",
      message: "plan.md is required",
      details: { required: "planGate" },
    });
  });

  it("keeps the budget's 402 with the figures", () => {
    expect(toSpecKitJobError(new BudgetExceededError(200, 150))).toEqual({
      status: 402,
      code: "BUDGET_EXCEEDED",
      message: "Project monthly budget exceeded: used 200 of 150 tokens",
      details: { usedTokens: 200, budget: 150 },
    });
  });

  it("keeps a safety denial's 422 with its findings", () => {
    const findings = [{ kind: "pii", detail: "email" }] as never;
    expect(toSpecKitJobError(new SafetyDeniedError("input", findings))).toMatchObject({
      status: 422,
      code: "SAFETY_DENIED",
      details: { findings },
    });
  });

  it("maps a provider that cannot be built to 502, and a retired one to 409", () => {
    expect(toSpecKitJobError(new AIProviderError("no key for anthropic"))).toEqual({
      status: 502,
      code: "AI_PROVIDER_KEY_UNAVAILABLE",
      message: "no key for anthropic",
    });
    const retired = toSpecKitJobError(new AIProviderRetiredError("copilot-native"));
    expect(retired).toMatchObject({ status: 409, code: "AI_PROVIDER_RETIRED" });
  });

  it("keeps a feature lifecycle error and an AppError thrown by the dispatcher", () => {
    expect(
      toSpecKitJobError(new SpecKitFeatureLifecycleError(409, "SPECKIT_ARCHIVED", "archived")),
    ).toEqual({ status: 409, code: "SPECKIT_ARCHIVED", message: "archived" });
    expect(
      toSpecKitJobError(
        new AppError(400, "SPECKIT_FEATURE_REQUIRED", "featureSlug required for /speckit.plan"),
      ),
    ).toEqual({
      status: 400,
      code: "SPECKIT_FEATURE_REQUIRED",
      message: "featureSlug required for /speckit.plan",
    });
  });

  it("turns a validation error into the friendly 400, never the raw issues", () => {
    const parsed = z.object({ owner: z.string().min(1) }).safeParse({ owner: "" });
    const mapped = toSpecKitJobError(parsed.error);
    expect(mapped).toMatchObject({ status: 400, code: "VALIDATION_ERROR" });
    expect(mapped.details).toEqual({ fields: [{ field: "owner", message: "owner is required" }] });
    expect(JSON.stringify(mapped)).not.toContain("too_small");
  });

  it("maps another status-carrying class by status and code, but never forwards its message", () => {
    const err = Object.assign(new Error("resolves to private address 169.254.169.254"), {
      name: "ProjectError",
      status: 404,
      code: "PROJECT_NOT_FOUND",
    });
    const mapped = toSpecKitJobError(err);
    expect(mapped).toMatchObject({ status: 404, code: "PROJECT_NOT_FOUND" });
    expect(mapped.message).not.toContain("169.254");
  });

  it.each([
    ["an unknown error", new Error("postgres://user:pw@db is down")],
    ["a thrown string", "boom"],
    ["a class whose status came from upstream", Object.assign(new Error("x"), { status: 401 })],
  ])("stores %s as a generic 500", (_name, thrown) => {
    expect(toSpecKitJobError(thrown)).toEqual({
      status: 500,
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred",
    });
  });
});
