/**
 * #1873 — the stored applicability: what the join stores, and which pairs a BA
 * answer may move. The database helpers are stubs over one in-memory blob.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GoverningAnalysisApplicability } from "@metis/shared";

const blob = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock("../analysis/analysis-service.js", () => ({
  readGoverningApplicabilityMetadata: vi.fn(async () => blob.value),
  updateGoverningApplicabilityMetadata: vi.fn(
    async (_id: string, update: (current: unknown) => unknown) => {
      const next = update(blob.value);
      if (next !== undefined) blob.value = next;
    },
  ),
}));

const {
  applySettlements,
  persistGoverningApplicability,
  readGoverningApplicability,
  settleGoverningPairs,
  toStoredApplicability,
} = await import("./applicability-store.js");

const AT = new Date("2026-11-08T12:00:00.000Z");

const STORED: GoverningAnalysisApplicability = {
  decidedAt: AT.toISOString(),
  requirements: [
    {
      requirementId: "REQ-001",
      text: "Saved card checkout.",
      decisions: [
        {
          ruleId: "r_card",
          controlId: "EN-03",
          verdict: "uncertain",
          reason: "Depends.",
          businessFact: "Is the whole number kept?",
          foundBy: ["screen"],
        },
        {
          ruleId: "r_log",
          controlId: "AL-02",
          verdict: "applies",
          reason: "Reads.",
          foundBy: ["top-k"],
        },
      ],
    },
  ],
};

const settle = (ruleId: string, verdict: "applies" | "does-not-apply" | "uncertain") => ({
  requirementId: "REQ-001",
  ruleId,
  verdict,
  reason: `now ${verdict}`,
  questionId: "q1",
  answer: "Yes.",
});

beforeEach(() => {
  blob.value = undefined;
});

describe("toStoredApplicability", () => {
  it("keeps each requirement's set, its error, and leaves out a requirement with none", () => {
    const stored = toStoredApplicability(
      [
        {
          requirementId: "REQ-001",
          text: "A",
          chunks: [],
          governing: {
            requirementId: "REQ-001",
            decisions: [
              {
                ruleId: "r1",
                controlId: "C-1",
                verdict: "uncertain",
                reason: "r",
                businessFact: "f?",
                foundBy: ["screen"],
              },
            ],
            rulesScreened: 1,
            screenBatches: 1,
            candidates: 1,
            reasked: 0,
            screenReasked: 0,
          },
        },
        { requirementId: "REQ-002", text: "B", chunks: [] },
        {
          requirementId: "REQ-003",
          text: "C",
          chunks: [],
          governing: {
            requirementId: "REQ-003",
            decisions: [],
            rulesScreened: 0,
            screenBatches: 0,
            candidates: 0,
            reasked: 0,
            screenReasked: 0,
            error: "could not be decided",
          },
        },
      ],
      AT,
    );
    expect(stored).toEqual({
      decidedAt: AT.toISOString(),
      requirements: [
        {
          requirementId: "REQ-001",
          text: "A",
          decisions: [
            {
              ruleId: "r1",
              controlId: "C-1",
              verdict: "uncertain",
              reason: "r",
              businessFact: "f?",
              foundBy: ["screen"],
            },
          ],
        },
        { requirementId: "REQ-003", text: "C", decisions: [], error: "could not be decided" },
      ],
    });
  });
});

describe("applySettlements — an answer moves only an unsettled uncertain pair", () => {
  it("moves the uncertain pair and records how; drops its question once decided", () => {
    const { next, applied } = applySettlements(STORED, [settle("r_card", "applies")], AT);
    expect(applied).toHaveLength(1);
    expect(next.requirements[0]!.decisions[0]).toEqual({
      ruleId: "r_card",
      controlId: "EN-03",
      verdict: "applies",
      reason: "now applies",
      foundBy: ["screen"],
      settled: {
        questionId: "q1",
        answer: "Yes.",
        previousVerdict: "uncertain",
        at: AT.toISOString(),
      },
    });
  });

  it("an answer never overturns a verdict reached without asking, nor applies twice", () => {
    const once = applySettlements(STORED, [settle("r_card", "applies")], AT).next;
    const { next, applied } = applySettlements(
      once,
      [settle("r_card", "does-not-apply"), settle("r_log", "does-not-apply")],
      AT,
    );
    expect(applied).toEqual([]);
    expect(next).toEqual(once);
  });

  it("an answer that still leaves it uncertain keeps the question and marks it settled", () => {
    const { next } = applySettlements(STORED, [settle("r_card", "uncertain")], AT);
    expect(next.requirements[0]!.decisions[0]).toMatchObject({
      verdict: "uncertain",
      businessFact: "Is the whole number kept?",
      settled: { questionId: "q1" },
    });
  });
});

describe("persist, read and settle through the metadata blob", () => {
  it("reads back what was stored; a malformed blob reads as none", async () => {
    expect(await readGoverningApplicability("a")).toBeNull();
    await persistGoverningApplicability("a", STORED);
    expect(await readGoverningApplicability("a")).toEqual(STORED);
    blob.value = { requirements: "not a list" };
    expect(await readGoverningApplicability("a")).toBeNull();
  });

  it("settleGoverningPairs writes the move; with nothing stored it writes nothing", async () => {
    expect(await settleGoverningPairs("a", [settle("r_card", "applies")])).toEqual([]);
    expect(blob.value).toBeUndefined();
    await persistGoverningApplicability("a", STORED);
    const applied = await settleGoverningPairs("a", [settle("r_card", "does-not-apply")]);
    expect(applied.map((s) => s.ruleId)).toEqual(["r_card"]);
    const read = await readGoverningApplicability("a");
    expect(read!.requirements[0]!.decisions[0]!.verdict).toBe("does-not-apply");
  });
});
