/**
 * Epic #547 — turn-logic tests for `runFoundationTurn`.
 *
 * Exercises with a fake TurnContext (no live Teams tenant):
 *   - every turn captures/refreshes the ConversationReference via the store;
 *   - a `message` activity is DELEGATED to inbound ingestion (#551), not echoed;
 *   - a non-message activity still captures the reference but does NOT ingest;
 *   - a store failure is swallowed (best-effort) so ingestion still runs.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityTypes, type ConversationReference } from "botbuilder";

import { runFoundationTurn } from "./bot-handler.js";
import * as inbound from "./inbound-sync.js";

interface FakeActivity {
  type: string;
  text?: string;
  value?: unknown;
  serviceUrl: string;
  channelId: string;
  conversation: { id: string; tenantId?: string };
  from: { id: string; aadObjectId?: string };
  recipient: { id: string };
}

/**
 * Minimal TurnContext stand-in. `TurnContext.getConversationReference` (the real
 * static) reads `activity.serviceUrl/channelId/conversation/from/recipient`, so a
 * plain object with those fields produces a real ConversationReference.
 */
function fakeContext(activity: Partial<FakeActivity> = {}) {
  const sent: string[] = [];
  const full: FakeActivity = {
    type: ActivityTypes.Message,
    text: "hello",
    serviceUrl: "https://smba.example.com/teams",
    channelId: "msteams",
    conversation: { id: "conv-1", tenantId: "tenant-1" },
    from: { id: "29:user", aadObjectId: "aad-1" },
    recipient: { id: "28:bot" },
    ...activity,
  };
  return {
    sent,
    context: {
      activity: full,
      sendActivity: async (activity: string | { attachments?: unknown[] }) => {
        sent.push(typeof activity === "string" ? activity : JSON.stringify(activity));
        return { id: "r1" };
      },
    } as never,
  };
}

function makeStore() {
  const save = vi.fn(async () => ({}) as never);
  return { save } as { save: ReturnType<typeof vi.fn> };
}

