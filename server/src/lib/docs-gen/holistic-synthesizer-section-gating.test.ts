/**
 * Per-section faithfulness-gating wiring (Fix #3).
 *
 * Asserts the business-requirements section groups carry the intended
 * faithfulness tiers:
 *   - Key Workflows + Data & Domain Model → moderate RECONSTRUCTION bar (0.6),
 *     flagged `reconstruction` (NOT `narrative`).
 *   - Overview & Domain + Core Business Capabilities → narrative bar (0.4),
 *     flagged `narrative`.
 *   - Business Rules + Integrations & Glossary → strict default (no per-section
 *     override → resolves to 0.80) and neither narrative nor reconstruction.
 *
 * Prisma is stubbed via tests/setup.ts conventions; this suite never touches a
 * DB, the network, or a live model — it only inspects the static section-group
 * definitions and the threshold-resolution logic they feed.
 */
import { describe, it, expect } from "vitest";
import { sectionGroupsFor } from "./holistic-synthesizer.js";
import {
  resolveSectionFaithfulnessThreshold,
  RECONSTRUCTION_FAITHFULNESS_THRESHOLD,
  NARRATIVE_FAITHFULNESS_THRESHOLD,
  DEFAULT_FAITHFULNESS_THRESHOLD,
} from "./grounding/degraded-warnings.js";

function groupById(docType: "business-requirements", id: string) {
  const g = sectionGroupsFor(docType).find((x) => x.id === id);
  if (!g) throw new Error(`section group ${id} not found`);
  return g;
}

describe("business-requirements section gating", () => {
  it("gates Key Workflows at the moderate reconstruction bar (0.6), not narrative", () => {
    const g = groupById("business-requirements", "workflows");
    expect(g.faithfulnessThreshold).toBe(RECONSTRUCTION_FAITHFULNESS_THRESHOLD);
    expect(g.reconstruction).toBe(true);
    expect(g.narrative).toBeFalsy();
    expect(resolveSectionFaithfulnessThreshold(g.faithfulnessThreshold)).toBe(0.6);
  });

  it("gates Data & Domain Model at the moderate reconstruction bar (0.6), not narrative", () => {
    const g = groupById("business-requirements", "data-model");
    expect(g.faithfulnessThreshold).toBe(RECONSTRUCTION_FAITHFULNESS_THRESHOLD);
    expect(g.reconstruction).toBe(true);
    expect(g.narrative).toBeFalsy();
    expect(resolveSectionFaithfulnessThreshold(g.faithfulnessThreshold)).toBe(0.6);
  });

  it("keeps Business Rules at the STRICT default bar (0.80) — it is literal", () => {
    const g = groupById("business-requirements", "rules");
    expect(g.faithfulnessThreshold).toBeUndefined();
    expect(g.reconstruction).toBeFalsy();
    expect(g.narrative).toBeFalsy();
    // No per-section override → resolves to the global default (0.80) when env unset.
    expect(resolveSectionFaithfulnessThreshold(g.faithfulnessThreshold)).toBe(
      DEFAULT_FAITHFULNESS_THRESHOLD,
    );
  });

  it("keeps Integrations & Glossary at the STRICT default bar (0.80) — it is literal", () => {
    const g = groupById("business-requirements", "integrations-and-glossary");
    expect(g.faithfulnessThreshold).toBeUndefined();
    expect(g.reconstruction).toBeFalsy();
    expect(g.narrative).toBeFalsy();
    expect(resolveSectionFaithfulnessThreshold(g.faithfulnessThreshold)).toBe(
      DEFAULT_FAITHFULNESS_THRESHOLD,
    );
  });

  it("keeps Overview & Domain and Core Business Capabilities at the NARRATIVE bar (0.4)", () => {
    for (const id of ["overview", "capabilities"]) {
      const g = groupById("business-requirements", id);
      expect(g.faithfulnessThreshold).toBe(NARRATIVE_FAITHFULNESS_THRESHOLD);
      expect(g.narrative).toBe(true);
      expect(g.reconstruction).toBeFalsy();
    }
  });

  it("orders the three tiers narrative < reconstruction < strict", () => {
    const overview = groupById("business-requirements", "overview").faithfulnessThreshold!;
    const workflows = groupById("business-requirements", "workflows").faithfulnessThreshold!;
    const rulesResolved = resolveSectionFaithfulnessThreshold(
      groupById("business-requirements", "rules").faithfulnessThreshold,
    );
    expect(overview).toBeLessThan(workflows);
    expect(workflows).toBeLessThan(rulesResolved);
  });
});
