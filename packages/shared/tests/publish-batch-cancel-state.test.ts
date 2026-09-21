/**
 * #1104 (F) — stranded-batch cancel eligibility.
 *
 * One verdict function, shared by the API guard and the UI button, so a
 * cancel is never *offered* for a batch the server would refuse — and, far
 * more importantly, never *granted* for a batch that may still be writing to
 * GitHub.
 */
import { describe, expect, it } from "vitest";
import { PUBLISH_BATCH_IN_FLIGHT_GRACE_MS, publishBatchCancelState } from "../src/publishing.js";

const NOW = Date.parse("2026-07-28T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("publishBatchCancelState", () => {
  it("allows cancelling a pending batch stranded well past the grace window", () => {
    // The reported fixture: cms3u7y09003g259kej42fn4q, pending since the
    // previous day with no completedAt.
    const state = publishBatchCancelState(
      { status: "pending", archived: false, startedAt: ago(13 * 60 * 60 * 1000) },
      NOW,
    );
    expect(state).toEqual({ cancellable: true, reason: "ok", waitMs: 0 });
  });

  it("allows cancelling a running batch once it is past the grace window", () => {
    const state = publishBatchCancelState(
      { status: "running", startedAt: ago(PUBLISH_BATCH_IN_FLIGHT_GRACE_MS + 1) },
      NOW,
    );
    expect(state.cancellable).toBe(true);
  });

  it("protects a batch that is plausibly still in flight", () => {
    const state = publishBatchCancelState({ status: "running", startedAt: ago(60 * 1000) }, NOW);
    expect(state.cancellable).toBe(false);
    expect(state.reason).toBe("in_flight");
    expect(state.waitMs).toBe(PUBLISH_BATCH_IN_FLIGHT_GRACE_MS - 60 * 1000);
  });

  it("treats the boundary itself as still in flight", () => {
    const state = publishBatchCancelState(
      { status: "pending", startedAt: ago(PUBLISH_BATCH_IN_FLIGHT_GRACE_MS) },
      NOW,
    );
    expect(state.cancellable).toBe(true);
    expect(
      publishBatchCancelState(
        { status: "pending", startedAt: ago(PUBLISH_BATCH_IN_FLIGHT_GRACE_MS - 1) },
        NOW,
      ).cancellable,
    ).toBe(false);
  });

  it.each(["completed", "failed", "cancelled"])(
    "refuses to cancel a settled batch (%s)",
    (status) => {
      const state = publishBatchCancelState({ status, startedAt: ago(86_400_000) }, NOW);
      expect(state).toEqual({ cancellable: false, reason: "not_in_progress", waitMs: 0 });
    },
  );

  it("refuses to cancel an archived batch even while pending", () => {
    const state = publishBatchCancelState(
      { status: "pending", archived: true, startedAt: ago(86_400_000) },
      NOW,
    );
    expect(state.reason).toBe("not_in_progress");
  });

  it("fails closed when startedAt cannot be read", () => {
    const state = publishBatchCancelState({ status: "pending", startedAt: "not-a-date" }, NOW);
    expect(state.cancellable).toBe(false);
    expect(state.reason).toBe("in_flight");
  });

  it("accepts a Date as well as an ISO string", () => {
    const state = publishBatchCancelState(
      { status: "pending", startedAt: new Date(NOW - 86_400_000) },
      NOW,
    );
    expect(state.cancellable).toBe(true);
  });
});
