import { describe, expect, it } from "vitest";
import {
  buildGenerationCheckpoint,
  checkpointSectionRecords,
  hashSectionInputs,
  recordSectionSynthesis,
  reusableSectionRecords,
  SECTION_SYNTHESIS_VERSION,
  sectionSynthesisSchema,
  storedSectionSynthesisSchema,
  type SectionInputHashes,
} from "./section-reuse.js";

const inputs = {
  facts: "actual facts",
  formulas: "global formulas",
  flow: "global flow",
  grounding: "actual grounding text and sources",
  context: "title/meta/group/docType",
  config: "provider/tuning/claim/judge budgets",
  prompts: "actual system/user prompts",
};
const payload = {
  markdown: "## Overview\n\nHistorical output.",
  warnings: [
    {
      kind: "section-truncated" as const,
      severity: "error" as const,
      section: "Overview",
      message: "Cut off",
    },
  ],
  score: null,
  metadata: {
    sectionLabel: "Overview",
    sectionIndex: 0,
    providerKind: "local" as const,
    model: "model",
    factsSourceIds: ["facts:a:0"],
    groundingSourceIds: ["facts:a:0"],
  },
  evidence: [
    {
      sourceId: "facts:a:0",
      kind: "facts" as const,
      label: "a",
      evidenceClass: null,
      contentHash: "a".repeat(64),
    },
  ],
};
const record = () => recordSectionSynthesis("overview", hashSectionInputs(inputs), payload);
const snapshot = () => ({
  version: SECTION_SYNTHESIS_VERSION,
  complete: true,
  records: [record()],
});

describe("proven section reuse", () => {
  it("stores hashes only and preserves immutable historical output metadata", () => {
    const original = structuredClone(payload);
    const saved = recordSectionSynthesis("overview", hashSectionInputs(inputs), original);
    original.warnings[0].message = "mutated";
    original.metadata.factsSourceIds.push("new");
    expect(saved.warnings[0].message).toBe("Cut off");
    expect(saved.metadata.factsSourceIds).toEqual(["facts:a:0"]);
    expect(JSON.stringify(saved)).not.toContain("actual facts");
    expect(sectionSynthesisSchema.parse(snapshot()).records[0]).toEqual(saved);
    expect(reusableSectionRecords(snapshot(), ["overview"], false).get("overview")).toEqual(saved);
  });

  it.each(Object.keys(inputs) as Array<keyof typeof inputs>)(
    "hashes every %s dependency byte-exactly",
    (key) => {
      const base = hashSectionInputs(inputs);
      const changed = hashSectionInputs({ ...inputs, [key]: `${inputs[key]} ` });
      expect(changed[key]).not.toBe(base[key]);
      expect(Object.keys(base)).toHaveLength(7);
    },
  );

  it.each([
    undefined,
    null,
    {},
    { ...snapshot(), complete: false },
    { ...snapshot(), version: SECTION_SYNTHESIS_VERSION + 1 },
    // #152 — a record written before claim extraction was batched.
    { ...snapshot(), version: 1 },
    { ...snapshot(), records: [] },
    { ...snapshot(), records: [record(), record()] },
    { ...snapshot(), extra: true },
    { ...snapshot(), records: [{ ...record(), inputs: { facts: "citation-is-not-proof" } }] },
    { ...snapshot(), records: [{ ...record(), markdown: "changed outside synthesis" }] },
    { ...snapshot(), records: [{ ...record(), warnings: [] }] },
    {
      ...snapshot(),
      records: [
        {
          ...record(),
          score: {
            faithfulness: 0.9,
            threshold: 0.8,
            result: {
              section: "Overview",
              totalClaims: 1,
              supportedClaims: 1,
              faithfulness: 1,
              verified: true,
              unsupportedClaims: [],
              supportedAttributions: [],
            },
          },
        },
      ],
    },
    { ...snapshot(), records: [{ ...record(), evidence: [] }] },
    {
      ...snapshot(),
      records: [{ ...record(), metadata: { ...payload.metadata, model: "other" } }],
    },
  ])("rejects missing, incomplete, corrupt or altered records %#", (previous) => {
    expect(reusableSectionRecords(previous, ["overview"], false).size).toBe(0);
  });

  it("rejects changed section sets and enabled shared escalation budgets", () => {
    expect(reusableSectionRecords(snapshot(), ["other"], false).size).toBe(0);
    expect(reusableSectionRecords(snapshot(), ["overview", "new"], false).size).toBe(0);
    expect(reusableSectionRecords(snapshot(), [], false).size).toBe(0);
    expect(reusableSectionRecords(snapshot(), ["overview"], true).size).toBe(0);
  });

  it("requires all dependency hashes, not just citation ids", () => {
    const incomplete = { facts: "a".repeat(64) } as SectionInputHashes;
    expect(() => recordSectionSynthesis("overview", incomplete, payload)).toThrow();
  });
});

