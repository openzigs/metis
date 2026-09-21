/**
 * Epic #726 (#736) — per-requirement coverage classifier.
 *
 * Proves the three states are derived deterministically from linked-finding
 * citation shapes, that CODE beats DOCS beats nothing (rule ordering), and that
 * the requirement-level aggregation over `evidenceFindingIndexes` is correct
 * (including out-of-range / empty indexes → `no_evidence`).
 */
import { describe, it, expect } from "vitest";
import type { Citation, CodeCitation, DocumentCitation } from "@metis/shared";
import {
  classifyRequirementCoverage,
  computeCoverageForRequirements,
} from "./requirement-coverage.js";

const codeCitation: CodeCitation = { filePath: "src/auth/login.ts", startLine: 10, endLine: 24 };
const docCitation: DocumentCitation = { documentId: "doc_123", chunkIndex: 2 };

describe("classifyRequirementCoverage", () => {
  it("grounded_in_code — any CODE citation present", () => {
    const citations: Citation[] = [docCitation, codeCitation];
    expect(classifyRequirementCoverage({ citations })).toBe("grounded_in_code");
  });

  it("grounded_in_docs_only — only DOCUMENT citations", () => {
    const citations: Citation[] = [docCitation, { documentId: "doc_9", chunkIndex: 0 }];
    expect(classifyRequirementCoverage({ citations })).toBe("grounded_in_docs_only");
  });

  it("no_evidence — no citations at all", () => {
    expect(classifyRequirementCoverage({ citations: [] })).toBe("no_evidence");
  });

  it("code citation wins even when it appears after doc citations (rule ordering)", () => {
    const citations: Citation[] = [docCitation, docCitation, codeCitation];
    expect(classifyRequirementCoverage({ citations })).toBe("grounded_in_code");
  });

  it("tolerates a nullish citation list as no_evidence", () => {
    expect(classifyRequirementCoverage({ citations: undefined as unknown as Citation[] })).toBe(
      "no_evidence",
    );
  });
});

describe("computeCoverageForRequirements", () => {
  it("classifies each requirement from its aggregated linked-finding citations", () => {
    const flatFindings = [
      { citations: [codeCitation] }, // 0 — code
      { citations: [docCitation] }, // 1 — doc
      { citations: [] as Citation[] }, // 2 — placeholder / no citations
    ];
    const requirements = [
      { evidenceFindingIndexes: [0] }, // → grounded_in_code
      { evidenceFindingIndexes: [1] }, // → grounded_in_docs_only
      { evidenceFindingIndexes: [2] }, // → no_evidence (placeholder only)
      { evidenceFindingIndexes: [] }, // → no_evidence (unlinked)
      { evidenceFindingIndexes: [1, 0] }, // → grounded_in_code (union across findings)
    ];

    expect(computeCoverageForRequirements(requirements, flatFindings)).toEqual([
      "grounded_in_code",
      "grounded_in_docs_only",
      "no_evidence",
      "no_evidence",
      "grounded_in_code",
    ]);
  });

  it("treats a missing evidenceFindingIndexes as no_evidence (fallback synthesis)", () => {
    const flatFindings = [{ citations: [codeCitation] }];
    // A fallback-synthesised requirement object may omit the array entirely.
    const requirements = [{}, { evidenceFindingIndexes: [0] }] as Array<{
      evidenceFindingIndexes?: number[];
    }>;
    expect(computeCoverageForRequirements(requirements, flatFindings)).toEqual([
      "no_evidence",
      "grounded_in_code",
    ]);
  });

  it("ignores out-of-range evidence indexes (stale index → no_evidence)", () => {
    const flatFindings = [{ citations: [codeCitation] }];
    const requirements = [{ evidenceFindingIndexes: [99] }];
    expect(computeCoverageForRequirements(requirements, flatFindings)).toEqual(["no_evidence"]);
  });

  it("is index-aligned with the requirements input", () => {
    const flatFindings = [{ citations: [docCitation] }];
    const out = computeCoverageForRequirements(
      [{ evidenceFindingIndexes: [] }, { evidenceFindingIndexes: [0] }],
      flatFindings,
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toBe("no_evidence");
    expect(out[1]).toBe("grounded_in_docs_only");
  });
});
