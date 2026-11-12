/**
 * #2348 — the pure parts of "My work": open-question counting, the state a
 * change request is listed under, and its interim title.
 */
import { describe, expect, it } from "vitest";
import {
  assignedReviewWhere,
  changeRequestTitle,
  countOpenQuestions,
  deriveChangeRequestState,
} from "./my-work-service.js";

const t = (iso: string) => new Date(iso);

function dialog(rounds: unknown[], completed = false): string {
  return JSON.stringify({ analysisId: "a", currentRound: rounds.length, rounds, completed });
}

describe("countOpenQuestions", () => {
  const questions = [{ id: "q1" }, { id: "q2" }, { id: "q3" }];

  it("counts the current round's questions without an answer", () => {
    const raw = dialog([{ round: 1, questions, answers: [{ questionId: "q2", answer: "Yes" }] }]);
    expect(countOpenQuestions(raw)).toBe(2);
  });

  it("does not count a blank answer as an answer", () => {
    const raw = dialog([{ round: 1, questions, answers: [{ questionId: "q1", answer: "  " }] }]);
    expect(countOpenQuestions(raw)).toBe(3);
  });

  it("reads only the latest round", () => {
    const raw = dialog([
      { round: 1, questions, answers: [] },
      { round: 2, questions: [{ id: "q9" }], answers: [{ questionId: "q9", answer: "done" }] },
    ]);
    expect(countOpenQuestions(raw)).toBe(0);
  });

  it("is 0 for a completed dialog even with unanswered questions", () => {
    expect(countOpenQuestions(dialog([{ round: 1, questions, answers: [] }], true))).toBe(0);
  });

  it("is 0 for no rounds, no questions, or unreadable state", () => {
    expect(countOpenQuestions(dialog([]))).toBe(0);
    expect(countOpenQuestions(dialog([{ round: 1 }]))).toBe(0);
    expect(countOpenQuestions("{not json")).toBe(0);
    expect(countOpenQuestions("null")).toBe(0);
  });
});

describe("deriveChangeRequestState", () => {
  const review = (status: string, updatedAt: string, decidedAt: string | null = null) => ({
    id: `rev-${status}-${updatedAt}`,
    status,
    updatedAt: t(updatedAt),
    decidedAt: decidedAt ? t(decidedAt) : null,
  });

  it("lists open questions as waiting on me, with the count, ahead of any review", () => {
    expect(
      deriveChangeRequestState({
        openQuestions: 2,
        questionsSince: t("2026-11-01T00:00:00Z"),
        reviews: [review("rejected", "2026-11-05T00:00:00Z")],
      }),
    ).toEqual({ state: "waiting_on_me", since: t("2026-11-01T00:00:00Z"), openQuestions: 2 });
  });

  it("maps the latest review: in review, rejected, approved -> ready to hand off", () => {
    const base = { openQuestions: 0, questionsSince: null };
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

  it("uses the most recently updated review, whatever the input order", () => {
    const d = deriveChangeRequestState({
      openQuestions: 0,
      questionsSince: null,
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
        openQuestions: 0,
        questionsSince: null,
        reviews: [
          review("rejected", "2026-11-01T00:00:00Z"),
          review("draft", "2026-11-02T00:00:00Z"),
        ],
      }),
    ).toBeNull();
  });

  it("lists nothing with no questions and no review", () => {
    expect(
      deriveChangeRequestState({ openQuestions: 0, questionsSince: null, reviews: [] }),
    ).toBeNull();
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

describe("assignedReviewWhere", () => {
  it("filters on the caller, a pending decision, an open review and the project scope", () => {
    const where = assignedReviewWhere({ userId: "u1", role: "developer", workspaces: ["ws"] });
    expect(where.reviewerId).toBe("u1");
    expect(where.decision).toBe("pending");
    expect(where.reviewRequest.status).toBe("in_review");
    expect(where.reviewRequest.project).toMatchObject({ deletedAt: null, OR: expect.any(Array) });
  });

  it("constrains an admin to live projects only", () => {
    const where = assignedReviewWhere({ userId: "a1", role: "admin" });
    expect(where.reviewRequest.project).toEqual({ deletedAt: null });
  });
});