describe("runFoundationTurn", () => {
  let store: ReturnType<typeof makeStore>;
  let ingest: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    store = makeStore();
    ingest = vi.fn(async () => ({ outcome: "ingested", messageId: "m1" }));
  });

  it("captures the ConversationReference and delegates a message turn to ingestion", async () => {
    const { context } = fakeContext({ text: "ping" });
    await runFoundationTurn(context, {
      workspaceId: "ws-1",
      installationId: "inst-1",
      store: store as never,
      ingest: ingest as never,
    });

    expect(store.save).toHaveBeenCalledTimes(1);
    const [installationId, workspaceId, ref] = store.save.mock.calls[0] as [
      string,
      string,
      Partial<ConversationReference>,
    ];
    expect(installationId).toBe("inst-1");
    expect(workspaceId).toBe("ws-1");
    expect(ref.conversation?.id).toBe("conv-1");
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(ingest.mock.calls[0][1]).toEqual({ workspaceId: "ws-1" });
  });

  it("does NOT echo a message turn (echo behaviour removed in #551)", async () => {
    const { context, sent } = fakeContext({ text: "ping" });
    await runFoundationTurn(context, {
      workspaceId: "ws-1",
      installationId: "inst-1",
      store: store as never,
      ingest: ingest as never,
    });
    expect(sent).toEqual([]);
  });

  it("captures the reference but does NOT ingest on a non-message activity", async () => {
    const { context } = fakeContext({ type: ActivityTypes.ConversationUpdate });
    await runFoundationTurn(context, {
      workspaceId: "ws-1",
      installationId: "inst-1",
      store: store as never,
      ingest: ingest as never,
    });
    expect(store.save).toHaveBeenCalledTimes(1);
    expect(ingest).not.toHaveBeenCalled();
  });

  it("still ingests when the store save fails (best-effort persistence)", async () => {
    store.save.mockRejectedValueOnce(new Error("db down"));
    const { context } = fakeContext({ text: "resilient" });
    await expect(
      runFoundationTurn(context, {
        workspaceId: "ws-1",
        installationId: "inst-1",
        store: store as never,
        ingest: ingest as never,
      }),
    ).resolves.toBeUndefined();
    expect(ingest).toHaveBeenCalledTimes(1);
  });

  it("routes a Promote Action.Submit to the promote handler, NOT ingestion (#553)", async () => {
    const promote = vi.fn(async () => ({ outcome: "promoted", requirementId: "req-1" }));
    const { context } = fakeContext({
      text: "",
      value: { metisAction: "promote", threadId: "thread-1", messageId: "msg-1" },
    });
    await runFoundationTurn(context, {
      workspaceId: "ws-1",
      installationId: "inst-1",
      store: store as never,
      ingest: ingest as never,
      promote: promote as never,
    });
    expect(promote).toHaveBeenCalledTimes(1);
    expect(promote.mock.calls[0][1]).toEqual({ workspaceId: "ws-1" });
    // A promote submit is an action, not a chat message — it is NOT ingested.
    expect(ingest).not.toHaveBeenCalled();
  });

  it("treats a non-promote message value as a normal chat message (ingested)", async () => {
    const promote = vi.fn(async () => ({ outcome: "promoted" }));
    const { context } = fakeContext({ text: "hi", value: { metisAction: "other" } });
    await runFoundationTurn(context, {
      workspaceId: "ws-1",
      installationId: "inst-1",
      store: store as never,
      ingest: ingest as never,
      promote: promote as never,
    });
    expect(promote).not.toHaveBeenCalled();
    expect(ingest).toHaveBeenCalledTimes(1);
  });

  it("routes an Approve Action.Submit to the ChatOps approve-submit handler (#578)", async () => {
    const approveSubmit = vi.fn(async () => ({ outcome: "approved", draftId: "draft-1" }));
    const { context } = fakeContext({
      text: "",
      value: { metisAction: "approve", draftId: "draft-1" },
    });
    await runFoundationTurn(context, {
      workspaceId: "ws-1",
      installationId: "inst-1",
      store: store as never,
      ingest: ingest as never,
      chatops: { approveSubmit: approveSubmit as never },
    });
    expect(approveSubmit).toHaveBeenCalledTimes(1);
    expect(approveSubmit.mock.calls[0][1]).toEqual({ workspaceId: "ws-1" });
    expect(ingest).not.toHaveBeenCalled();
  });

  it("routes a `/metis status` message to the status command handler (#578)", async () => {
    const statusCommand = vi.fn(async () => ({ outcome: "status-shown", projectId: "p1" }));
    const { context } = fakeContext({ text: "/metis status" });
    await runFoundationTurn(context, {
      workspaceId: "ws-1",
      installationId: "inst-1",
      store: store as never,
      ingest: ingest as never,
      chatops: { statusCommand: statusCommand as never },
    });
    expect(statusCommand).toHaveBeenCalledTimes(1);
    expect(statusCommand.mock.calls[0][1]).toEqual({ projectRef: null });
    expect(ingest).not.toHaveBeenCalled();
  });

  it("routes a `/metis approve <draft>` message to the approve command handler (#578)", async () => {
    const approveCommand = vi.fn(async () => ({ outcome: "approve-prompted", draftId: "d1" }));
    const { context } = fakeContext({ text: "/metis approve d1" });
    await runFoundationTurn(context, {
      workspaceId: "ws-1",
      installationId: "inst-1",
      store: store as never,
      ingest: ingest as never,
      chatops: { approveCommand: approveCommand as never },
    });
    expect(approveCommand).toHaveBeenCalledTimes(1);
    expect(approveCommand.mock.calls[0][1]).toEqual({ draftRef: "d1" });
    expect(ingest).not.toHaveBeenCalled();
  });

  it("posts a help card for a bare `/metis` and does NOT ingest (#578)", async () => {
    const { context, sent } = fakeContext({ text: "/metis" });
    await runFoundationTurn(context, {
      workspaceId: "ws-1",
      installationId: "inst-1",
      store: store as never,
      ingest: ingest as never,
    });
    expect(ingest).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
  });

  it("posts an unknown-command card for an unrecognised `/metis` subcommand (#578)", async () => {
    const { context, sent } = fakeContext({ text: "/metis frobnicate" });
    await runFoundationTurn(context, {
      workspaceId: "ws-1",
      installationId: "inst-1",
      store: store as never,
      ingest: ingest as never,
    });
    expect(ingest).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(sent[0].toLowerCase()).toContain("recognise");
  });

  it("swallows a help-card send failure (never throws into the turn) (#578)", async () => {
    const { context } = fakeContext({ text: "/metis" });
    (context.sendActivity as unknown) = vi.fn(async () => {
      throw new Error("channel gone");
    });
    await expect(
      runFoundationTurn(context, {
        workspaceId: "ws-1",
        installationId: "inst-1",
        store: store as never,
        ingest: ingest as never,
      }),
    ).resolves.toBeUndefined();
  });

  it("does NOT treat a normal chat message as a command — it is ingested (#578)", async () => {
    const statusCommand = vi.fn(async () => ({ outcome: "status-shown" }));
    const { context } = fakeContext({ text: "hello team, what is the status" });
    await runFoundationTurn(context, {
      workspaceId: "ws-1",
      installationId: "inst-1",
      store: store as never,
      ingest: ingest as never,
      chatops: { statusCommand: statusCommand as never },
    });
    expect(statusCommand).not.toHaveBeenCalled();
    expect(ingest).toHaveBeenCalledTimes(1);
  });

  it("falls back to the real ingestTeamsActivity when no ingest seam is injected", async () => {
    const spy = vi
      .spyOn(inbound, "ingestTeamsActivity")
      .mockResolvedValue({ outcome: "ingested", messageId: "m9" });
    const { context } = fakeContext({ text: "default path" });
    await runFoundationTurn(context, {
      workspaceId: "ws-1",
      installationId: "inst-1",
      store: store as never,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toEqual({ workspaceId: "ws-1" });
    spy.mockRestore();
  });
});
