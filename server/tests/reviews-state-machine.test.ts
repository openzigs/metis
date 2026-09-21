/**
 * Issue #616 (epic #609) — pure review-workflow state machine.
 *
 * Exhaustive coverage of the transition table (every legal AND illegal
 * (status, event) pair), both decision-aggregation policies (`all` /
 * `quorum(n)`), the Requirement.reviewStatus derivation rule, and baseline
 * version pinning.
 */
import { describe, expect, it } from "vitest";

import { AppError } from "../src/middleware/error-handler.js";
import {
  aggregateDecisions,
  assertValidPolicy,
  buildBaselinePins,
  canTransition,
  deriveRequirementReviewStatus,
  IllegalReviewTransitionError,
  InvalidBaselinePinError,
  InvalidReviewPolicyError,
  legalEvents,
  REVIEW_EVENTS,
  REVIEW_STATUSES,
  REVIEW_TRANSITIONS,
  transition,
  type ReviewEvent,
  type ReviewRequestStatus,
} from "../src/lib/reviews/state-machine.js";

/** The complete set of legal transitions (the epic #609 state diagram). */
const LEGAL: Array<[ReviewRequestStatus, ReviewEvent, ReviewRequestStatus]> = [
  ["draft", "submit", "in_review"],
  ["draft", "close", "closed"],
  ["in_review", "approve", "approved"],
  ["in_review", "reject", "rejected"],
  ["in_review", "withdraw", "draft"],
  ["in_review", "close", "closed"],
  ["approved", "reopen", "in_review"],
  ["approved", "close", "closed"],
  ["rejected", "revise", "draft"],
  ["rejected", "close", "closed"],
];

describe("review state machine — transition table", () => {
  it.each(LEGAL)("%s --%s--> %s is legal", (from, event, to) => {
    expect(canTransition(from, event)).toBe(true);
    expect(transition(from, event)).toBe(to);
  });

  it("throws a typed 409 error on every illegal (status, event) pair", () => {
    const legalKeys = new Set(LEGAL.map(([from, event]) => `${from}:${event}`));
    let illegalCount = 0;
    for (const from of REVIEW_STATUSES) {
      for (const event of REVIEW_EVENTS) {
        if (legalKeys.has(`${from}:${event}`)) continue;
        illegalCount += 1;
        expect(canTransition(from, event)).toBe(false);
        let caught: unknown;
        try {
          transition(from, event);
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(IllegalReviewTransitionError);
        expect(caught).toBeInstanceOf(AppError);
        const appErr = caught as IllegalReviewTransitionError;
        expect(appErr.statusCode).toBe(409);
        expect(appErr.code).toBe("ILLEGAL_REVIEW_TRANSITION");
        expect(appErr.details).toEqual({ from, event });
      }
    }
    // 5 statuses x 7 events = 35 pairs, 10 legal → 25 illegal.
    expect(illegalCount).toBe(35 - LEGAL.length);
  });

  it("closed is terminal — no legal events", () => {
    expect(legalEvents("closed")).toEqual([]);
  });

  it("legalEvents lists exactly the legal events per status", () => {
    expect(legalEvents("draft").sort()).toEqual(["close", "submit"]);
    expect(legalEvents("in_review").sort()).toEqual(["approve", "close", "reject", "withdraw"]);
    expect(legalEvents("approved").sort()).toEqual(["close", "reopen"]);
    expect(legalEvents("rejected").sort()).toEqual(["close", "revise"]);
  });

  it("the exported transition table covers every status exactly once", () => {
    expect(Object.keys(REVIEW_TRANSITIONS).sort()).toEqual([...REVIEW_STATUSES].sort());
  });
});

describe("decision aggregation — `all` policy", () => {
  it("is pending while any reviewer is pending", () => {
    expect(aggregateDecisions(["approved", "pending"], "all")).toBe("pending");
  });

  it("approves once every reviewer approves", () => {
    expect(aggregateDecisions(["approved", "approved", "approved"], "all")).toBe("approved");
  });

  it("rejects as soon as any reviewer rejects", () => {
    expect(aggregateDecisions(["approved", "rejected", "pending"], "all")).toBe("rejected");
    expect(aggregateDecisions(["rejected"], "all")).toBe("rejected");
  });

  it("a single approving reviewer approves", () => {
    expect(aggregateDecisions(["approved"], "all")).toBe("approved");
  });
});

describe("decision aggregation — `quorum(n)` policy", () => {
  it("approves once n approvals arrive (remaining pending are moot)", () => {
    expect(aggregateDecisions(["approved", "approved", "pending"], "quorum", 2)).toBe("approved");
  });

  it("is pending below the quorum", () => {
    expect(aggregateDecisions(["approved", "pending", "pending"], "quorum", 2)).toBe("pending");
  });

  it("a rejection does NOT reject while the quorum is still reachable", () => {
    expect(aggregateDecisions(["rejected", "approved", "pending"], "quorum", 2)).toBe("pending");
  });

  it("rejects once the quorum becomes unreachable", () => {
    expect(aggregateDecisions(["rejected", "rejected", "approved"], "quorum", 2)).toBe("rejected");
    expect(aggregateDecisions(["rejected", "pending", "pending"], "quorum", 3)).toBe("rejected");
  });

  it("quorum equal to the reviewer count behaves like `all`", () => {
    expect(aggregateDecisions(["approved", "approved"], "quorum", 2)).toBe("approved");
    expect(aggregateDecisions(["rejected", "approved"], "quorum", 2)).toBe("rejected");
  });
});

describe("decision aggregation — policy validation", () => {
  it("rejects an empty reviewer set", () => {
    expect(() => aggregateDecisions([], "all")).toThrow(InvalidReviewPolicyError);
  });

  it("rejects a quorum policy without a quorum value", () => {
    expect(() => aggregateDecisions(["approved"], "quorum")).toThrow(InvalidReviewPolicyError);
    expect(() => assertValidPolicy("quorum", null, 3)).toThrow(InvalidReviewPolicyError);
  });

  it("rejects a non-positive, non-integer, or unreachable quorum", () => {
    expect(() => assertValidPolicy("quorum", 0, 3)).toThrow(InvalidReviewPolicyError);
    expect(() => assertValidPolicy("quorum", 1.5, 3)).toThrow(InvalidReviewPolicyError);
    expect(() => assertValidPolicy("quorum", 4, 3)).toThrow(InvalidReviewPolicyError);
  });

  it("rejects a quorum value on the `all` policy", () => {
    expect(() => assertValidPolicy("all", 2, 3)).toThrow(InvalidReviewPolicyError);
  });

  it("rejects an unknown policy", () => {
    expect(() => assertValidPolicy("majority" as never, null, 3)).toThrow(InvalidReviewPolicyError);
  });

  it("accepts valid configurations", () => {
    expect(() => assertValidPolicy("all", null, 1)).not.toThrow();
    expect(() => assertValidPolicy("all", undefined, 5)).not.toThrow();
    expect(() => assertValidPolicy("quorum", 2, 3)).not.toThrow();
  });

  it("policy errors are 400 AppErrors with a machine-readable code", () => {
    let caught: unknown;
    try {
      assertValidPolicy("quorum", 9, 3);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InvalidReviewPolicyError);
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as InvalidReviewPolicyError).statusCode).toBe(400);
    expect((caught as InvalidReviewPolicyError).code).toBe("INVALID_REVIEW_POLICY");
  });
});

