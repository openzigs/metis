/**
 * #1230 — a model-authored string that overruns its schema cap must not
 * discard a completed investigation.
 *
 * `runAgent` already spends a repair call rather than throw away an answer that
 * is merely malformed JSON. Well-formed JSON that overruns one `maxLength` was
 * treated far more harshly: `schema.parse` threw and every finding in the run
 * was lost. Observed in production as the document specialist ("Mary") landing
 * `failed / 0 findings` on
 * `[{"code":"too_big","maximum":512,...,"path":["notes",0]}]` — a note, the
 * least load-bearing field in the payload.
 */
import { describe, expect, it } from "vitest";

import { agentOutputSchema } from "@metis/shared";

import { clampAgentOutputStrings } from "./agent-runner.js";

/** A finding that is valid on its own, so tests isolate the field under test. */
function validFinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    category: "architecture",
    severity: "high",
    title: "Chain ID is net-new on ShipmentOrderVO",
    body: "The job carrier has no chainId field, so the XDOCK chain cannot be modelled.",
    citations: [],
    tags: [],
    ...overrides,
  };
}

describe("clampAgentOutputStrings", () => {
  it("leaves output that is already within every cap byte-identical", () => {
    const output = {
      agentKey: "document",
      summary: "Investigated UC101.",
      findings: [validFinding()],
      notes: ["Retrieval covered 7 chunks."],
    };

    expect(clampAgentOutputStrings(structuredClone(output))).toEqual(output);
  });

  it("truncates an over-long note instead of failing the run", () => {
    const parsed = {
      agentKey: "document",
      summary: "Investigated UC101.",
      findings: [validFinding()],
      notes: ["N".repeat(900)],
    };

    // Baseline: this is exactly the production failure.
    expect(() => agentOutputSchema.parse(structuredClone(parsed))).toThrow(/too_big/);

    const validated = agentOutputSchema.parse(clampAgentOutputStrings(parsed));

    expect(validated.notes[0]).toHaveLength(512);
    // The point of the fix: the FINDING survives.
    expect(validated.findings).toHaveLength(1);
    expect(validated.findings[0]?.title).toBe("Chain ID is net-new on ShipmentOrderVO");
  });

  it("clamps every other model-authored cap that would otherwise throw", () => {
    const parsed = {
      agentKey: "code",
      summary: "S".repeat(4000),
      findings: [
        validFinding({
          title: "T".repeat(600),
          body: "B".repeat(9000),
          tags: ["g".repeat(200)],
          requirementId: "R".repeat(300),
        }),
      ],
      notes: [],
    };

    const validated = agentOutputSchema.parse(clampAgentOutputStrings(parsed));

    expect(validated.summary).toHaveLength(2048);
    expect(validated.findings[0]?.title).toHaveLength(255);
    expect(validated.findings[0]?.body).toHaveLength(4096);
    expect(validated.findings[0]?.tags[0]).toHaveLength(64);
    expect(validated.findings[0]?.requirementId).toHaveLength(128);
  });

  it("drops empty notes and tags, which fail the min(1) bound", () => {
    const parsed = {
      agentKey: "code",
      summary: "ok",
      findings: [validFinding({ tags: ["", "real"] })],
      notes: ["", "kept"],
    };

    const validated = agentOutputSchema.parse(clampAgentOutputStrings(parsed));

    expect(validated.notes).toEqual(["kept"]);
    expect(validated.findings[0]?.tags).toEqual(["real"]);
  });

  it("caps array lengths rather than letting .max() reject the payload", () => {
    const parsed = {
      agentKey: "code",
      summary: "ok",
      findings: Array.from({ length: 64 }, () => validFinding()),
      notes: Array.from({ length: 40 }, (_, i) => `note ${i}`),
    };

    const validated = agentOutputSchema.parse(clampAgentOutputStrings(parsed));

    expect(validated.findings).toHaveLength(50);
    expect(validated.notes).toHaveLength(20);
  });

  it("passes non-object and malformed input through untouched for Zod to reject", () => {
    expect(clampAgentOutputStrings(null)).toBeNull();
    expect(clampAgentOutputStrings("nope")).toBe("nope");
    // A non-array `findings` is a real schema violation and must still throw.
    expect(() =>
      agentOutputSchema.parse(
        clampAgentOutputStrings({ agentKey: "code", summary: "ok", findings: "nope", notes: [] }),
      ),
    ).toThrow();
  });
});
