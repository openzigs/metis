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

  it("marks every requirement when synthesis cited no finding at all", () => {
    const out = requirementsWithoutCodeEvidence({
      structured: [MARK_OLDER, READ_AT],
      synthesized: SYNTHESIS,
      findings: [],
    });
    expect([...out].sort()).toEqual(["REQ-1", "REQ-2"]);
  });
});
