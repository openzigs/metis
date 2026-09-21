/**
 * Issue #67 — notification-sync orchestration tests.
 *
 * Stubs every collaborator (no live Azure, no real Prisma, no network). Proves:
 *   - happy path: a registered target → adapter.continueConversationAsync called
 *     with the workspace's appId, the stored reference, and the rendered activity
 *     is sent;
 *   - no target → no-op (no creds resolved, no adapter built);
 *   - non-allowlisted tenant → not sent (suppressed before any send);
 *   - no installation → not sent (resolveAppPassword null) and SWALLOWED;
 *   - a send failure is swallowed (never rejects), result reason "error";
 *   - the originating op is unaffected: scheduleEventNotification never throws.
 */
import { describe, expect, it, vi } from "vitest";
import type { Activity, TurnContext } from "botbuilder";

import {
  sendEventNotification,
  scheduleEventNotification,
  type NotificationSyncDeps,
} from "./notification-sync.js";
import type { ResolvedNotificationTarget } from "./notification-target-store.js";
import type { ResolvedCredentials } from "./installation-store.js";
import type { TeamsTenantPolicy } from "./tenant-allowlist.js";

const activity: Partial<Activity> = { type: "message", text: "hello" };

function makeTarget(over: Partial<ResolvedNotificationTarget> = {}): ResolvedNotificationTarget {
  return {
    id: "nt-1",
    workspaceId: "ws-1",
    eventType: "analysis-complete",
    conversationId: "convo-1",
    channelId: "msteams",
    tenantId: "tenant-a",
    status: "active",
    createdById: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    reference: { conversation: { id: "convo-1" }, serviceUrl: "https://svc" },
    ...over,
  };
}

const creds: ResolvedCredentials = {
  appId: "app-1",
  appPassword: "secret",
  appType: "MultiTenant",
  tenantId: null,
};

const allowAll: TeamsTenantPolicy = { mode: "allow-all", tenants: [] };

interface Harness {
  deps: Partial<NotificationSyncDeps>;
  continueSpy: ReturnType<typeof vi.fn>;
  sentActivities: Partial<Activity>[];
  resolveSpy: ReturnType<typeof vi.fn>;
}

function harness(opts: {
  target?: ResolvedNotificationTarget | null;
  creds?: ResolvedCredentials | null;
  policy?: TeamsTenantPolicy;
  continueImpl?: () => Promise<void>;
}): Harness {
  const sentActivities: Partial<Activity>[] = [];
  const continueSpy = vi.fn(
    async (
      _appId: string,
      _ref: unknown,
      logic: (ctx: TurnContext) => Promise<void>,
    ): Promise<void> => {
      if (opts.continueImpl) return opts.continueImpl();
      const ctx = {
        sendActivity: async (a: Partial<Activity>) => {
          sentActivities.push(a);
        },
      } as unknown as TurnContext;
      await logic(ctx);
    },
  );
  const resolveSpy = vi.fn(async () => opts.creds ?? null);
  const deps: Partial<NotificationSyncDeps> = {
    targetStore: {
      getByEvent: vi.fn(async () => opts.target ?? null),
    } as unknown as NotificationSyncDeps["targetStore"],
    installStore: {
      resolveAppPassword: resolveSpy,
    } as unknown as NotificationSyncDeps["installStore"],
    adapterFactory: (() => ({ continueConversationAsync: continueSpy })) as never,
    tenantPolicy: opts.policy ?? allowAll,
  };
  return { deps, continueSpy, sentActivities, resolveSpy };
}

describe("sendEventNotification (#67)", () => {
  it("sends the rendered activity to the registered target's channel", async () => {
    const h = harness({ target: makeTarget(), creds });
    const res = await sendEventNotification("ws-1", "analysis-complete", activity, h.deps);
    expect(res).toEqual({ sent: true });
    expect(h.continueSpy).toHaveBeenCalledTimes(1);
    // appId from resolved creds, stored reference passed through.
    expect(h.continueSpy.mock.calls[0][0]).toBe("app-1");
    expect(h.continueSpy.mock.calls[0][1]).toEqual({
      conversation: { id: "convo-1" },
      serviceUrl: "https://svc",
    });
    expect(h.sentActivities).toEqual([activity]);
  });

  it("is a no-op when no target is registered (no creds resolved, no adapter call)", async () => {
    const h = harness({ target: null, creds });
    const res = await sendEventNotification("ws-1", "analysis-complete", activity, h.deps);
    expect(res).toEqual({ sent: false, reason: "no-target" });
    expect(h.resolveSpy).not.toHaveBeenCalled();
    expect(h.continueSpy).not.toHaveBeenCalled();
  });

  it("does not send to a non-allowlisted tenant", async () => {
    const h = harness({
      target: makeTarget({ tenantId: "tenant-z" }),
      creds,
      policy: { mode: "allowlist", tenants: ["tenant-a"] },
    });
    const res = await sendEventNotification("ws-1", "analysis-complete", activity, h.deps);
    expect(res).toEqual({ sent: false, reason: "tenant-not-allowed" });
    expect(h.resolveSpy).not.toHaveBeenCalled();
    expect(h.continueSpy).not.toHaveBeenCalled();
  });

  it("sends when the target's tenant is on the allowlist", async () => {
    const h = harness({
      target: makeTarget({ tenantId: "tenant-a" }),
      creds,
      policy: { mode: "allowlist", tenants: ["tenant-a"] },
    });
    const res = await sendEventNotification("ws-1", "analysis-complete", activity, h.deps);
    expect(res).toEqual({ sent: true });
  });

  it("swallows a missing installation (no creds) and reports an error reason", async () => {
    const h = harness({ target: makeTarget(), creds: null });
    const res = await sendEventNotification("ws-1", "analysis-complete", activity, h.deps);
    expect(res).toEqual({ sent: false, reason: "error" });
    expect(h.continueSpy).not.toHaveBeenCalled();
  });

  it("swallows a proactive-send failure and never rejects", async () => {
    const h = harness({
      target: makeTarget(),
      creds,
      continueImpl: async () => {
        throw new Error("Teams API 502");
      },
    });
    const res = await sendEventNotification("ws-1", "analysis-complete", activity, h.deps);
    expect(res).toEqual({ sent: false, reason: "error" });
  });

  it("treats a blank workspaceId as no-target", async () => {
    const h = harness({ target: makeTarget(), creds });
    const res = await sendEventNotification("", "analysis-complete", activity, h.deps);
    expect(res).toEqual({ sent: false, reason: "no-target" });
  });
});

describe("scheduleEventNotification (#67)", () => {
  it("returns synchronously and never throws (fire-and-forget)", () => {
    // No overrides → real default deps; with no installed workspace this resolves
    // to a no-op/error internally, but must not throw into the caller.
    expect(() =>
      scheduleEventNotification("nonexistent-ws", "analysis-complete", activity),
    ).not.toThrow();
  });
});
