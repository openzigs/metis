/**
 * Issue #1568 — which reviewed requirements approving would promote with no
 * code link. The fixture is #706 run 10's import-scoped analysis, trimmed: the
 * ticked items' synthesis items cite code findings, and the items for the
 * requirements the analysis added cite none.
 */
import { describe, expect, it } from "vitest";
import type { SynthesizedRequirement } from "@metis/shared";
import { requirementsWithoutCodeEvidence } from "./code-evidence.js";

const req = (id: string, title: string) => ({ id, title });
const item = (
  title: string,
  structuredIds: string[],
  evidenceFindingIndexes: number[],
): SynthesizedRequirement => ({
  type: "feature",
  title,
  body: title,
  priority: "medium",
  labels: [],
  evidenceFindingIndexes,
  acceptanceCriteria: [],
  structuredIds,
});

const codeCitation = { filePath: "internal/storage/entry.go", startLine: 10, endLine: 20 };
const repoDocCitation = { filename: "connector:repo:r1:src/internal/api/entry.go" };
const manPage = { filename: "miniflux.1" };

const FINDINGS = [
  { citations: [codeCitation] }, // 0 — code
  { citations: [repoDocCitation] }, // 1 — a repository source document
  { citations: [manPage] }, // 2 — documentation only
  {}, // 3 — no citations recorded
];

const MARK_OLDER = req("REQ-1", "Mark all entries older than a threshold as read");
const READ_AT = req("REQ-2", "Track reading time with read_at timestamp");
const COUNTERS = req("REQ-3", "Per-feed read and unread counters");
const METRICS = req("REQ-4", "Metrics endpoint authentication");
const NO_ITEM = req("REQ-5", "Entry save endpoint");

const SYNTHESIS = [
  item("Mark entries older than a cutoff as read", ["REQ-1"], [2, 0]),
  item("Add a read_at timestamp", ["REQ-2"], [1]),
  // The run-10 shape: an added requirement whose item cites no finding.
  item("GET /v1/feeds/counters returns per-feed counts", ["REQ-3"], []),
  item("Metrics endpoint requires basic auth", ["REQ-4"], [2, 3, 99]),
];

describe("#1568 — requirements that would be promoted with no code link", () => {
  it("marks those whose item cites no finding that could be code, and no other", () => {
    const out = requirementsWithoutCodeEvidence({
      structured: [MARK_OLDER, READ_AT, COUNTERS, METRICS, NO_ITEM],
      synthesized: SYNTHESIS,
      findings: FINDINGS,
    });
    // REQ-1 cites code (among a man page); REQ-2 a repository source document.
    // REQ-3 cites nothing; REQ-4 only documentation, an empty finding and an
    // index past the list; REQ-5 has no item at all.
    expect([...out].sort()).toEqual(["REQ-3", "REQ-4", "REQ-5"]);
  });

  it("does not mark a rejected requirement: approving would not promote it", () => {
    const out = requirementsWithoutCodeEvidence({
      structured: [MARK_OLDER, COUNTERS],
      synthesized: SYNTHESIS,
      findings: FINDINGS,
      rejectedIds: new Set(["REQ-3"]),
    });
    expect([...out]).toEqual([]);
  });

  it("#2509 — marks one whose only code is cited by a finding that could not verify it", () => {
    const out = requirementsWithoutCodeEvidence({
      structured: [READ_AT],
      synthesized: SYNTHESIS,
      findings: [{}, { citations: [repoDocCitation], verdict: "could-not-verify" }],
    });
    expect([...out]).toEqual(["REQ-2"]);
  });

  it("#2509 — does not mark one whose code is cited by an implemented claim the gate downgraded", () => {
    const out = requirementsWithoutCodeEvidence({
      structured: [READ_AT],
      synthesized: SYNTHESIS,
      findings: [
        {},
        {
          citations: [repoDocCitation],
          verdict: "could-not-verify",
          downgradedFromImplemented: true,
        },
      ],
    });
    expect([...out]).toEqual([]);
  });

  it("marks every requirement when synthesis cited no finding at all", () => {
    const out = requirementsWithoutCodeEvidence({
      structured: [MARK_OLDER, READ_AT],
      synthesized: SYNTHESIS,
      findings: [],
    });
    expect([...out].sort()).toEqual(["REQ-1", "REQ-2"]);
  });
});

/**
 * Issue #2596 — an elicited NFR is never joined to a synthesis item (#2449):
 * promotion writes its evidence from the findings it cites by id. In the
 * 2026-11-16 walkthrough all 10 NFRs were marked "No code link" before
 * approval, and 8 of them were promoted with code links.
 */
describe("#2596 — an elicited NFR is judged on the findings it cites", () => {
  const nfr = (id: string, title: string, evidenceFindingIds: string[]) => ({
    id,
    title,
    elicitedNfr: { nfrCategory: "security" as const, evidenceFindingIds },
  });
  const WITH_IDS = [
    { findingId: "f-code", citations: [codeCitation] },
    { findingId: "f-man", citations: [manPage] },
    { findingId: "f-unverified", citations: [codeCitation], verdict: "could-not-verify" },
  ];

  it("does not mark one citing a finding that cites code", () => {
    const out = requirementsWithoutCodeEvidence({
      structured: [nfr("NFR-1", "Expired API keys refused identically", ["f-man", "f-code"])],
      synthesized: SYNTHESIS,
      findings: WITH_IDS,
    });
    expect([...out]).toEqual([]);
  });

  it("marks one citing only documentation, an unverified finding or an unknown id", () => {
    const out = requirementsWithoutCodeEvidence({
      structured: [
        nfr("NFR-2", "Docs only", ["f-man"]),
        nfr("NFR-3", "Unverified", ["f-unverified"]),
        nfr("NFR-4", "Gone", ["f-deleted"]),
        nfr("NFR-5", "Cites nothing", []),
      ],
      synthesized: SYNTHESIS,
      findings: WITH_IDS,
    });
    expect([...out].sort()).toEqual(["NFR-2", "NFR-3", "NFR-4", "NFR-5"]);
  });

  it("never reads a synthesis item an NFR's title happens to resemble", () => {
    // The item restates the NFR's title word for word and cites code; the NFR cites nothing.
    const out = requirementsWithoutCodeEvidence({
      structured: [nfr("NFR-6", "Mark all entries older than a threshold as read", [])],
      synthesized: [item("Mark all entries older than a threshold as read", ["NFR-6"], [0])],
      findings: WITH_IDS,
    });
    expect([...out]).toEqual(["NFR-6"]);
  });
});
