/**
 * #2348 — the pure parts of "My work": open-question counting, the state a
 * change request is listed under, its interim title, and the shared
 * "waiting on my decision" predicate.
 */
import { describe, expect, it } from "vitest";
import { awaitingDecisionWhere } from "../reviews/awaiting-decision.js";
import {
  changeRequestTitle,
  deriveChangeRequestState,
  runOpenQuestions,
  SETTLED_STATE_MAX_AGE_DAYS,
} from "./my-work-service.js";

const t = (iso: string) => new Date(iso);
const NOW = t("2026-11-11T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

describe("runOpenQuestions", () => {
  const meta = (extra: Record<string, unknown>) =>
    JSON.stringify({ enhancement: { enableClarification: true }, ...extra });

  it("is the Questions tab's count: the run's remaining ambiguities", () => {
    expect(runOpenQuestions(meta({ structuredRequirements: { totalAmbiguities: 12 } }))).toBe(12);
  });

  it("is 0 without clarification, after a failed extraction, or for unreadable metadata", () => {
    expect(
      runOpenQuestions(JSON.stringify({ structuredRequirements: { totalAmbiguities: 3 } })),
    ).toBe(0);
    expect(
      runOpenQuestions(
        meta({
          structuredExtractionFailure: { reason: "unparseable" },
          structuredRequirements: { totalAmbiguities: 3 },
        }),
      ),
    ).toBe(0);
    expect(runOpenQuestions("{broken")).toBe(0);
    expect(runOpenQuestions(null)).toBe(0);
  });
});

describe("deriveChangeRequestState", () => {
  const review = (status: string, updatedAt: string, decidedAt: string | null = null) => ({
    id: `rev-${status}-${updatedAt}`,
    status,
    updatedAt: t(updatedAt),
    decidedAt: decidedAt ? t(decidedAt) : null,
  });
  const base = { openQuestions: 0, questionsSince: null, now: NOW };

  it("lists open questions as waiting on me, with the count, ahead of any review", () => {
    expect(
      deriveChangeRequestState({
        openQuestions: 2,
        questionsSince: t("2026-11-01T00:00:00Z"),
        reviews: [review("rejected", "2026-11-05T00:00:00Z")],
        now: NOW,
      }),
    ).toEqual({ state: "waiting_on_me", since: t("2026-11-01T00:00:00Z"), openQuestions: 2 });
  });

  it("maps the latest review: in review, rejected, approved -> ready to hand off", () => {
    expect(
      deriveChangeRequestState({ ...base, reviews: [review("in_review", "2026-11-02T00:00:00Z")] }),
    ).toMatchObject({ state: "in_review", since: t("2026-11-02T00:00:00Z") });
    expect(
      deriveChangeRequestState({
        ...base,
        reviews: [review("rejected", "2026-11-03T00:00:00Z", "2026-11-02T12:00:00Z")],
      }),
    ).toMatchObject({ state: "rejected", since: t("2026-11-02T12:00:00Z") });
    expect(
      deriveChangeRequestState({
        ...base,
        reviews: [review("approved", "2026-11-04T00:00:00Z", "2026-11-04T00:00:00Z")],
      }),
    ).toMatchObject({ state: "ready_to_hand_off", reviewId: "rev-approved-2026-11-04T00:00:00Z" });
  });

  it("dates in review from the submit, not from a later edit of the review", () => {
    expect(
      deriveChangeRequestState({
        ...base,
        reviews: [
          {
            ...review("in_review", "2026-11-09T00:00:00Z"),
            submittedAt: t("2026-11-02T00:00:00Z"),
          },
        ],
      }),
    ).toMatchObject({ state: "in_review", since: t("2026-11-02T00:00:00Z") });
  });

  it("drops ready to hand off once a requirement is published", () => {
    expect(
      deriveChangeRequestState({
        ...base,
        handedOff: true,
        reviews: [review("approved", "2026-11-04T00:00:00Z", "2026-11-04T00:00:00Z")],
      }),
    ).toBeNull();
  });

  it(`drops rejected and ready ${SETTLED_STATE_MAX_AGE_DAYS} days after the verdict`, () => {
    const at = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
    const stale = at(SETTLED_STATE_MAX_AGE_DAYS + 1);
    const fresh = at(SETTLED_STATE_MAX_AGE_DAYS - 1);
    for (const status of ["rejected", "approved"]) {
      expect(
        deriveChangeRequestState({ ...base, reviews: [review(status, stale, stale)] }),
      ).toBeNull();
      expect(
        deriveChangeRequestState({ ...base, reviews: [review(status, fresh, fresh)] }),
      ).not.toBeNull();
    }
    // In review is still waiting on someone: never aged out.
    expect(
      deriveChangeRequestState({ ...base, reviews: [review("in_review", stale)] }),
    ).toMatchObject({ state: "in_review" });
  });

  it("uses the most recently updated review, whatever the input order", () => {
    const d = deriveChangeRequestState({
      ...base,
      reviews: [
        review("approved", "2026-11-01T00:00:00Z"),
        review("rejected", "2026-11-09T00:00:00Z"),
      ],
    });
    expect(d?.state).toBe("rejected");
  });

  it("lists nothing while the latest review is being revised (draft)", () => {
    expect(
      deriveChangeRequestState({
        ...base,
        reviews: [
          review("rejected", "2026-11-01T00:00:00Z"),
          review("draft", "2026-11-02T00:00:00Z"),
        ],
      }),
    ).toBeNull();
  });

  it("lists nothing with no questions and no review", () => {
    expect(deriveChangeRequestState({ ...base, reviews: [] })).toBeNull();
  });
});

describe("changeRequestTitle", () => {
  const created = t("2026-10-20T09:00:00Z");
  const names = new Map([
    ["d1", "Payments BRD.docx"],
    ["d2", "Appendix.pdf"],
  ]);

  it("uses the source document's file name", () => {
    expect(changeRequestTitle(JSON.stringify({ documentIds: ["d1"] }), names, created)).toBe(
      "Payments BRD.docx",
    );
  });

  it("names how many more documents there are", () => {
    expect(changeRequestTitle(JSON.stringify({ documentIds: ["d1", "d2"] }), names, created)).toBe(
      "Payments BRD.docx and 1 more",
    );
  });

  it("falls back to the first imported item's title, then the start date", () => {
    expect(
      changeRequestTitle(
        JSON.stringify({
          documentIds: ["gone"],
          sourceRequirements: [{ title: " PAY-12 Refunds " }],
        }),
        names,
        created,
      ),
    ).toBe("PAY-12 Refunds");
    expect(changeRequestTitle(null, names, created)).toBe("Analysis of 2026-10-20");
    expect(changeRequestTitle("{broken", names, created)).toBe("Analysis of 2026-10-20");
  });
});

describe("awaitingDecisionWhere (shared with the review queue's decision=pending)", () => {
  it("filters on an in-review review, the caller's pending decision and the project scope", () => {
    const scope = { deletedAt: null, OR: [{ workspaceId: null }] };
    expect(awaitingDecisionWhere("u1", scope)).toEqual({
      status: "in_review",
      project: { deletedAt: null, OR: [{ workspaceId: null }] },
      assignments: { some: { reviewerId: "u1", decision: "pending" } },
    });
  });

  it("constrains an admin's empty scope to live projects", () => {
    expect(awaitingDecisionWhere("a1", {}).project).toEqual({ deletedAt: null });
  });
});
