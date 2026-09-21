/**
 * Epic #727 (#740) — pure verifier unit tests.
 *
 * Locks the deterministic rule that turns the #734 grounding-gate output into a
 * per-finding `confirmed | unverified | null` verdict. No I/O, no LLM.
 */
import { describe, expect, it } from "vitest";
import type { Citation, CodeCitation, DocumentCitation } from "@metis/shared";
import { verifyFinding } from "./finding-verification.js";
import type { DroppedCitation } from "./code-citations.js";

const code: CodeCitation = { filePath: "src/api/auth.ts", startLine: 10, endLine: 20 };
const doc: DocumentCitation = { documentId: "doc_1", chunkIndex: 0 };

describe("verifyFinding (#740)", () => {
  it("confirms a finding that kept a grounded code citation", () => {
    expect(verifyFinding({ groundedCitations: [code] as Citation[], droppedCitations: [] })).toBe(
      "confirmed",
    );
  });

  it("confirms when a grounded code citation survives alongside a doc citation", () => {
    expect(
      verifyFinding({
        groundedCitations: [doc, code] as Citation[],
        droppedCitations: [{ filePath: "ghost.ts", reason: "file-not-retrieved" }],
      }),
    ).toBe("confirmed");
  });

  it("marks unverified when a finding cited code but all of it was dropped", () => {
    // The model cited a file that was never retrieved → the gate dropped it and
    // left no surviving code citation → its code claim is unsupported.
    expect(
      verifyFinding({
        groundedCitations: [],
        droppedCitations: [{ filePath: "src/ghost.ts", reason: "file-not-retrieved" }],
      }),
    ).toBe("unverified");
  });

  it("marks unverified when an invented code-graph id was dropped", () => {
    expect(
      verifyFinding({
        groundedCitations: [doc] as Citation[],
        droppedCitations: [{ filePath: "code-graph:bogus", reason: "code-graph-id-unresolved" }],
      }),
    ).toBe("unverified");
  });

  it("returns null for a doc-only finding that made no code claim", () => {
    // Doc-only findings make no CODE-evidence claim; the #734 gate never
    // validates document citations, so we do not overstate them as confirmed.
    expect(
      verifyFinding({ groundedCitations: [doc] as Citation[], droppedCitations: [] }),
    ).toBeNull();
  });

  it("returns null for a finding with no citations at all", () => {
    expect(verifyFinding({ groundedCitations: [], droppedCitations: [] })).toBeNull();
  });

  it("is defensive against undefined inputs", () => {
    expect(
      verifyFinding({
        groundedCitations: undefined as unknown as Citation[],
        droppedCitations: undefined as unknown as DroppedCitation[],
      }),
    ).toBeNull();
  });
});

/**
 * Issue #773 — the hole this verifier had: an ABSENCE claim cites nothing, so it
 * dropped nothing, retained nothing, and classified `null` — sailing past the #740
 * gate and into the gap report as a CONFIRMED gap. The rule is closed HERE rather
 * than in a parallel mechanism.
 */
describe("#773 — absence claims the run's retrieval cannot back", () => {
  it("marks could-not-verify: an absence claim with no citations on a degraded run", () => {
    expect(
      verifyFinding({
        groundedCitations: [],
        droppedCitations: [],
        assertsAbsence: true,
        absenceConfirmable: false,
      }),
    ).toBe("could-not-verify");
  });

  it("leaves an absence claim alone when retrieval DID clear the evidence threshold", () => {
    // Anti-regression: a healthy run's honest gap keeps flowing through unflagged.
    expect(
      verifyFinding({
        groundedCitations: [],
        droppedCitations: [],
        assertsAbsence: true,
        absenceConfirmable: true,
      }),
    ).toBeNull();
  });

  it("an unbackable ABSENCE claim outranks its own citation (the badges must agree)", () => {
    // An absence claim CAN carry a surviving citation — the #729 passive fused-symbol
    // seed grounds citations even on a run where not one search succeeded. Ranking the
    // citation rule first made `verifyFinding` say `confirmed` while `gateFindingVerdict`
    // said `could-not-verify`, so the UI rendered a green "Confirmed" badge beside a
    // violet "Could not verify" one on the SAME finding. A citation proves the agent saw
    // SOME code; it never proves that the code it did not see is absent.
    expect(
      verifyFinding({
        groundedCitations: [code] as Citation[],
        droppedCitations: [],
        assertsAbsence: true,
        absenceConfirmable: false,
      }),
    ).toBe("could-not-verify");
  });

  it("still prefers `confirmed` for a POSITIVE claim that retained a real code citation", () => {
    expect(
      verifyFinding({
        groundedCitations: [code] as Citation[],
        droppedCitations: [],
        assertsAbsence: false,
        absenceConfirmable: false,
      }),
    ).toBe("confirmed");
  });

  it("is a no-op for pre-#773 callers that pass neither flag", () => {
    expect(verifyFinding({ groundedCitations: [], droppedCitations: [] })).toBeNull();
  });
});
