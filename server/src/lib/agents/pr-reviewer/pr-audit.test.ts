/**
 * Epic #394 (#400) — pr-audit tests.
 *
 * The shared `audit-service` is mocked so we can introspect the queued
 * payload synchronously without spinning up Prisma.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const auditMock = vi.fn();
vi.mock("../../audit/audit-service.js", () => ({
  audit: (entry: unknown) => auditMock(entry),
}));

import { auditPrReviewed, auditPrReviewErrored, auditPrReviewSkipped } from "./pr-audit.js";

const COMMON = {
  prUrl: "https://github.com/acme/proj/pull/7",
  prNumber: 7,
  repoOwner: "acme",
  repoName: "proj",
  installationId: "inst-1",
  linkedIssueNumbers: [42, 43],
  actor: { type: "webhook" as const, id: null },
  projectId: "proj-1",
};

beforeEach(() => {
  auditMock.mockReset();
});

describe("auditPrReviewed", () => {
  it("emits a pr.reviewed entry with the canonical metadata shape", () => {
    auditPrReviewed({
      ...COMMON,
      verdict: "approve",
      acPassRate: 0.6666666,
      model: "claude-sonnet-4-5",
      inputTokens: 1234,
      outputTokens: 567,
      costUsd: 0.00123456,
      latencyMs: 4500,
      reviewId: 99,
      reviewUrl: "https://github.com/acme/proj/pull/7#review",
    });
    expect(auditMock).toHaveBeenCalledTimes(1);
    const arg = auditMock.mock.calls[0][0];
    expect(arg.action).toBe("pr.reviewed");
    expect(arg.target).toEqual({ type: "pull_request", id: "acme/proj#7" });
    expect(arg.metadata).toMatchObject({
      verdict: "approve",
      model: "claude-sonnet-4-5",
      inputTokens: 1234,
      outputTokens: 567,
      reviewId: 99,
      installationId: "inst-1",
      linkedIssueNumbers: [42, 43],
      projectId: "proj-1",
    });
    expect(arg.metadata.acPassRate).toBeCloseTo(0.6667, 4);
    expect(arg.metadata.costUsd).toBeCloseTo(0.001235, 6);
  });

  it("safely handles non-finite numbers", () => {
    auditPrReviewed({
      ...COMMON,
      verdict: "comment",
      acPassRate: Number.NaN,
      model: null,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: Number.POSITIVE_INFINITY,
      latencyMs: 0,
      reviewId: null,
      reviewUrl: null,
    });
    const arg = auditMock.mock.calls[0][0];
    expect(arg.metadata.acPassRate).toBe(0);
    expect(arg.metadata.costUsd).toBe(0);
  });
});

describe("auditPrReviewSkipped", () => {
  it.each([
    "no_linked_issue",
    "no_published_issue",
    "no_acceptance_criteria",
    "diff_too_large",
    "budget_exceeded",
  ] as const)("emits pr.review_skipped for reason %s", (reason) => {
    auditPrReviewSkipped({
      ...COMMON,
      reason,
      details: { rawBytes: 1234 },
    });
    const arg = auditMock.mock.calls[0][0];
    expect(arg.action).toBe("pr.review_skipped");
    expect(arg.metadata.reason).toBe(reason);
    expect(arg.metadata.details).toEqual({ rawBytes: 1234 });
  });
});

describe("auditPrReviewErrored", () => {
  it("emits pr.review_errored with errorMessage + verdict=errored marker", () => {
    auditPrReviewErrored({
      ...COMMON,
      errorMessage: "judge LLM timed out",
      latencyMs: 30_000,
      model: "claude-sonnet-4-5",
    });
    const arg = auditMock.mock.calls[0][0];
    expect(arg.action).toBe("pr.review_errored");
    expect(arg.metadata.verdict).toBe("errored");
    expect(arg.metadata.errorMessage).toBe("judge LLM timed out");
  });
});
