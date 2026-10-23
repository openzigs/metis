/**
 * #780 — the pure rules for a withheld re-synthesis: reading what was stored,
 * pairing proposed rows with current ones, and what applying does to each.
 */
import { describe, expect, it } from "vitest";
import {
  WITHHELD_PROPOSAL_KEY,
  diffWithheldReplacement,
  fieldChanges,
  matchWithheldProposal,
  normalizeTitle,
  planWithheldApply,
  readWithheldProposal,
  readWithheldRecord,
  type CurrentRequirementRow,
  type WithheldProposalRow,
} from "./withheld-replacement.js";

const proposed = (
  title: string,
  extra: Partial<WithheldProposalRow> = {},
): WithheldProposalRow => ({
  type: "feature",
  title,
  body: `${title} body`,
  priority: "medium",
  labels: "[]",
  acceptanceCriteria: "[]",
  storyPoints: null,
  coverage: null,
  verdict: null,
  sourceCandidateIds: null,
  ...extra,
});

const current = (
  id: string,
  title: string,
  extra: Partial<CurrentRequirementRow> = {},
): CurrentRequirementRow => ({
  id,
  type: "feature",
  title,
  body: `${title} body`,
  priority: "medium",
  acceptanceCriteria: "[]",
  reviewStatus: null,
  reviewed: false,
  deleted: false,
  promotedStructuredId: null,
  promotedStructuredRunId: null,
  ...extra,
});

const WITHHELD = {
  reason: "reviewed-work" as const,
  existingCount: 1,
  reviewedCount: 1,
  proposedCount: 1,
  at: "2026-10-23T00:00:00.000Z",
};

describe("readWithheldProposal / readWithheldRecord (#780)", () => {
  it("reads a stored proposal and its optional fields", () => {
    const p = readWithheldProposal({
      [WITHHELD_PROPOSAL_KEY]: {
        at: "t",
        rows: [
          {
            ...proposed("A"),
            storyPoints: 3,
            coverage: "grounded_in_code",
            promotedStructuredId: "REQ-1",
            promotedStructuredRunId: "run",
            promotedSynthesisKeys: "[]",
          },
          { ...proposed("B"), promotedStructuredId: "REQ-2", promotedStructuredRunId: 7 },
        ],
        degraded: { reason: "non-json" },
        reviewStatus: "approved",
      },
    });
    expect(p).toMatchObject({
      at: "t",
      reviewStatus: "approved",
      degraded: { reason: "non-json" },
    });
    expect(p!.rows[0]).toMatchObject({
      storyPoints: 3,
      coverage: "grounded_in_code",
      promotedStructuredId: "REQ-1",
      promotedStructuredRunId: "run",
      promotedSynthesisKeys: "[]",
    });
    expect(p!.rows[1]!.promotedStructuredRunId).toBeNull();
    expect(p!.rows[1]).not.toHaveProperty("promotedSynthesisKeys");
  });

  it("returns null for anything malformed rather than applying part of it", () => {
    expect(readWithheldProposal({})).toBeNull();
    expect(readWithheldProposal({ [WITHHELD_PROPOSAL_KEY]: "x" })).toBeNull();
    expect(readWithheldProposal({ [WITHHELD_PROPOSAL_KEY]: { at: 1, rows: [] } })).toBeNull();
    expect(
      readWithheldProposal({ [WITHHELD_PROPOSAL_KEY]: { at: "t", rows: [proposed("A"), null] } }),
    ).toBeNull();
    expect(
      readWithheldProposal({
        [WITHHELD_PROPOSAL_KEY]: { at: "t", rows: [{ ...proposed("A"), title: 5 }] },
      }),
    ).toBeNull();
    const ok = readWithheldProposal({ [WITHHELD_PROPOSAL_KEY]: { at: "t", rows: [] } });
    expect(ok).toEqual({ at: "t", rows: [], degraded: null });
  });

  it("reads only a well-formed refusal", () => {
    expect(readWithheldRecord({ requirementReplacementWithheld: WITHHELD })).toEqual(WITHHELD);
    expect(readWithheldRecord({})).toBeNull();
    expect(
      readWithheldRecord({ requirementReplacementWithheld: { ...WITHHELD, reason: "other" } }),
    ).toBeNull();
    expect(
      readWithheldRecord({ requirementReplacementWithheld: { reason: "reviewed-work" } }),
    ).toBeNull();
  });
});

