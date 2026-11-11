/**
 * #2236 — an answer re-runs code mapping and governing impact for the
 * requirements it applies to, and its old governing findings read as being
 * re-checked until the new ones are stored.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GoverningAnalysisApplicability } from "@metis/shared";
import type { StoredClarification } from "./clarification-records.js";

const db = vi.hoisted(() => ({ requirement: { findMany: vi.fn() } }));
vi.mock("../prisma.js", () => ({ prisma: db }));
const applicability = vi.hoisted(() => ({ stored: null as GoverningAnalysisApplicability | null }));
vi.mock("../governing/applicability-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../governing/applicability-store.js")>()),
  readGoverningApplicability: vi.fn(async () => applicability.stored),
}));
const structured = vi.hoisted(() => ({ list: null as unknown }));
vi.mock("../analysis/analysis-service.js", () => ({
  getStructuredRequirements: vi.fn(async () => structured.list),
  updateGoverningApplicabilityMetadata: vi.fn(
    async (_id: string, update: (raw: unknown) => unknown) => {
      const next = update(applicability.stored);
      if (next !== undefined) applicability.stored = next as GoverningAnalysisApplicability;
    },
  ),
}));

const {
  CLARIFIED_TEXT_MARKER,
  applicabilityEntryFor,
  baseRequirementText,
  clarifiedRequirementText,
  rerunAfterClarification,
} = await import("./clarification-rerun.js");
const { sanitizeClarificationText } = await import("../analysis/clarification-enrichment.js");

function record(over: Partial<StoredClarification> = {}): StoredClarification {
  return {
    id: "rec-1",
    projectId: "p1",
    origin: "analysis",
    questionKey: "k1",
    analysisId: "a1",
    specKitFeature: null,
    questionId: "q1",
    question: "How long must a password be?",
    answer: "At least 12 characters.",
    answeredById: "u1",
    answeredAt: new Date("2026-11-11T00:00:00.000Z"),
    ambiguityField: "minimumLength",
    source: null,
    requirementIds: ["R-1"],
    productIds: [],
    status: "settled",
    reopenedAt: null,
    knowledgeDocumentId: null,
    ...over,
  };
}

const STORED: GoverningAnalysisApplicability = {
  decidedAt: "2026-11-08T00:00:00.000Z",
  requirements: [
    { requirementId: "AC-1", text: "Users sign in with a password policy enforced", decisions: [] },
    { requirementId: "AC-2", text: "Bulk export of orders to CSV", decisions: [] },
  ],
};

const provider = { key: "anthropic", model: "m", offline: false, chat: vi.fn() } as never;

beforeEach(() => {
  vi.clearAllMocks();
  applicability.stored = structuredClone(STORED);
  structured.list = { requirements: [{ id: "R-1", title: "Password policy enforced" }] };
  db.requirement.findMany.mockResolvedValue([]);
});

describe("#2236 — clarified requirement text", () => {
  it("appends the answers once, replacing any appended before", () => {
    const once = clarifiedRequirementText("Base text", [record()]);
    expect(once).toBe(
      `Base text${CLARIFIED_TEXT_MARKER}\n- Q: How long must a password be?\n  A: At least 12 characters.`,
    );
    const twice = clarifiedRequirementText(once, [record({ answer: "15." })]);
    expect(twice).toBe(
      `Base text${CLARIFIED_TEXT_MARKER}\n- Q: How long must a password be?\n  A: 15.`,
    );
    expect(baseRequirementText(twice)).toBe("Base text");
    expect(clarifiedRequirementText(once, [])).toBe("Base text");
  });
});

describe("#2236 — applicabilityEntryFor", () => {
  it("takes the entry with the requirement's id, else the one entry its title matches", () => {
    expect(applicabilityEntryFor(STORED, { id: "AC-2", title: "anything" })).toBe("AC-2");
    expect(applicabilityEntryFor(STORED, { id: "R-1", title: "Password policy enforced" })).toBe(
      "AC-1",
    );
    expect(applicabilityEntryFor(STORED, { id: "R-1", title: "Invoices" })).toBeNull();
    expect(applicabilityEntryFor(STORED, { id: "R-1", title: undefined })).toBeNull();
  });

  it("matches nothing on a tie", () => {
    const tied: GoverningAnalysisApplicability = {
      ...STORED,
      requirements: [
        { requirementId: "X", text: "password policy", decisions: [] },
        { requirementId: "Y", text: "password policy", decisions: [] },
      ],
    };
    expect(applicabilityEntryFor(tied, { id: "R-1", title: "Password policy" })).toBeNull();
  });
});

describe("#2236 — rerunAfterClarification", () => {
  it("maps the requirements that carry the changed answer to code again, scoped to the analysis and project", async () => {
    const written = sanitizeClarificationText("At least 12 characters.");
    db.requirement.findMany.mockResolvedValue([
      { id: "row-1", title: "Password policy", body: `x\n**A:** ${written} _(typed)_` },
      { id: "row-2", title: "Export", body: "x\n**A:** something else" },
    ]);
    const mapToCode = vi.fn(async () => []);
    const result = await rerunAfterClarification(
      { analysisId: "a1", projectId: "p1", provider, records: [record()] },
      { mapToCode, applicabilityHookFor: async () => null },
    );
    expect(db.requirement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ analysisId: "a1", projectId: "p1", deletedAt: null }),
      }),
    );
    expect(mapToCode).toHaveBeenCalledTimes(1);
    expect(mapToCode).toHaveBeenCalledWith(expect.objectContaining({ id: "row-1" }), "p1");
    expect(result.codeMapped).toBe(1);
  });

  it("re-decides applicability on the clarified text and re-produces the findings in one run", async () => {
    const decide = vi.fn(async (r: { id: string; text: string }) => ({
      requirementId: r.id,
      decisions: [
        {
          ruleId: "rule-1",
          controlId: "PW-1",
          verdict: "applies" as const,
          reason: "passwords",
          foundBy: ["screen" as const],
        },
      ],
      rulesScreened: 1,
      screenBatches: 1,
      candidates: 1,
      reasked: 0,
      screenReasked: 0,
    }));
    let preparedBeforeProduce = false;
    const produceFindings = vi.fn(async (input: { prepare?: () => Promise<void> }) => {
      await input.prepare?.();
      preparedBeforeProduce = decide.mock.calls.length === 1;
      return {} as never;
    });
    const result = await rerunAfterClarification(
      { analysisId: "a1", projectId: "p1", provider, records: [record()] },
      { mapToCode: vi.fn(), applicabilityHookFor: async () => ({ decide }), produceFindings },
    );
    expect(result.governingRequirements).toEqual(["AC-1"]);
    expect(produceFindings).toHaveBeenCalledWith(
      expect.objectContaining({ analysisId: "a1", projectId: "p1", requirementIds: ["AC-1"] }),
    );
    expect(preparedBeforeProduce).toBe(true);
    expect(decide).toHaveBeenCalledWith({
      id: "AC-1",
      text: expect.stringContaining("A: At least 12 characters."),
    });
    // The stored applicability now carries the re-decided entry; the other stands.
    const ac1 = applicability.stored!.requirements.find((r) => r.requirementId === "AC-1")!;
    expect(ac1.text).toContain(CLARIFIED_TEXT_MARKER);
    expect(ac1.decisions.map((d) => d.ruleId)).toEqual(["rule-1"]);
    expect(applicability.stored!.requirements.find((r) => r.requirementId === "AC-2")).toEqual(
      STORED.requirements[1],
    );
  });

  it("re-runs nothing for a governing answer (its own settle refreshes those findings)", async () => {
    const produceFindings = vi.fn();
    const mapToCode = vi.fn();
    const result = await rerunAfterClarification(
      {
        analysisId: "a1",
        projectId: "p1",
        provider,
        records: [record({ ambiguityField: null })],
      },
      { mapToCode, applicabilityHookFor: async () => ({ decide: vi.fn() }), produceFindings },
    );
    expect(result).toEqual({ codeMapped: 0, governingRequirements: [], governingUnmatched: [] });
    expect(produceFindings).not.toHaveBeenCalled();
    expect(db.requirement.findMany).not.toHaveBeenCalled();
  });

  it("reports a requirement no applicability entry matches, and skips governing with no stored applicability or no hook", async () => {
    structured.list = { requirements: [{ id: "R-1", title: "Invoices" }] };
    const produceFindings = vi.fn();
    const hook = async () => ({ decide: vi.fn() });
    const unmatched = await rerunAfterClarification(
      { analysisId: "a1", projectId: "p1", provider, records: [record()] },
      { mapToCode: vi.fn(), applicabilityHookFor: hook, produceFindings },
    );
    expect(unmatched.governingUnmatched).toEqual(["R-1"]);
    expect(produceFindings).not.toHaveBeenCalled();

    applicability.stored = null;
    const none = await rerunAfterClarification(
      { analysisId: "a1", projectId: "p1", provider, records: [record()] },
      { mapToCode: vi.fn(), applicabilityHookFor: hook, produceFindings },
    );
    expect(none.governingRequirements).toEqual([]);
    expect(produceFindings).not.toHaveBeenCalled();
  });

  it("never throws: a failed code mapping or findings run is logged and the rest goes on", async () => {
    db.requirement.findMany.mockResolvedValue([
      { id: "row-1", title: "t", body: sanitizeClarificationText("At least 12 characters.") },
    ]);
    const result = await rerunAfterClarification(
      { analysisId: "a1", projectId: "p1", provider, records: [record()] },
      {
        mapToCode: async () => {
          throw new Error("search down");
        },
        applicabilityHookFor: async () => ({ decide: vi.fn() }),
        produceFindings: async () => {
          throw new Error("provider down");
        },
      },
    );
    expect(result.codeMapped).toBe(0);
    expect(result.governingRequirements).toEqual([]);
  });
});