describe("Requirement.reviewStatus derivation", () => {
  it("draft and in_review derive `draft`", () => {
    expect(deriveRequirementReviewStatus("draft")).toBe("draft");
    expect(deriveRequirementReviewStatus("in_review")).toBe("draft");
  });

  it("approved derives `approved`, rejected derives `rejected`", () => {
    expect(deriveRequirementReviewStatus("approved")).toBe("approved");
    expect(deriveRequirementReviewStatus("rejected")).toBe("rejected");
  });

  it("closed derives null — leave the requirement's reviewStatus untouched", () => {
    expect(deriveRequirementReviewStatus("closed")).toBeNull();
  });
});

describe("baseline version pinning", () => {
  it("pins every requirement-scoped item at its pinned version", () => {
    const pins = buildBaselinePins([
      { requirementId: "req-1", generatedDocumentId: null, pinnedVersion: 3 },
      { requirementId: "req-2", generatedDocumentId: null, pinnedVersion: 0 },
    ]);
    expect(pins).toEqual([
      { requirementId: "req-1", version: 3 },
      { requirementId: "req-2", version: 0 },
    ]);
  });

  it("skips spec-document items — BaselineItem pins requirements only", () => {
    const pins = buildBaselinePins([
      { requirementId: "req-1", generatedDocumentId: null, pinnedVersion: 2 },
      { requirementId: null, generatedDocumentId: "doc-1", pinnedVersion: 5 },
    ]);
    expect(pins).toEqual([{ requirementId: "req-1", version: 2 }]);
  });

  it("dedupes an identical (requirementId, version) pin", () => {
    const pins = buildBaselinePins([
      { requirementId: "req-1", generatedDocumentId: null, pinnedVersion: 2 },
      { requirementId: "req-1", generatedDocumentId: null, pinnedVersion: 2 },
    ]);
    expect(pins).toEqual([{ requirementId: "req-1", version: 2 }]);
  });

  it("throws on conflicting versions for the same requirement", () => {
    expect(() =>
      buildBaselinePins([
        { requirementId: "req-1", generatedDocumentId: null, pinnedVersion: 2 },
        { requirementId: "req-1", generatedDocumentId: null, pinnedVersion: 3 },
      ]),
    ).toThrow(InvalidBaselinePinError);
  });

  it("throws when an item names both a requirement and a document", () => {
    expect(() =>
      buildBaselinePins([
        { requirementId: "req-1", generatedDocumentId: "doc-1", pinnedVersion: 1 },
      ]),
    ).toThrow(InvalidBaselinePinError);
  });

  it("throws when an item names neither artifact", () => {
    expect(() =>
      buildBaselinePins([{ requirementId: null, generatedDocumentId: null, pinnedVersion: 1 }]),
    ).toThrow(InvalidBaselinePinError);
  });

  it("throws on a negative or non-integer pinned version", () => {
    expect(() =>
      buildBaselinePins([{ requirementId: "req-1", generatedDocumentId: null, pinnedVersion: -1 }]),
    ).toThrow(InvalidBaselinePinError);
    expect(() =>
      buildBaselinePins([
        { requirementId: "req-1", generatedDocumentId: null, pinnedVersion: 1.5 },
      ]),
    ).toThrow(InvalidBaselinePinError);
  });

  it("pin errors are 400 AppErrors with a machine-readable code", () => {
    let caught: unknown;
    try {
      buildBaselinePins([{ requirementId: null, generatedDocumentId: null, pinnedVersion: 1 }]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InvalidBaselinePinError);
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as InvalidBaselinePinError).statusCode).toBe(400);
    expect((caught as InvalidBaselinePinError).code).toBe("INVALID_BASELINE_PIN");
  });
});
