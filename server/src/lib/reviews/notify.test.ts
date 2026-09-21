/**
 * Epic #609 / Issue #621 — review lifecycle notification fan-out tests.
 *
 * Covers: reviewer fan-out on submit (self-skip, dedupe), requester
 * notifications on each decision + terminal approve/reject, deep-link hrefs,
 * per-user preference suppression via the REAL `shouldNotify`
 * (inApp × requirementsApproved, fail-open), socket-room delivery, and the
 * never-throws contract (a notification failure must never break a review
 * transition).
 *
 * Prisma and the socket registry are mocked so this runs hermetically.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---- Prisma double ----------------------------------------------------------
const notificationCreate = vi.fn();
const prefFindMany = vi.fn();
vi.mock("../prisma.js", () => ({
  prisma: {
    notification: { create: (...a: unknown[]) => notificationCreate(...a) },
    notificationPreference: { findMany: (...a: unknown[]) => prefFindMany(...a) },
  },
}));

// ---- Socket registry double -------------------------------------------------
const emit = vi.fn();
const to = vi.fn(() => ({ emit }));
let io: { to: typeof to } | null = { to };
vi.mock("../socket/registry.js", () => ({
  getSocketServer: () => io,
}));

// ---- Preference-helper seam ---------------------------------------------------
// Defaults to the REAL `shouldNotify` (so suppression/fail-open tests exercise
// the genuine #614 resolution against the mocked prisma); individual tests can
// force a rejection to cover the fan-out's own error paths.
const shouldNotifySpy = vi.fn();
vi.mock("../notifications/preferences.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../notifications/preferences.js")>();
  return {
    ...actual,
    shouldNotify: (...a: Parameters<typeof actual.shouldNotify>) => shouldNotifySpy(...a),
  };
});
const actualPrefs = await vi.importActual<typeof import("../notifications/preferences.js")>(
  "../notifications/preferences.js",
);

const {
  notifyReviewSubmitted,
  dispatchReviewSubmitted,
  notifyReviewDecision,
  dispatchReviewDecision,
  reviewHref,
} = await import("./notify.js");

function submittedInput(over: Partial<Parameters<typeof notifyReviewSubmitted>[0]> = {}) {
  return {
    reviewId: "rev-1",
    projectId: "proj-1",
    title: "Sprint 4 sign-off",
    actorId: "user-req",
    reviewerIds: ["rev-a", "rev-b"],
    ...over,
  };
}

function decisionInput(over: Partial<Parameters<typeof notifyReviewDecision>[0]> = {}) {
  return {
    reviewId: "rev-1",
    projectId: "proj-1",
    title: "Sprint 4 sign-off",
    requestedById: "user-req",
    reviewerId: "rev-a",
    reviewerName: "Alice Reviewer",
    decision: "approved" as const,
    outcome: null,
    baselineId: null,
    ...over,
  };
}

/** All persisted notification rows (the `data` payload of each create call). */
function createdRows(): Array<Record<string, unknown>> {
  return notificationCreate.mock.calls.map(([arg]) => (arg as { data: never }).data);
}

beforeEach(() => {
  vi.clearAllMocks();
  io = { to };
  to.mockImplementation(() => ({ emit }));
  notificationCreate.mockResolvedValue({ id: "n1" });
  // Default: no stored preference rows → inApp × requirementsApproved is ON.
  prefFindMany.mockResolvedValue([]);
  shouldNotifySpy.mockImplementation((...a) => actualPrefs.shouldNotify(...a));
});

describe("reviewHref", () => {
  it("deep-links to the review detail page, URL-encoding the id", () => {
    expect(reviewHref("rev-1")).toBe("/reviews/rev-1");
    expect(reviewHref("a/b?c")).toBe("/reviews/a%2Fb%3Fc");
  });
});

