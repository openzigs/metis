/**
 * #1484 — payload replay guard: the pure parts and the error paths. The
 * durable behaviour (unique claim across a restart, purge) is driven against a
 * real SQLite database in `tests/webhook-payload-replay-1484.sqlite.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const table = vi.hoisted(() => ({
  create: vi.fn(),
  deleteMany: vi.fn(),
}));
vi.mock("../prisma.js", () => ({ prisma: { webhookPayloadDigest: table } }));

import {
  claimPayload,
  isStaleSignedEvent,
  purgeOldPayloadDigests,
  releasePayload,
  signedEventTime,
  signedGithubEvent,
  PAYLOAD_DIGEST_RETENTION_MS,
  SIGNED_EVENT_MAX_AGE_MS,
} from "./payload-replay.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-24T12:00:00.000Z");
const claim = { receiver: "github-pr", eventType: "pull_request", rawBody: '{"a":1}' };
// sha256('{"a":1}')
const SHA = "015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862";

beforeEach(() => {
  table.create.mockReset();
  table.deleteMany.mockReset();
});

describe("claimPayload / releasePayload", () => {
  it("keys the claim on receiver, route event and the body's SHA-256", async () => {
    table.create.mockResolvedValue({});
    expect(await claimPayload(claim)).toEqual({ duplicate: false });
    expect(table.create).toHaveBeenCalledWith({
      data: { receiver: "github-pr", eventType: "pull_request", bodySha256: SHA },
    });
  });

  it("a unique violation is a duplicate", async () => {
    table.create.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }));
    expect(await claimPayload(claim)).toEqual({ duplicate: true });
  });

  it("any other database error propagates (the caller decides)", async () => {
    table.create.mockRejectedValue(new Error("SQLITE_BUSY"));
    await expect(claimPayload(claim)).rejects.toThrow("SQLITE_BUSY");
  });

  it("release deletes exactly that claim", async () => {
    table.deleteMany.mockResolvedValue({ count: 1 });
    await releasePayload(claim);
    expect(table.deleteMany).toHaveBeenCalledWith({
      where: { receiver: "github-pr", eventType: "pull_request", bodySha256: SHA },
    });
  });
});

describe("purgeOldPayloadDigests", () => {
  it("deletes rows older than the retention window", async () => {
    table.deleteMany.mockResolvedValue({ count: 3 });
    expect(await purgeOldPayloadDigests(undefined, NOW)).toBe(3);
    expect(table.deleteMany).toHaveBeenCalledWith({
      where: { receivedAt: { lt: new Date(NOW - PAYLOAD_DIGEST_RETENTION_MS) } },
    });
  });

  it("tolerates a delegate that reports no count", async () => {
    table.deleteMany.mockResolvedValue(undefined);
    expect(await purgeOldPayloadDigests(1000, NOW)).toBe(0);
  });
});

describe("signed event age", () => {
  const at = (ms: number) => new Date(ms).toISOString();

  it("reads pull_request.updated_at, then issue.updated_at", () => {
    expect(signedEventTime({ pull_request: { updated_at: at(NOW) } })).toBe(NOW);
    expect(signedEventTime({ issue: { updated_at: at(NOW - DAY) } })).toBe(NOW - DAY);
  });

  it("returns null when there is nothing readable", () => {
    expect(signedEventTime(null)).toBeNull();
    expect(signedEventTime("x")).toBeNull();
    expect(signedEventTime({})).toBeNull();
    expect(signedEventTime({ pull_request: { updated_at: 5 } })).toBeNull();
    expect(signedEventTime({ pull_request: { updated_at: "not a date" } })).toBeNull();
  });

  it("is stale only past the age limit, and never without a timestamp", () => {
    const pr = (ms: number) => ({ pull_request: { updated_at: at(ms) } });
    expect(isStaleSignedEvent(pr(NOW - SIGNED_EVENT_MAX_AGE_MS - 1), NOW)).toBe(true);
    expect(isStaleSignedEvent(pr(NOW - SIGNED_EVENT_MAX_AGE_MS), NOW)).toBe(false);
    // GitHub's manual redelivery reaches 3 days back: those still pass.
    expect(isStaleSignedEvent(pr(NOW - 3 * DAY), NOW)).toBe(false);
    // A future time (our clock behind GitHub's) is not stale.
    expect(isStaleSignedEvent(pr(NOW + DAY), NOW)).toBe(false);
    expect(isStaleSignedEvent({}, NOW)).toBe(false);
  });

  it("the retention window outlives the age limit by more than a day", () => {
    expect(PAYLOAD_DIGEST_RETENTION_MS - SIGNED_EVENT_MAX_AGE_MS).toBeGreaterThan(DAY);
  });
});

describe("signedGithubEvent (#1483)", () => {
  it("tells GitHub's events apart by their signed body, not a header", () => {
    expect(signedGithubEvent({ action: "opened", pull_request: {} })).toBe("pull_request");
    expect(signedGithubEvent({ pull_request: {}, review: {} })).toBe("pull_request_review");
    expect(signedGithubEvent({ pull_request: {}, comment: {} })).toBe(
      "pull_request_review_comment",
    );
    expect(signedGithubEvent({ pull_request: {}, thread: {} })).toBe("pull_request_review_thread");
    expect(signedGithubEvent({ action: "closed", issue: {}, repository: {} })).toBe("issues");
    expect(signedGithubEvent({ action: "edited", issue: {}, comment: {} })).toBe("issue_comment");
  });

  it("is null for a body that is none of them", () => {
    for (const p of [
      null,
      undefined,
      "x",
      [],
      {},
      { zen: "ping" },
      { issue: "x" },
      { issue: [] },
    ]) {
      expect(signedGithubEvent(p)).toBeNull();
    }
  });

  it("is `issues` only with an action and a repository", () => {
    for (const p of [
      { issue: {}, repository: {} },
      { action: "closed", issue: {} },
      { action: 1, issue: {}, repository: {} },
      { action: "closed", issue: {}, repository: "acme/x" },
    ]) {
      expect(signedGithubEvent(p)).toBeNull();
    }
  });
});
