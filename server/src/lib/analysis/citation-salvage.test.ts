/**
 * Issue #1155 — the per-finding marker for citations the shared schema's
 * salvage dropped. Pure; no I/O.
 */
import { describe, expect, it } from "vitest";
import { agentOutputSchema } from "@metis/shared";
import {
  citationsDroppedFrom,
  citationsLostToSalvage,
  markCitationLosses,
  totalCitationsLost,
} from "./citation-salvage.js";

const good = { filePath: "src/a.ts", startLine: 1, endLine: 2 };
const malformed = { filePath: "src/a.ts", startLine: 0, endLine: 2 };
const finding = (citations: unknown) => ({
  category: "gap",
  severity: "low",
  title: "t",
  body: "b",
  citations,
});

describe("citationsDroppedFrom", () => {
  it("counts the citations the schema would drop from one raw finding", () => {
    expect(citationsDroppedFrom(finding([malformed, good, malformed]))).toBe(2);
    expect(citationsDroppedFrom(finding([good]))).toBe(0);
    expect(citationsDroppedFrom(finding(null))).toBe(0);
  });

  it("is total over any shape", () => {
    for (const v of [null, undefined, 3, "x", [], [finding([malformed])]]) {
      expect(citationsDroppedFrom(v)).toBe(0);
    }
  });
});

describe("markCitationLosses", () => {
  it("marks each parsed finding with what its raw counterpart lost", () => {
    const raw = {
      agentKey: "code",
      summary: "s",
      findings: [finding([malformed]), finding([good]), finding([malformed, malformed])],
    };
    const parsed = agentOutputSchema.parse(raw);
    markCitationLosses(parsed.findings, raw);
    expect(parsed.findings.map(citationsLostToSalvage)).toEqual([1, 0, 2]);
    expect(totalCitationsLost(parsed.findings)).toBe(3);
    // The marker rides a spread, as the orchestrator's finding maps do.
    expect(citationsLostToSalvage({ ...parsed.findings[0]! })).toBe(1);
  });

  it("cannot be set by the model: the schema strips the key", () => {
    const raw = {
      agentKey: "code",
      summary: "s",
      findings: [{ ...finding([good]), citationsLostToSalvage: 5 }],
    };
    const parsed = agentOutputSchema.parse(raw);
    expect(citationsLostToSalvage(parsed.findings[0]!)).toBe(0);
    markCitationLosses(parsed.findings, raw);
    expect(citationsLostToSalvage(parsed.findings[0]!)).toBe(0);
  });

  it("ignores a raw answer with no findings list", () => {
    const parsed = [{ citations: [] }];
    markCitationLosses(parsed, null);
    markCitationLosses(parsed, { findings: "nope" });
    expect(citationsLostToSalvage(parsed[0]!)).toBe(0);
  });
});
