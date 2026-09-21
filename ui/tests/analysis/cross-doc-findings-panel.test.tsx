/**
 * CrossDocFindingsPanel tests (Epic #203 / Issue #221).
 *
 * Verifies the panel renders contradictions and completeness gaps with their
 * evidence references, splits the two groups, and shows an empty state.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CrossDocFindingsPanel } from "@/components/analysis/CrossDocFindingsPanel";
import type { CrossDocFindingsSummary } from "@/lib/analysis-api";

const BUNDLE: CrossDocFindingsSummary = {
  contradictionCount: 1,
  completenessGapCount: 2,
  generatedAt: "2026-06-16T00:00:00.000Z",
  findings: [
    {
      id: "f1",
      kind: "contradiction",
      severity: "high",
      title: "Latency contradiction",
      detail: "Premise: 200ms\nHypothesis: 5s",
      evidenceIds: ["docA", "docB"],
      scope: "pairwise",
    },
    {
      id: "f2",
      kind: "missing-nfr",
      severity: "medium",
      title: "No availability NFR",
      detail: "No uptime target stated.",
      evidenceIds: ["docA"],
      scope: null,
    },
    {
      id: "f3",
      kind: "missing-risk",
      severity: "medium",
      title: "No risks documented",
      detail: "No risk section present.",
      evidenceIds: [],
      scope: null,
    },
  ],
};

describe("CrossDocFindingsPanel", () => {
  it("renders contradictions and completeness gaps with counts", () => {
    render(<CrossDocFindingsPanel crossDocFindings={BUNDLE} />);
    expect(screen.getByText("Latency contradiction")).toBeInTheDocument();
    expect(screen.getByText("No availability NFR")).toBeInTheDocument();
    expect(screen.getByText("No risks documented")).toBeInTheDocument();
    expect(screen.getByText("Contradictions")).toBeInTheDocument();
    expect(screen.getByText("Completeness gaps")).toBeInTheDocument();
    // Count summary.
    expect(screen.getByText(/1 contradiction · 2 gaps/)).toBeInTheDocument();
  });

  it("renders evidence references for findings that have them", () => {
    render(<CrossDocFindingsPanel crossDocFindings={BUNDLE} />);
    expect(screen.getByText("docB")).toBeInTheDocument();
    // The risk gap has no evidence → shows the no-evidence note.
    expect(screen.getByText("No evidence references")).toBeInTheDocument();
  });

  it("shows the scope tag for contradictions only", () => {
    render(<CrossDocFindingsPanel crossDocFindings={BUNDLE} />);
    expect(screen.getByText("pairwise")).toBeInTheDocument();
  });

  it("omits the contradictions section when only completeness gaps exist", () => {
    render(
      <CrossDocFindingsPanel
        crossDocFindings={{
          contradictionCount: 0,
          completenessGapCount: 1,
          generatedAt: "2026-06-16T00:00:00.000Z",
          findings: [
            {
              id: "g1",
              kind: "missing-risk",
              severity: "medium",
              title: "No risks",
              detail: "none",
              evidenceIds: [],
              scope: null,
            },
          ],
        }}
      />,
    );
    expect(screen.queryByText("Contradictions")).not.toBeInTheDocument();
    expect(screen.getByText("Completeness gaps")).toBeInTheDocument();
    expect(screen.getByText(/0 contradictions · 1 gap/)).toBeInTheDocument();
  });

  it("omits the gaps section when only contradictions exist", () => {
    render(
      <CrossDocFindingsPanel
        crossDocFindings={{
          contradictionCount: 1,
          completenessGapCount: 0,
          generatedAt: "2026-06-16T00:00:00.000Z",
          findings: [
            {
              id: "c1",
              kind: "contradiction",
              severity: "high",
              title: "A vs B",
              detail: "conflict",
              evidenceIds: ["docA"],
              scope: "pairwise",
            },
          ],
        }}
      />,
    );
    expect(screen.getByText("Contradictions")).toBeInTheDocument();
    expect(screen.queryByText("Completeness gaps")).not.toBeInTheDocument();
  });

  it("renders an empty state when there are no findings", () => {
    render(
      <CrossDocFindingsPanel
        crossDocFindings={{
          findings: [],
          contradictionCount: 0,
          completenessGapCount: 0,
          generatedAt: "2026-06-16T00:00:00.000Z",
        }}
      />,
    );
    expect(
      screen.getByText(/No cross-document contradictions or completeness gaps detected/),
    ).toBeInTheDocument();
  });

  it("renders an empty state when crossDocFindings is null (pre-#203 analyses)", () => {
    render(<CrossDocFindingsPanel crossDocFindings={null} />);
    expect(screen.getByTestId("cross-doc-panel")).toBeInTheDocument();
    expect(
      screen.getByText(/No cross-document contradictions or completeness gaps detected/),
    ).toBeInTheDocument();
  });

  it("renders the full severity range and self-scope contradictions", () => {
    render(
      <CrossDocFindingsPanel
        crossDocFindings={{
          contradictionCount: 1,
          completenessGapCount: 2,
          generatedAt: "2026-06-16T00:00:00.000Z",
          findings: [
            {
              id: "c1",
              kind: "contradiction",
              severity: "critical",
              title: "Self contradiction",
              detail: "doc says X and not-X",
              evidenceIds: ["docA"],
              scope: "self",
            },
            {
              id: "g1",
              kind: "missing-acceptance-criteria",
              severity: "low",
              title: "AC gap",
              detail: "no AC",
              evidenceIds: ["docA"],
              scope: null,
            },
            {
              id: "g2",
              kind: "missing-assumption",
              severity: "info",
              title: "Assumption gap",
              detail: "no assumptions",
              evidenceIds: [],
              scope: null,
            },
          ],
        }}
      />,
    );
    expect(screen.getByText("Self contradiction")).toBeInTheDocument();
    expect(screen.getByText("self")).toBeInTheDocument();
    expect(screen.getByText("Missing acceptance criteria")).toBeInTheDocument();
    expect(screen.getByText("Missing assumption")).toBeInTheDocument();
    // Singular count wording when exactly one contradiction.
    expect(screen.getByText(/1 contradiction · 2 gaps/)).toBeInTheDocument();
  });

  // ── Issue #448 (epic #407) — readable evidence source labels ───────────────
  describe("evidence source labels (#448)", () => {
    const FINDING_ID_A = "ckxq9z8p10001abcd1234efgh";
    const FINDING_ID_B = "ckxq9z8p10002wxyz5678ijkl";

    it("AC1 — resolves enriched evidence to a readable source with #line", () => {
      render(
        <CrossDocFindingsPanel
          crossDocFindings={{
            contradictionCount: 1,
            completenessGapCount: 0,
            generatedAt: "2026-06-16T00:00:00.000Z",
            findings: [
              {
                id: "c1",
                kind: "contradiction",
                severity: "high",
                title: "Latency conflict",
                detail: "200ms vs 5s",
                evidenceIds: [FINDING_ID_A],
                evidence: [{ chunkId: FINDING_ID_A, sourceLabel: "requirements.md", line: 12 }],
                scope: "pairwise",
              },
            ],
          }}
        />,
      );
      // The chip shows the readable source + line, not the opaque finding id.
      expect(screen.getByText("requirements.md #12")).toBeInTheDocument();
      expect(screen.queryByText(FINDING_ID_A)).not.toBeInTheDocument();
    });

    it("AC4 — a connector:repo source renders via formatSourceLabel", () => {
      render(
        <CrossDocFindingsPanel
          crossDocFindings={{
            contradictionCount: 1,
            completenessGapCount: 0,
            generatedAt: "2026-06-16T00:00:00.000Z",
            findings: [
              {
                id: "c1",
                kind: "contradiction",
                severity: "high",
                title: "Spec conflict",
                detail: "x",
                evidenceIds: [FINDING_ID_A],
                evidence: [
                  {
                    chunkId: FINDING_ID_A,
                    sourceLabel:
                      "connector:repo:cmexample0000000000acmerp:src/main/java/com/acme/ShipmentAllocationsVO.java",
                  },
                ],
                scope: "pairwise",
              },
            ],
          }}
        />,
      );
      expect(screen.getByText("ShipmentAllocationsVO.java — acmerp")).toBeInTheDocument();
    });

    it("AC2 — degrades to the raw id when a finding is unresolved or un-enriched", () => {
      render(
        <CrossDocFindingsPanel
          crossDocFindings={{
            contradictionCount: 1,
            completenessGapCount: 0,
            generatedAt: "2026-06-16T00:00:00.000Z",
            findings: [
              {
                id: "c1",
                kind: "contradiction",
                severity: "high",
                title: "Mixed evidence",
                detail: "x",
                // Two ids; only the first resolves. The second (legacy/deleted
                // finding) is absent from `evidence` → must degrade to raw id.
                evidenceIds: [FINDING_ID_A, FINDING_ID_B],
                evidence: [{ chunkId: FINDING_ID_A, sourceLabel: "spec.pdf" }],
                scope: "pairwise",
              },
            ],
          }}
        />,
      );
      expect(screen.getByText("spec.pdf")).toBeInTheDocument();
      // Unresolved id falls back to the raw id as the chip label.
      expect(screen.getByText(FINDING_ID_B)).toBeInTheDocument();
    });

    it("AC2 — legacy payload with no `evidence` field renders raw ids unchanged", () => {
      render(
        <CrossDocFindingsPanel
          crossDocFindings={{
            contradictionCount: 1,
            completenessGapCount: 0,
            generatedAt: "2026-06-16T00:00:00.000Z",
            findings: [
              {
                id: "c1",
                kind: "contradiction",
                severity: "high",
                title: "Legacy finding",
                detail: "x",
                evidenceIds: [FINDING_ID_A],
                // No `evidence` (pre-#448 / un-enriched) → current behaviour.
                scope: "pairwise",
              },
            ],
          }}
        />,
      );
      expect(screen.getByText(FINDING_ID_A)).toBeInTheDocument();
    });

    it("AC3 — the raw finding id is preserved in the chip title tooltip", () => {
      render(
        <CrossDocFindingsPanel
          crossDocFindings={{
            contradictionCount: 1,
            completenessGapCount: 0,
            generatedAt: "2026-06-16T00:00:00.000Z",
            findings: [
              {
                id: "c1",
                kind: "contradiction",
                severity: "high",
                title: "Tooltip check",
                detail: "x",
                evidenceIds: [FINDING_ID_A],
                evidence: [{ chunkId: FINDING_ID_A, sourceLabel: "requirements.md", line: 3 }],
                scope: "pairwise",
              },
            ],
          }}
        />,
      );
      const chip = screen.getByText("requirements.md #3");
      // The opaque raw id stays discoverable on hover even when the label is readable.
      expect(chip).toHaveAttribute("title", `Evidence: ${FINDING_ID_A}`);
    });
  });
});