describe("#246 — the reuse record accepts every warning kind a section can carry", () => {
  it("records a section with a grounding-failed warning without throwing", () => {
    const saved = recordSectionSynthesis("overview", hashSectionInputs(inputs), {
      ...payload,
      warnings: [
        {
          kind: "grounding-failed" as const,
          severity: "warning" as const,
          section: "Overview",
          message: "not checked",
        },
      ],
    });
    expect(saved.warnings[0].kind).toBe("grounding-failed");
  });
});

describe("#262 — a stored snapshot from another contract version", () => {
  it.each([1, 2, 3, SECTION_SYNTHESIS_VERSION + 1])(
    "parses a version-%i snapshot as stored but never reuses it",
    (version) => {
      const stored = { ...snapshot(), version };
      expect(storedSectionSynthesisSchema.parse(stored)).toEqual(stored);
      expect(reusableSectionRecords(stored, ["overview"], false).size).toBe(0);
    },
  );

  it.each([
    { ...snapshot(), records: [{}] },
    { ...snapshot(), extra: true },
    { ...snapshot(), version: 0 },
    { ...snapshot(), version: 2.5 },
    { complete: true, records: [] },
  ])("rejects a malformed snapshot %#", (stored) => {
    expect(storedSectionSynthesisSchema.safeParse(stored).success).toBe(false);
  });

  it("parses a current snapshot through the strict current schema", () => {
    expect(storedSectionSynthesisSchema.parse(snapshot())).toEqual(snapshot());
  });
});

describe("#782 — a partial generation checkpoint", () => {
  const second = () =>
    recordSectionSynthesis("rules", hashSectionInputs(inputs), {
      ...payload,
      markdown: "## Rules\n\nSecond.",
      metadata: { ...payload.metadata, sectionLabel: "Rules", sectionIndex: 1 },
    });

  it("round-trips a partial set: one finished section of several is reusable", () => {
    const stored = JSON.parse(JSON.stringify(buildGenerationCheckpoint([record()])));
    const byId = checkpointSectionRecords(stored, ["overview", "rules", "glossary"], false);
    expect([...byId.keys()]).toEqual(["overview"]);
    expect(byId.get("overview")).toEqual(record());
  });

  it("drops only the tampered record, never the rest", () => {
    const stored = buildGenerationCheckpoint([record(), second()]);
    stored.records[0] = { ...stored.records[0], markdown: "## Overview\n\nEdited." };
    const byId = checkpointSectionRecords(stored, ["overview", "rules"], false);
    expect([...byId.keys()]).toEqual(["rules"]);
  });

  it("drops a malformed record and one for a section this document does not have", () => {
    const stored = {
      version: SECTION_SYNTHESIS_VERSION,
      records: [{ sectionId: "overview" }, second()],
    };
    expect([...checkpointSectionRecords(stored, ["overview", "rules"], false).keys()]).toEqual([
      "rules",
    ]);
    expect(checkpointSectionRecords(stored, ["overview"], false).size).toBe(0);
  });

  it("keeps the first of two records for one section", () => {
    const later = { ...second(), sectionId: "overview" };
    const byId = checkpointSectionRecords(
      buildGenerationCheckpoint([record(), later]),
      ["overview"],
      false,
    );
    expect(byId.get("overview")!.markdown).toBe(payload.markdown);
  });

  it("reuses nothing from another contract version, a non-checkpoint or a shared escalation run", () => {
    const stored = buildGenerationCheckpoint([record()]);
    expect(
      checkpointSectionRecords(
        { ...stored, version: SECTION_SYNTHESIS_VERSION - 1 },
        ["overview"],
        false,
      ).size,
    ).toBe(0);
    expect(checkpointSectionRecords(null, ["overview"], false).size).toBe(0);
    expect(checkpointSectionRecords(snapshot(), ["overview"], false).size).toBe(0);
    expect(checkpointSectionRecords(stored, ["overview"], true).size).toBe(0);
  });
});
