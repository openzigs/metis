/**
 * Tests for the suggestion prompt schemas (Epic #856 issue #870).
 */
import { describe, it, expect } from "vitest";

import {
  SUGGESTION_SYSTEM_PROMPT,
  SuggestionItemSchema,
  SuggestionResponseSchema,
  buildClusterPrompt,
} from "../../../src/lib/testcoverage/suggestion-prompt.js";

describe("SUGGESTION_SYSTEM_PROMPT", () => {
  it("includes the JSON shape and the rules block", () => {
    expect(SUGGESTION_SYSTEM_PROMPT).toMatch(/"suggestions"/);
    expect(SUGGESTION_SYSTEM_PROMPT).toMatch(/AT MOST 5/);
    expect(SUGGESTION_SYSTEM_PROMPT).toMatch(/AT MOST 3 steps/);
  });
});

describe("SuggestionItemSchema", () => {
  const valid = {
    title: "Test login lockout",
    priority: "high" as const,
    preconditions: ["user exists"],
    steps: [{ action: "submit wrong pwd 5x", expected: "account locked" }],
    bdd: {
      feature: "Auth",
      scenario: "Lockout",
      given: ["user exists"],
      when: ["wrong pwd 5x"],
      then: ["account locked"],
    },
    tags: ["auth"],
    mappedRequirementIds: ["r1"],
    sourceChunks: [],
    confidence: 0.8,
  };

  it("accepts a valid suggestion", () => {
    expect(SuggestionItemSchema.parse(valid)).toBeDefined();
  });

  it("rejects >3 steps", () => {
    expect(() =>
      SuggestionItemSchema.parse({
        ...valid,
        steps: [
          { action: "a", expected: "1" },
          { action: "b", expected: "2" },
          { action: "c", expected: "3" },
          { action: "d", expected: "4" },
        ],
      }),
    ).toThrow();
  });

  it("rejects missing mappedRequirementIds", () => {
    expect(() => SuggestionItemSchema.parse({ ...valid, mappedRequirementIds: [] })).toThrow();
  });

  it("rejects confidence out of range", () => {
    expect(() => SuggestionItemSchema.parse({ ...valid, confidence: 1.5 })).toThrow();
  });
});

describe("SuggestionResponseSchema", () => {
  it("caps suggestions at 5", () => {
    const one = {
      title: "valid title",
      priority: "low" as const,
      preconditions: [],
      steps: [{ action: "a", expected: "b" }],
      bdd: { feature: "f", scenario: "s", given: ["g"], when: ["w"], then: ["t"] },
      tags: [],
      mappedRequirementIds: ["r1"],
      sourceChunks: [],
      confidence: 0.5,
    };
    expect(() =>
      SuggestionResponseSchema.parse({ suggestions: [one, one, one, one, one, one] }),
    ).toThrow();
    expect(SuggestionResponseSchema.parse({ suggestions: [one] })).toBeDefined();
  });
});

describe("buildClusterPrompt", () => {
  it("includes all requirements", () => {
    const prompt = buildClusterPrompt({
      requirements: [
        { id: "r1", title: "Login lockout", body: "lock after 5", priority: "high" },
        { id: "r2", title: "Password reset", body: "email link", priority: "medium" },
      ],
      sourceExcerpts: [],
    });
    expect(prompt).toMatch(/id=r1/);
    expect(prompt).toMatch(/id=r2/);
    expect(prompt).toMatch(/Login lockout/);
  });

  it("includes excerpts when supplied", () => {
    const prompt = buildClusterPrompt({
      requirements: [{ id: "r1", title: "x", body: "y", priority: "low" }],
      sourceExcerpts: [{ chunkId: "c1", excerpt: "auth spec text" }],
    });
    expect(prompt).toMatch(/SUPPORTING EXCERPTS/);
    expect(prompt).toMatch(/chunkId=c1/);
    expect(prompt).toMatch(/auth spec text/);
  });

  it("omits excerpts header when none supplied", () => {
    const prompt = buildClusterPrompt({
      requirements: [{ id: "r1", title: "x", body: "y", priority: "low" }],
      sourceExcerpts: [],
    });
    expect(prompt).not.toMatch(/SUPPORTING EXCERPTS/);
  });

  it("is deterministic across calls", () => {
    const a = buildClusterPrompt({
      requirements: [{ id: "r1", title: "x", body: "y", priority: "low" }],
      sourceExcerpts: [{ chunkId: "c1", excerpt: "e" }],
    });
    const b = buildClusterPrompt({
      requirements: [{ id: "r1", title: "x", body: "y", priority: "low" }],
      sourceExcerpts: [{ chunkId: "c1", excerpt: "e" }],
    });
    expect(a).toBe(b);
  });
});