describe("notifyReviewSubmitted", () => {
  it("persists a review_requested row + socket emit for every assigned reviewer", async () => {
    await notifyReviewSubmitted(submittedInput());

    const rows = createdRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.userId).sort()).toEqual(["rev-a", "rev-b"]);
    for (const row of rows) {
      expect(row.type).toBe("review_requested");
      expect(row.href).toBe("/reviews/rev-1");
      expect(String(row.message)).toContain("Sprint 4 sign-off");
      const payload = JSON.parse(String(row.payload));
      expect(payload.kind).toBe("review_requested");
      expect(payload.reviewId).toBe("rev-1");
      expect(payload.projectId).toBe("proj-1");
    }

    // Delivered to each reviewer's personal room only.
    expect(to.mock.calls.map((c) => c[0]).sort()).toEqual(["user:rev-a", "user:rev-b"]);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[0][0]).toBe("review:notification");
  });

  it("never notifies the submitting actor, and dedupes reviewer ids", async () => {
    await notifyReviewSubmitted(
      submittedInput({ reviewerIds: ["rev-a", "rev-a", "user-req"], actorId: "user-req" }),
    );

    const rows = createdRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe("rev-a");
  });

  it("suppresses a reviewer who disabled inApp × requirementsApproved (others still notified)", async () => {
    prefFindMany.mockImplementation(({ where }: { where: { userId: string } }) =>
      Promise.resolve(
        where.userId === "rev-a"
          ? [{ channel: "inApp", event: "requirementsApproved", enabled: false }]
          : [],
      ),
    );

    await notifyReviewSubmitted(submittedInput());

    const rows = createdRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe("rev-b");
    expect(to).toHaveBeenCalledTimes(1);
    expect(to).toHaveBeenCalledWith("user:rev-b");
  });

  it("fails open (still notifies) when the preference lookup itself fails", async () => {
    prefFindMany.mockRejectedValue(new Error("db down"));

    await notifyReviewSubmitted(submittedInput());

    expect(createdRows()).toHaveLength(2);
  });

  it("still emits the socket event when persistence fails, and never throws", async () => {
    notificationCreate.mockRejectedValue(new Error("insert failed"));

    await expect(notifyReviewSubmitted(submittedInput())).resolves.toBeUndefined();
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it("is a no-op emit when no socket server is registered (rows still persist)", async () => {
    io = null;

    await notifyReviewSubmitted(submittedInput());

    expect(createdRows()).toHaveLength(2);
    expect(emit).not.toHaveBeenCalled();
  });

  it("swallows a per-reviewer failure and still notifies the other reviewers", async () => {
    shouldNotifySpy.mockImplementation((userId: string) =>
      userId === "rev-a" ? Promise.reject(new Error("boom")) : Promise.resolve(true),
    );

    await expect(notifyReviewSubmitted(submittedInput())).resolves.toBeUndefined();

    const rows = createdRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe("rev-b");
  });

  it("never throws on malformed input (top-level guard)", async () => {
    await expect(
      notifyReviewSubmitted(submittedInput({ reviewerIds: null as unknown as string[] })),
    ).resolves.toBeUndefined();
    expect(notificationCreate).not.toHaveBeenCalled();
  });
});

describe("notifyReviewDecision", () => {
  it("notifies the requester on a non-terminal decision (review_decided only)", async () => {
    await notifyReviewDecision(decisionInput({ decision: "approved", outcome: null }));

    const rows = createdRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe("user-req");
    expect(rows[0].type).toBe("review_decided");
    expect(rows[0].href).toBe("/reviews/rev-1");
    expect(String(rows[0].message)).toContain("Alice Reviewer");
    expect(String(rows[0].message)).toContain("approved");
    expect(to).toHaveBeenCalledWith("user:user-req");
  });

  it("adds a review_approved row (with baselineId payload) on terminal approval", async () => {
    await notifyReviewDecision(
      decisionInput({ decision: "approved", outcome: "approved", baselineId: "base-9" }),
    );

    const rows = createdRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.type)).toEqual(["review_decided", "review_approved"]);
    const terminal = rows[1];
    expect(terminal.userId).toBe("user-req");
    expect(String(terminal.message)).toContain("approved");
    expect(JSON.parse(String(terminal.payload)).baselineId).toBe("base-9");
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it("adds a review_rejected row on terminal rejection", async () => {
    await notifyReviewDecision(
      decisionInput({ decision: "rejected", outcome: "rejected", baselineId: null }),
    );

    const rows = createdRows();
    expect(rows.map((r) => r.type)).toEqual(["review_decided", "review_rejected"]);
    expect(String(rows[1].message)).toContain("rejected");
  });

  it("suppresses everything when the requester disabled inApp × requirementsApproved", async () => {
    prefFindMany.mockResolvedValue([
      { channel: "inApp", event: "requirementsApproved", enabled: false },
    ]);

    await notifyReviewDecision(decisionInput({ outcome: "approved" }));

    expect(notificationCreate).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("never throws, even when persistence and the socket both fail", async () => {
    notificationCreate.mockRejectedValue(new Error("insert failed"));
    to.mockImplementation(() => {
      throw new Error("socket exploded");
    });

    await expect(
      notifyReviewDecision(decisionInput({ outcome: "approved" })),
    ).resolves.toBeUndefined();
  });

  it("never throws when the preference helper itself rejects (top-level guard)", async () => {
    shouldNotifySpy.mockRejectedValue(new Error("helper exploded"));

    await expect(notifyReviewDecision(decisionInput())).resolves.toBeUndefined();
    expect(notificationCreate).not.toHaveBeenCalled();
  });
});

describe("dispatch wrappers", () => {
  it("dispatchReviewSubmitted swallows async rejections (fire-and-forget)", async () => {
    prefFindMany.mockRejectedValue(new Error("boom"));
    notificationCreate.mockRejectedValue(new Error("boom"));

    expect(() => dispatchReviewSubmitted(submittedInput())).not.toThrow();
    await vi.waitFor(() => expect(prefFindMany).toHaveBeenCalled());
  });

  it("dispatchReviewDecision swallows async rejections (fire-and-forget)", async () => {
    notificationCreate.mockRejectedValue(new Error("boom"));

    expect(() => dispatchReviewDecision(decisionInput())).not.toThrow();
    await vi.waitFor(() => expect(notificationCreate).toHaveBeenCalled());
  });
});