describe("matchWithheldProposal (#780)", () => {
  it("normalizes case, punctuation and spacing in titles", () => {
    expect(normalizeTitle("  Users can   LOG-IN! ")).toBe("users can log in");
  });

  it("pairs by structured requirement first, then title, each row once, live before deleted", () => {
    const rows = [
      current("deleted-a", "A", { deleted: true }),
      current("live-a", "A"),
      current("s1", "Old wording", {
        promotedStructuredId: "REQ-1",
        promotedStructuredRunId: "run",
      }),
      current("other-run", "Old wording", {
        promotedStructuredId: "REQ-1",
        promotedStructuredRunId: "older",
      }),
    ];
    const m = matchWithheldProposal(rows, [
      proposed("New wording", { promotedStructuredId: "REQ-1", promotedStructuredRunId: "run" }),
      proposed("a"),
      proposed("A"),
      proposed("Unknown"),
    ]);
    expect(m.get(0)?.id).toBe("s1");
    expect(m.get(1)?.id).toBe("live-a");
    expect(m.get(2)?.id).toBe("deleted-a");
    expect(m.has(3)).toBe(false);
  });

  it("a structured id with no counterpart falls back to the title", () => {
    const m = matchWithheldProposal(
      [current("x", "Same title")],
      [proposed("Same title", { promotedStructuredId: "REQ-9" })],
    );
    expect(m.get(0)?.id).toBe("x");
  });
});

describe("fieldChanges (#780)", () => {
  it("lists every changed field, criteria compared as a set", () => {
    const changes = fieldChanges(
      current("x", "T", { acceptanceCriteria: JSON.stringify(["One (a.go:1)", "Two"]) }),
      proposed("T2", {
        body: "new body",
        priority: "high",
        type: "bug",
        acceptanceCriteria: JSON.stringify(["two", "Three"]),
      }),
    );
    expect(changes.map((c) => c.field)).toEqual([
      "title",
      "description",
      "priority",
      "type",
      "acceptanceCriteria",
    ]);
    // Reordered and re-cited criteria are the same set.
    expect(
      fieldChanges(
        current("x", "T", { acceptanceCriteria: JSON.stringify(["One (a.go:1)", "Two"]) }),
        proposed("T", { acceptanceCriteria: JSON.stringify(["two", "One (b.go:9)"]) }),
      ),
    ).toEqual([]);
  });
});

describe("planWithheldApply / diffWithheldReplacement (#780)", () => {
  const rows = [
    current("plain", "Plain"),
    current("reworded", "Reworded"),
    current("gone", "Gone"),
    current("reviewed", "Reviewed", { reviewed: true, reviewStatus: "approved" }),
    current("kept", "Kept", { reviewed: true, reviewStatus: "deferred" }),
    current("deleted", "Deleted", { reviewed: true, deleted: true }),
  ];
  const next = [
    proposed("Plain"),
    proposed("Reworded", { body: "new" }),
    proposed("Reviewed", { priority: "high" }),
    proposed("Deleted"),
    proposed("Brand new"),
  ];

  it("plans: unreviewed replaced or deleted, reviewed updated or kept, deleted left alone", () => {
    const steps = planWithheldApply(rows, next).map((s) => {
      const id = "current" in s ? s.current.id : s.proposed.title;
      return s.kind === "replace" ? `${s.kind}:${id}:${s.changed}` : `${s.kind}:${id}`;
    });
    expect(steps.sort()).toEqual(
      [
        "delete:gone",
        "insert:Brand new",
        "keep:kept",
        "replace:plain:false",
        "replace:reworded:true",
        "update:reviewed",
      ].sort(),
    );
  });

  it("describes the same outcomes for the analyst", () => {
    const diff = diffWithheldReplacement(WITHHELD, rows, next);
    expect(diff.added.map((e) => e.title)).toEqual(["Brand new"]);
    expect(diff.changed.map((e) => [e.title, e.outcome, e.reviewed])).toEqual([
      ["Reworded", "replace", false],
      ["Reviewed", "update", true],
    ]);
    expect(diff.removed.map((e) => [e.title, e.outcome])).toEqual([
      ["Gone", "delete"],
      ["Kept", "keep"],
    ]);
    expect(diff.skipped.map((e) => e.title)).toEqual(["Deleted"]);
    expect(diff.unchangedCount).toBe(1);
  });
});
