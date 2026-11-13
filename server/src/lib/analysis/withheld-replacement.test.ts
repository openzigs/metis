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
  fingerprintWithheldPlan,
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
  version: 0,
  type: "feature",
  title,
  body: `${title} body`,
  priority: "medium",
  acceptanceCriteria: "[]",
  kind: null,
  nfrCategory: null,
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
    // Unknown health stays unknown; a known-healthy one reads null.
    expect(ok).toEqual({ at: "t", rows: [] });
    expect(
      readWithheldProposal({ [WITHHELD_PROPOSAL_KEY]: { at: "t", rows: [], degraded: null } }),
    ).toEqual({ at: "t", rows: [], degraded: null });
  });

  // #1588 — a checkpoint promotion by someone without `project.update` is
  // withheld as drafts; applying it later must not lose (or upgrade) that.
  it("keeps a draft promotion's status, and drops any status it does not know", () => {
    const read = (reviewStatus: unknown) =>
      readWithheldProposal({ [WITHHELD_PROPOSAL_KEY]: { at: "t", rows: [], reviewStatus } });
    expect(read("draft")).toEqual({ at: "t", rows: [], reviewStatus: "draft" });
    expect(read("approved")).toEqual({ at: "t", rows: [], reviewStatus: "approved" });
    expect(read("rejected")).toEqual({ at: "t", rows: [] });
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

// #1636 — applying writes the proposal's kind, so the comparison must show a
// reclassification; it showed `changed: false` and an empty diff.
describe("fieldChanges — kind (#1636)", () => {
  it("shows a proposal that only reclassifies the requirement", () => {
    expect(
      fieldChanges(
        current("x", "T", { kind: "functional" }),
        proposed("T", { kind: "non-functional", nfrCategory: "performance" }),
      ),
    ).toEqual([
      { field: "kind", before: "functional", after: "non-functional" },
      { field: "nfrCategory", before: "", after: "performance" },
    ]);
    expect(
      fieldChanges(
        current("x", "T", { kind: "non-functional", nfrCategory: "security" }),
        proposed("T", { kind: "non-functional", nfrCategory: "performance" }),
      ),
    ).toEqual([{ field: "nfrCategory", before: "security", after: "performance" }]);
  });

  it("an unchanged kind is no change", () => {
    expect(
      fieldChanges(
        current("x", "T", { kind: "non-functional", nfrCategory: "security" }),
        proposed("T", { kind: "non-functional", nfrCategory: "security" }),
      ),
    ).toEqual([]);
  });

  it("a proposal with no kind leaves the current kind in place", () => {
    for (const kind of [undefined, null]) {
      expect(
        fieldChanges(current("x", "T", { kind: "functional" }), proposed("T", { kind })),
      ).toEqual([]);
    }
  });

  it("an unreviewed row whose proposal only reclassifies is planned as changed", () => {
    const [step] = planWithheldApply(
      [current("x", "T", { kind: "functional" })],
      [proposed("T", { kind: "non-functional" })],
    );
    expect(step).toMatchObject({ kind: "replace", changed: true });
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
    expect(diff.fingerprint).toBe(fingerprintWithheldPlan(planWithheldApply(rows, next)));
  });

  it("keeps an unreviewed elicited NFR the proposal leaves out, and replaces one it restates (#1648)", () => {
    const withNfrs = [
      current("nfr", "Encrypt tokens", { elicitedNfr: true }),
      current("nfr-restated", "Fast API", { elicitedNfr: true }),
      current("gone", "Gone"),
    ];
    const proposal = [proposed("Fast API")];
    const steps = planWithheldApply(withNfrs, proposal).map(
      (s) => `${s.kind}:${"current" in s ? s.current.id : s.proposed.title}`,
    );
    expect(steps.sort()).toEqual(["delete:gone", "keep:nfr", "replace:nfr-restated"]);
    const diff = diffWithheldReplacement(WITHHELD, withNfrs, proposal);
    expect(diff.removed.map((e) => [e.title, e.outcome, e.reviewed])).toEqual([
      ["Encrypt tokens", "keep", false],
      ["Gone", "delete", false],
    ]);
  });

  // #1709 — the elicited NFR draft, as `elicitedNfrRequirements` writes it.
  const tokensNfr = (extra: Partial<CurrentRequirementRow> = {}) =>
    current("nfr", "Encrypt API tokens at rest", {
      elicitedNfr: true,
      kind: "non-functional",
      nfrCategory: "security",
      body: "API tokens are encrypted at rest.\n\nTarget: AES-256",
      ...extra,
    });
  // A synthesis row saying the same thing in other words.
  const reworded = proposed("Token storage", {
    kind: "non-functional",
    nfrCategory: "security",
    body: "Stored API tokens use AES-256 encryption.",
  });

  it("deletes an unreviewed elicited NFR a proposed row restates in other words (#1709)", () => {
    const rows = [tokensNfr()];
    expect(planWithheldApply(rows, [reworded]).map((s) => s.kind)).toEqual(["delete", "insert"]);
    expect(diffWithheldReplacement(WITHHELD, rows, [reworded]).removed).toEqual([
      {
        title: "Encrypt API tokens at rest",
        outcome: "delete",
        reviewed: false,
        reviewStatus: null,
        changes: [],
      },
    ]);
  });

  it("keeps an elicited NFR the proposal does not restate, and says why (#1709)", () => {
    const otherTarget = proposed("Token storage", {
      kind: "non-functional",
      nfrCategory: "security",
      body: "Stored API tokens use RSA-2048 encryption.",
    });
    const rows = [tokensNfr(), current("approved", "Approved", { reviewed: true })];
    expect(planWithheldApply(rows, [otherTarget]).map((s) => s.kind)).toEqual([
      "keep",
      "keep",
      "insert",
    ]);
    const removed = diffWithheldReplacement(WITHHELD, rows, [otherTarget]).removed;
    expect(removed.map((e) => [e.title, e.outcome, e.keepReason])).toEqual([
      ["Encrypt API tokens at rest", "keep", "elicited-nfr"],
      ["Approved", "keep", "reviewed"],
    ]);
  });

  it("keeps a reviewed elicited NFR the proposal restates, as review work (#1709)", () => {
    const rows = [tokensNfr({ reviewed: true, reviewStatus: "approved" })];
    expect(planWithheldApply(rows, [reworded]).map((s) => s.kind)).toEqual(["keep", "insert"]);
    expect(diffWithheldReplacement(WITHHELD, rows, [reworded]).removed[0]!.keepReason).toBe(
      "reviewed",
    );
  });

  it("keeps an elicited NFR whose only restatement is a deleted requirement's, which applying does not write (#1709)", () => {
    const rows = [tokensNfr(), current("del", "Token storage", { deleted: true })];
    expect(planWithheldApply(rows, [reworded]).map((s) => s.kind)).toEqual(["keep"]);
  });

  it("keeps an elicited NFR whose title only swaps a proposed row's roles (#2449)", () => {
    const rows = [
      current("nfr", "Users cannot read admin passwords", {
        elicitedNfr: true,
        kind: "non-functional",
        nfrCategory: "security",
        body: "No user can read an admin's password.",
      }),
    ];
    const swapped = proposed("Admins cannot read user passwords", { kind: "functional" });
    expect(planWithheldApply(rows, [swapped]).map((s) => s.kind)).toEqual(["keep", "insert"]);
    expect(diffWithheldReplacement(WITHHELD, rows, [swapped]).removed[0]!.keepReason).toBe(
      "elicited-nfr",
    );
  });

  it("keeps an elicited NFR with no category, which nothing but its title can restate (#1709)", () => {
    const rows = [tokensNfr({ nfrCategory: null })];
    expect(planWithheldApply(rows, [reworded]).map((s) => s.kind)).toEqual(["keep", "insert"]);
  });
});

describe("fingerprintWithheldPlan (#780)", () => {
  const rows = [
    current("a", "A", { reviewed: true, reviewStatus: "approved" }),
    current("b", "B"),
    current("c", "C"),
  ];
  const next = [proposed("A", { body: "new" }), proposed("B")];
  const fp = (r: CurrentRequirementRow[]) => fingerprintWithheldPlan(planWithheldApply(r, next));

  it("is stable for the same plan, whatever the row order", () => {
    expect(fp(rows)).toBe(fp([...rows].reverse()));
    expect(fp(rows)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("changes when a requirement's version, review state or changed fields change", () => {
    const base = fp(rows);
    expect(fp([{ ...rows[0]!, version: 1 }, rows[1]!, rows[2]!])).not.toBe(base);
    // A verdict change does not bump the version (#1162).
    expect(fp([{ ...rows[0]!, reviewStatus: "rejected" }, rows[1]!, rows[2]!])).not.toBe(base);
    expect(fp([rows[0]!, rows[1]!, { ...rows[2]!, reviewed: true }])).not.toBe(base);
    expect(fp([{ ...rows[0]!, body: "new" }, rows[1]!, rows[2]!])).not.toBe(base);
  });
});

describe("readWithheldProposal promotion and matches (#780)", () => {
  it("reads the promotion record and keeps only matching notes with an index", () => {
    const p = readWithheldProposal({
      [WITHHELD_PROPOSAL_KEY]: {
        at: "t",
        rows: [],
        promotion: { runId: "run-2", structuredIds: [] },
        matches: { ambiguous: [{ approvedIndex: 0, structuredId: "R" }, { bad: 1 }], shared: "x" },
      },
    });
    expect(p!.promotion).toEqual({ runId: "run-2", structuredIds: [] });
    expect(p!.matches!.ambiguous).toHaveLength(1);
    expect(p!.matches!.shared).toEqual([]);
    const none = readWithheldProposal({
      [WITHHELD_PROPOSAL_KEY]: {
        at: "t",
        rows: [],
        promotion: { runId: 5, structuredIds: [1] },
        matches: { ambiguous: [], shared: [] },
      },
    });
    expect(none).toEqual({ at: "t", rows: [] });
    expect(
      readWithheldProposal({
        [WITHHELD_PROPOSAL_KEY]: { at: "t", rows: [], promotion: { structuredIds: ["A"] } },
      })!.promotion,
    ).toEqual({ runId: null, structuredIds: ["A"] });
  });
});
