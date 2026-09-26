/**
 * #142 — a pending tool approval can be answered exactly once, only by the
 * session's owner, only for the session/project it was raised in, and only
 * before it lapses. Every other attempt finds nothing and changes nothing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolApprovalBroker, DEFAULT_APPROVAL_TIMEOUT_MS } from "./approval-broker.js";
import type { ApprovalTicket, BrokerRequest } from "./approval-broker.js";

const REQ: BrokerRequest = {
  sessionId: "s-alice",
  userId: "alice",
  projectId: "p1",
  toolName: "query_database",
  argsHash: "h",
  callId: "call_1",
};

function open(
  broker: ToolApprovalBroker,
  over: Partial<BrokerRequest> = {},
): { answer: Promise<string>; ticket: ApprovalTicket } {
  let ticket!: ApprovalTicket;
  const answer = broker.request({ ...REQ, ...over }, (t) => {
    ticket = t;
  });
  return { answer, ticket };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ToolApprovalBroker", () => {
  it("applies the owner's answer for the right session and project", async () => {
    const broker = new ToolApprovalBroker();
    const { answer, ticket } = open(broker);
    expect(ticket.approvalId).toMatch(/^apr_[0-9a-f-]{36}$/);
    expect(
      broker.decide({
        approvalId: ticket.approvalId,
        sessionId: "s-alice",
        userId: "alice",
        projectId: "p1",
        answer: "approve",
      }),
    ).toEqual({ ok: true, answer: "approve" });
    await expect(answer).resolves.toBe("approve");
    expect(broker.size).toBe(0);
  });

  it("a replayed decision finds nothing (single use)", async () => {
    const broker = new ToolApprovalBroker();
    const { answer, ticket } = open(broker);
    const base = { approvalId: ticket.approvalId, sessionId: "s-alice", userId: "alice" };
    expect(broker.decide({ ...base, answer: "deny" }).ok).toBe(true);
    await expect(answer).resolves.toBe("deny");
    // The replay — even flipping to approve — cannot resurrect or change it.
    expect(broker.decide({ ...base, answer: "approve" })).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("another user, another session or another project cannot answer it", async () => {
    const broker = new ToolApprovalBroker();
    const { answer, ticket } = open(broker);
    const id = ticket.approvalId;
    for (const attempt of [
      { sessionId: "s-alice", userId: "mallory" },
      { sessionId: "s-mallory", userId: "alice" },
      { sessionId: "s-mallory", userId: "mallory" },
      { sessionId: "s-alice", userId: "alice", projectId: "p-other" },
    ]) {
      expect(broker.decide({ approvalId: id, answer: "approve", ...attempt })).toEqual({
        ok: false,
        reason: "not_found",
      });
    }
    // Still pending for its real owner.
    expect(broker.size).toBe(1);
    broker.decide({ approvalId: id, sessionId: "s-alice", userId: "alice", answer: "deny" });
    await expect(answer).resolves.toBe("deny");
  });

  it("a forged id is not found", () => {
    const broker = new ToolApprovalBroker();
    open(broker);
    expect(
      broker.decide({
        approvalId: "apr_00000000-0000-4000-8000-000000000000",
        sessionId: "s-alice",
        userId: "alice",
        answer: "approve",
      }),
    ).toEqual({ ok: false, reason: "not_found" });
  });

  it("lapses to 'expired' after the timeout, and a late answer is refused", async () => {
    vi.useFakeTimers();
    const broker = new ToolApprovalBroker();
    const { answer, ticket } = open(broker, { timeoutMs: 1_000 });
    vi.advanceTimersByTime(1_000);
    await expect(answer).resolves.toBe("expired");
    expect(
      broker.decide({
        approvalId: ticket.approvalId,
        sessionId: "s-alice",
        userId: "alice",
        answer: "approve",
      }),
    ).toEqual({ ok: false, reason: "not_found" });
  });

  it("refuses an answer that arrives after expiry even if the timer is late", async () => {
    let now = 1_000_000;
    const broker = new ToolApprovalBroker(() => now);
    const { answer, ticket } = open(broker, { timeoutMs: 60_000 });
    now += 60_000; // clock past expiry, timer not yet fired
    expect(
      broker.decide({
        approvalId: ticket.approvalId,
        sessionId: "s-alice",
        userId: "alice",
        answer: "approve",
      }),
    ).toEqual({ ok: false, reason: "expired" });
    await expect(answer).resolves.toBe("expired");
  });

  it("an aborted turn denies its pending approval", async () => {
    const broker = new ToolApprovalBroker();
    const ac = new AbortController();
    const { answer } = open(broker, { signal: ac.signal });
    ac.abort();
    await expect(answer).resolves.toBe("deny");
    expect(broker.size).toBe(0);
  });

  it("an already-aborted turn never waits", async () => {
    const broker = new ToolApprovalBroker();
    const ac = new AbortController();
    ac.abort();
    const onTicket = vi.fn();
    await expect(broker.request({ ...REQ, signal: ac.signal }, onTicket)).resolves.toBe("deny");
    expect(onTicket).not.toHaveBeenCalled();
  });

  it("a notifier that throws does not strand the approval — it still lapses", async () => {
    vi.useFakeTimers();
    const broker = new ToolApprovalBroker();
    const answer = broker.request({ ...REQ, timeoutMs: 10 }, () => {
      throw new Error("socket down");
    });
    vi.advanceTimersByTime(10);
    await expect(answer).resolves.toBe("expired");
  });

  it("lists only the owner's pending approvals for that session", () => {
    const broker = new ToolApprovalBroker();
    const mine = open(broker);
    open(broker, { sessionId: "s-other", userId: "bob" });
    const listed = broker.listPending("s-alice", "alice");
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      approvalId: mine.ticket.approvalId,
      toolName: "query_database",
      callId: "call_1",
    });
    expect(broker.listPending("s-alice", "bob")).toEqual([]);
  });

  it("defaults the timeout", () => {
    const broker = new ToolApprovalBroker(() => 0);
    const { ticket } = open(broker);
    expect(ticket.expiresAt).toBe(DEFAULT_APPROVAL_TIMEOUT_MS);
  });
});
