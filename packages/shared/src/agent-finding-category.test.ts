/**
 * Issue #1222 — a model-authored `category` outside {@link FINDING_CATEGORIES}
 * must never discard the agent's whole investigation.
 *
 * Observed live on Bedrock (`us.anthropic.claude-sonnet-5`) against OrderBatch:
 * the `document` and `database` agents emitted `"info"` and `"migration"`, the
 * enum rejected them, `agentOutputSchema.parse` threw, and both agents were
 * recorded `failed` with every finding lost.
 */
import { describe, expect, it } from "vitest";
import {
  FALLBACK_FINDING_CATEGORY,
  agentFindingPayloadSchema,
  agentOutputSchema,
  coerceFindingCategory,
  documentAgentOutputSchema,
  matchFindingCategory,
  findingSchema,
} from "./analysis.js";
import { FINDING_CATEGORIES } from "./constants.js";

/** A minimal, otherwise-valid agent payload with one finding. */
function payloadWithCategory(category: unknown): Record<string, unknown> {
  return {
    agentKey: "database",
    summary: "Reviewed the batch schema against the requirements.",
    findings: [
      {
        category,
        severity: "medium",
        title: "No migration path for the new retention column",
        body: "The requirement adds a retention window but no migration adds the column.",
        citations: [],
        tags: ["schema"],
      },
    ],
    notes: [],
  };
}

describe("matchFindingCategory (#1222)", () => {
  it.each([...FINDING_CATEGORIES])("returns %s unchanged", (category) => {
    expect(matchFindingCategory(category)).toBe(category);
  });

  it.each([
    ["Security", "security"],
    ["  COMPLIANCE  ", "compliance"],
    ["Performance\n", "performance"],
  ])("normalises case and surrounding whitespace: %s -> %s", (raw, expected) => {
    expect(matchFindingCategory(raw)).toBe(expected);
  });

  it.each([
    // The two values measured in production.
    "info",
    "migration",
    // Plausible near-misses the next run could invent instead.
    "data",
    "maintainability",
    "sec urity",
    "",
  ])("returns null for the unrecognised value %j", (raw) => {
    expect(matchFindingCategory(raw)).toBeNull();
  });

  it.each([[null], [undefined], [42], [{ category: "security" }], [["security"]]])(
    "returns null for the non-string %j",
    (raw) => {
      expect(matchFindingCategory(raw)).toBeNull();
    },
  );
});

describe("coerceFindingCategory (#1222)", () => {
  it("falls back to `other`, which is a real member of the enum", () => {
    expect(FALLBACK_FINDING_CATEGORY).toBe("other");
    expect(FINDING_CATEGORIES).toContain(FALLBACK_FINDING_CATEGORY);
  });

  it.each(["info", "migration", "", null, undefined, 42])(
    "coerces the unrecognised value %j to the fallback",
    (raw) => {
      expect(coerceFindingCategory(raw)).toBe(FALLBACK_FINDING_CATEGORY);
    },
  );

  it.each([...FINDING_CATEGORIES])("leaves the recognised value %s alone", (category) => {
    expect(coerceFindingCategory(category)).toBe(category);
  });
});

describe("agentFindingPayloadSchema.category (#1222)", () => {
  it("accepts the exact production payload that used to fail outright", () => {
    // `info` is what the document agent emitted; `migration` is the database
    // agent's. Both parsed as JSON — only the enum rejected them.
    for (const emitted of ["info", "migration"]) {
      const parsed = agentOutputSchema.parse(payloadWithCategory(emitted));
      expect(parsed.findings).toHaveLength(1);
      expect(parsed.findings[0]?.category).toBe("other");
      // The rest of the finding survives byte-identically — the point of the
      // fix is that nothing but the one unrecognised word is lost.
      expect(parsed.findings[0]?.title).toBe("No migration path for the new retention column");
      expect(parsed.findings[0]?.tags).toEqual(["schema"]);
    }
  });

  it("preserves a recognised category exactly", () => {
    for (const category of FINDING_CATEGORIES) {
      const parsed = agentOutputSchema.parse(payloadWithCategory(category));
      expect(parsed.findings[0]?.category).toBe(category);
    }
  });

  it("keeps the document superset schema lenient too", () => {
    const parsed = documentAgentOutputSchema.parse({
      ...payloadWithCategory("info"),
      agentKey: "document",
      requirements: [],
    });
    expect(parsed.findings[0]?.category).toBe("other");
  });

  it("keeps the salvage path's per-finding parse from dropping the finding", () => {
    // `agentic-degradation.ts` safeParses findings ONE AT A TIME; before this
    // change an out-of-enum category silently deleted that finding there too.
    const result = agentFindingPayloadSchema.safeParse({
      category: "migration",
      severity: "high",
      title: "t",
      body: "b",
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.category).toBe("other");
  });

  it("coerces ONLY the category — every other invalid field still fails", () => {
    // The coercion must not become a general "make it valid" pass. A missing
    // title is still fatal, exactly as before.
    const bad = payloadWithCategory("migration") as {
      findings: Record<string, unknown>[];
    };
    delete bad.findings[0]!.title;
    expect(() => agentOutputSchema.parse(bad)).toThrow();

    const badSeverity = payloadWithCategory("security") as {
      findings: Record<string, unknown>[];
    };
    badSeverity.findings[0]!.severity = "catastrophic";
    expect(() => agentOutputSchema.parse(badSeverity)).toThrow();
  });
});

describe("findingSchema.category stays strict (#1222)", () => {
  it("rejects an out-of-enum category on the PERSISTED finding schema", () => {
    // Leniency belongs at the model boundary only. A row read back from the
    // database with a category outside the enum is a real data defect and must
    // still surface, not be quietly rewritten.
    const row = {
      id: "00000000-0000-4000-8000-000000000000",
      agentResultId: "00000000-0000-4000-8000-000000000001",
      category: "migration",
      severity: "medium",
      title: "t",
      body: "b",
      evidence: null,
      derivation: "inferred",
      confidence: 0.7,
      createdAt: new Date(),
    };
    expect(() => findingSchema.parse(row)).toThrow();
  });
});
