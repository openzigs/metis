/**
 * Issue #1155 — the per-finding marker for citations the shared schema's
 * salvage dropped. Pure; no I/O.
 */
import { describe, expect, it } from "vitest";
import { agentOutputSchema, MAX_FINDING_CITATIONS } from "@metis/shared";
import {
  citationLossFrom,
  citationsLostToSalvage,
  codeCitationsLostToSalvage,
  markCitationLosses,
  totalCitationsLost,
} from "./citation-salvage.js";

const good = { filePath: "src/a.ts", startLine: 1, endLine: 2 };
const malformed = { filePath: "src/a.ts", startLine: 0, endLine: 2 };
const goodDoc = { documentId: "doc-1234567890", chunkIndex: 0 };
const malformedDoc = { documentId: "doc-1234567890", chunkIndex: -1 };
const finding = (citations: unknown) => ({
  category: "gap",
  severity: "low",
  title: "t",
  body: "b",
  citations,
});

describe("citationLossFrom", () => {
  it("counts malformed code citations as lost code evidence", () => {
    expect(citationLossFrom(finding([malformed, good, malformed]))).toEqual({
      dropped: 2,
      codeDropped: 2,
    });
    expect(citationLossFrom(finding([good]))).toEqual({ dropped: 0, codeDropped: 0 });
    expect(citationLossFrom(finding(null))).toEqual({ dropped: 0, codeDropped: 0 });
    // A lone malformed citation where the list belongs is a list of one.
    expect(citationLossFrom(finding(malformed))).toEqual({ dropped: 1, codeDropped: 1 });
  });

  it("counts a malformed citation of no recognisable kind as a lost code claim", () => {
    expect(citationLossFrom(finding([{ startLine: 0 }, "src/a.ts:12"]))).toEqual({
      dropped: 2,
      codeDropped: 2,
    });
  });

  // Adversarial review (over-blocking) — a lost DOCUMENT citation, or a valid
  // citation merely past the cap, is not lost code evidence.
  it("does not count a lost document citation as lost code evidence", () => {
    expect(citationLossFrom(finding([malformedDoc, goodDoc]))).toEqual({
      dropped: 1,
      codeDropped: 0,
    });
  });

  it("does not count valid citations past the cap as lost code evidence", () => {
    const many = Array.from({ length: MAX_FINDING_CITATIONS + 2 }, () => good);
    expect(citationLossFrom(finding(many))).toEqual({ dropped: 2, codeDropped: 0 });
  });

  it("is total over any shape", () => {
    for (const v of [null, undefined, 3, "x", [], [finding([malformed])]]) {
      expect(citationLossFrom(v)).toEqual({ dropped: 0, codeDropped: 0 });
    }
  });
});

describe("markCitationLosses", () => {
  it("marks each parsed finding with what its raw counterpart lost", () => {
    const raw = {
      agentKey: "code",
      summary: "s",
      findings: [
        finding([malformed]),
        finding([good]),
        finding([malformed, malformed]),
        finding([malformedDoc, goodDoc]),
      ],
    };
    const parsed = agentOutputSchema.parse(raw);
    markCitationLosses(parsed.findings, raw);
    expect(parsed.findings.map(citationsLostToSalvage)).toEqual([1, 0, 2, 1]);
    expect(parsed.findings.map(codeCitationsLostToSalvage)).toEqual([1, 0, 2, 0]);
    expect(totalCitationsLost(parsed.findings)).toBe(4);
    // The marker rides a spread, as the orchestrator's finding maps do.
    expect(codeCitationsLostToSalvage({ ...parsed.findings[0]! })).toBe(1);
  });

  it("cannot be set by the model: the schema strips the keys", () => {
    const raw = {
      agentKey: "code",
      summary: "s",
      findings: [{ ...finding([good]), citationsLostToSalvage: 5, codeCitationsLostToSalvage: 5 }],
    };
    const parsed = agentOutputSchema.parse(raw);
    expect(citationsLostToSalvage(parsed.findings[0]!)).toBe(0);
    markCitationLosses(parsed.findings, raw);
    expect(citationsLostToSalvage(parsed.findings[0]!)).toBe(0);
    expect(codeCitationsLostToSalvage(parsed.findings[0]!)).toBe(0);
  });

  it("ignores a raw answer with no findings list", () => {
    const parsed = [{ citations: [] }];
    markCitationLosses(parsed, null);
    markCitationLosses(parsed, { findings: "nope" });
    expect(citationsLostToSalvage(parsed[0]!)).toBe(0);
  });
});
