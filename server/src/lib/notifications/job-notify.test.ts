/**
 * #2343 — the job-outcome notifier's failure paths, hermetically: a job's end
 * path calls it, so nothing it does may throw, and an unknown recipient check
 * sends nothing. The happy path, idempotency, preference and access rules run
 * against a real database in `tests/job-notifications-2343.sqlite.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const notificationCreate = vi.fn();
const notificationFindFirst = vi.fn();
const analysisFindFirst = vi.fn();
vi.mock("../prisma.js", () => ({
  prisma: {
    notification: {
      create: (...a: unknown[]) => notificationCreate(...a),
      findFirst: (...a: unknown[]) => notificationFindFirst(...a),
    },
    analysis: { findFirst: (...a: unknown[]) => analysisFindFirst(...a) },
  },
}));
const shouldNotify = vi.fn();
vi.mock("./preferences.js", () => ({ shouldNotify: (...a: unknown[]) => shouldNotify(...a) }));
const isEligibleAssignee = vi.fn();
vi.mock("../requirements/assignee-eligibility.js", () => ({
  isEligibleAssignee: (...a: unknown[]) => isEligibleAssignee(...a),
}));
const emit = vi.fn();
let io: { to: (room: string) => { emit: typeof emit } } | null = { to: () => ({ emit }) };
vi.mock("../socket/registry.js", () => ({ getSocketServer: () => io }));

const { notifyJobOutcome, dispatchJobOutcome, JOB_FINISHED_PREFERENCE } =
  await import("./job-notify.js");

const input = {
  kind: "analysis" as const,
  jobId: "an-1",
  projectId: "p-1",
  userId: "u-1",
  outcome: "completed" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  io = { to: () => ({ emit }) };
  shouldNotify.mockResolvedValue(true);
  isEligibleAssignee.mockResolvedValue(true);
  notificationFindFirst.mockResolvedValue(null);
  notificationCreate.mockResolvedValue({ id: "n-1" });
  analysisFindFirst.mockResolvedValue({ title: "Checkout", metadata: "{not json" });
});

describe("notifyJobOutcome failure paths (#2343)", () => {
  it("is gated on the inApp × jobFinished cell", async () => {
    shouldNotify.mockResolvedValue(false);
    expect(await notifyJobOutcome(input)).toBeNull();
    expect(shouldNotify).toHaveBeenCalledWith("u-1", "inApp", JOB_FINISHED_PREFERENCE);
    expect(notificationCreate).not.toHaveBeenCalled();
  });

  it("sends nothing when the recipient check itself fails (unknown is not yes)", async () => {
    isEligibleAssignee.mockRejectedValue(new Error("db down"));
    expect(await notifyJobOutcome(input)).toBeNull();
    expect(notificationCreate).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("reads an unreadable run's metadata as no open questions", async () => {
    await notifyJobOutcome(input);
    expect(notificationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          title: 'Change request "Checkout" is ready',
          message: "Open the change request to review its requirements.",
          projectId: "p-1",
        }),
      }),
    );
  });

  it("does not count open questions on a failed run", async () => {
    analysisFindFirst.mockResolvedValue({
      title: null,
      metadata: JSON.stringify({
        enhancement: { enableClarification: true },
        structuredRequirements: { totalAmbiguities: 4 },
      }),
    });
    await notifyJobOutcome({ ...input, outcome: "failed" });
    const data = notificationCreate.mock.calls[0][0].data;
    expect(data.title).toBe("Your change request failed");
    expect(data.message).not.toMatch(/Questions waiting/);
    expect(data.type).toBe("job_failed");
  });

  it("keeps the bell row when the emit throws, and with no socket server", async () => {
    io = {
      to: () => {
        throw new Error("transport");
      },
    };
    expect(await notifyJobOutcome(input)).toBe("n-1");
    io = null;
    expect(await notifyJobOutcome(input)).toBe("n-1");
  });

  it("answers null when persisting fails, never throws", async () => {
    notificationCreate.mockRejectedValue(new Error("write failed"));
    await expect(notifyJobOutcome(input)).resolves.toBeNull();
    expect(emit).not.toHaveBeenCalled();
  });

  it("dispatch never throws or rejects into the caller", async () => {
    shouldNotify.mockRejectedValue(new Error("boom"));
    expect(() => dispatchJobOutcome(input)).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });

  it("dedupes on the stored key, so an exact-key match sends nothing", async () => {
    notificationFindFirst.mockResolvedValue({ id: "n-0" });
    expect(await notifyJobOutcome({ ...input, dedupeKey: "k:1" })).toBeNull();
    expect(notificationFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "u-1",
          type: "job_completed",
          projectId: "p-1",
          payload: { contains: '"dedupeKey":"k:1"' },
        }),
      }),
    );
  });
});
