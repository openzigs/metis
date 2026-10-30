/**
 * #1588 — who may turn a checkpoint decision into an APPROVED requirement:
 * whoever holds `project.update`, read from the request's role or, for a user
 * who is not the caller, from durable state — failing closed to `draft`.
 */
import { ROLE_PERMISSIONS, type AuthPayload, type RoleKey } from "@metis/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const loadLiveAuthPayload = vi.hoisted(() =>
  vi.fn(async (_userId: string): Promise<AuthPayload | null> => null),
);
vi.mock("../auth/live-auth-payload.js", () => ({ loadLiveAuthPayload }));
const findAnalysis = vi.hoisted(() =>
  vi.fn(
    async (
      _args: unknown,
    ): Promise<{ startedById: string | null; metadata?: string | null } | null> => null,
  ),
);
vi.mock("../prisma.js", () => ({ prisma: { analysis: { findFirst: findAnalysis } } }));

const { promotedReviewStatus, signOffForResave, signOffForRole, signOffForUser } =
  await import("./checkpoint-sign-off.js");
const { SYSTEM_ACTOR_ID } = await import("../audit/system-actor.js");

const live = (role: RoleKey): AuthPayload => ({
  userId: `u-${role}`,
  username: `u-${role}`,
  role,
  permissions: ROLE_PERMISSIONS[role],
  workspaces: [],
});

const EXPECTED: Record<RoleKey, boolean> = {
  reader: false,
  developer: false,
  coordinator: true,
  admin: true,
};

describe("#1588 — checkpoint sign-off", () => {
  beforeEach(() => {
    loadLiveAuthPayload.mockReset();
    loadLiveAuthPayload.mockResolvedValue(null);
    findAnalysis.mockReset();
    findAnalysis.mockResolvedValue(null);
  });

  it("writes approved rows only for a sign-off, draft otherwise", () => {
    expect(promotedReviewStatus({ asApproved: true })).toBe("approved");
    expect(promotedReviewStatus({ asApproved: false })).toBe("draft");
  });

  for (const [role, asApproved] of Object.entries(EXPECTED) as [RoleKey, boolean][]) {
    it(`a ${role} caller ${asApproved ? "signs off" : "does not sign off"}`, () => {
      expect(signOffForRole(role)).toEqual({ asApproved });
    });

    it(`a ${role} starter, read from durable state, ${asApproved ? "signs off" : "does not"}`, async () => {
      loadLiveAuthPayload.mockResolvedValueOnce(live(role));
      expect(await signOffForUser(`u-${role}`)).toEqual({ asApproved });
      expect(loadLiveAuthPayload).toHaveBeenCalledWith(`u-${role}`);
    });
  }

  it("an unrecognised role does not sign off", () => {
    expect(signOffForRole("member" as RoleKey)).toEqual({ asApproved: false });
  });

  it("a system-started run (no starter, or the system actor) promotes as draft without a lookup", async () => {
    expect(await signOffForUser(null)).toEqual({ asApproved: false });
    expect(await signOffForUser(undefined)).toEqual({ asApproved: false });
    expect(await signOffForUser(SYSTEM_ACTOR_ID)).toEqual({ asApproved: false });
    expect(loadLiveAuthPayload).not.toHaveBeenCalled();
  });

  it("a deactivated or deleted user (no live identity) does not sign off", async () => {
    loadLiveAuthPayload.mockResolvedValueOnce(null);
    expect(await signOffForUser("u-gone")).toEqual({ asApproved: false });
  });

  it("a failed lookup fails closed to draft rather than throwing", async () => {
    loadLiveAuthPayload.mockRejectedValueOnce(new Error("db down"));
    expect(await signOffForUser("u-coordinator")).toEqual({ asApproved: false });
  });

  it("a re-save with no actor falls back to the run's starter, judged by durable state", async () => {
    findAnalysis.mockResolvedValueOnce({ startedById: "u-coordinator", metadata: "{}" });
    loadLiveAuthPayload.mockResolvedValueOnce(live("coordinator"));
    expect(await signOffForResave("ana-1")).toEqual({ asApproved: true });
    expect(findAnalysis).toHaveBeenCalledWith({
      where: { id: "ana-1" },
      select: { startedById: true, metadata: true },
    });
    expect(loadLiveAuthPayload).toHaveBeenCalledWith("u-coordinator");
  });

  it("the triggering actor, not the starter, decides when there is one", async () => {
    findAnalysis.mockResolvedValue({ startedById: "u-coordinator", metadata: null });
    loadLiveAuthPayload.mockResolvedValueOnce(live("developer"));
    expect(await signOffForResave("ana-1", "u-developer")).toEqual({ asApproved: false });
    expect(loadLiveAuthPayload).toHaveBeenCalledWith("u-developer");
    loadLiveAuthPayload.mockResolvedValueOnce(live("coordinator"));
    expect(await signOffForResave("ana-1", "u-coordinator")).toEqual({ asApproved: true });
  });

  it("a set promoted as draft is never widened by a coordinator's re-save", async () => {
    findAnalysis.mockResolvedValueOnce({
      startedById: "u-coordinator",
      metadata: JSON.stringify({ checkpointSignOff: "draft" }),
    });
    loadLiveAuthPayload.mockResolvedValue(live("coordinator"));
    expect(await signOffForResave("ana-1", "u-coordinator")).toEqual({ asApproved: false });
  });

  it("a run with no starter, no row, or an unreadable row re-saves as draft", async () => {
    findAnalysis.mockResolvedValueOnce({ startedById: null, metadata: null });
    expect(await signOffForResave("ana-system")).toEqual({ asApproved: false });
    findAnalysis.mockResolvedValueOnce(null);
    expect(await signOffForResave("ana-gone")).toEqual({ asApproved: false });
    findAnalysis.mockRejectedValueOnce(new Error("db down"));
    expect(await signOffForResave("ana-err", "u-coordinator")).toEqual({ asApproved: false });
    findAnalysis.mockResolvedValueOnce({ startedById: "u-coordinator", metadata: "{not json" });
    expect(await signOffForResave("ana-bad-meta", "u-coordinator")).toEqual({ asApproved: false });
    expect(loadLiveAuthPayload).not.toHaveBeenCalled();
  });
});
