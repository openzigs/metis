/**
 * Issue #67 — notification-hooks tests.
 *
 * Proves each hook: derives the workspace from the project, renders the right
 * card, and schedules a send with the correct event type; no-ops when the
 * project has no workspace; and is best-effort (a derivation error is swallowed,
 * never thrown into the emission point).
 *
 * #614 — user-targeted cards enforce the recipient's `teams × <event>`
 * preference via the REAL `shouldNotify` (prisma is mocked, so the fail-open
 * contract is exercised end-to-end). Workspace-broadcast cards (no
 * `targetUserId`, and ALL budget-exceeded cards) are preference-exempt.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { Activity } from "botbuilder";

const { prefFindMany } = vi.hoisted(() => ({ prefFindMany: vi.fn() }));
vi.mock("../prisma.js", () => ({
  prisma: { notificationPreference: { findMany: prefFindMany } },
}));

import {
  notifyAnalysisComplete,
  notifyPublishRolledBack,
  notifyBudgetExceeded,
  EVENT_ANALYSIS_COMPLETE,
  EVENT_PUBLISH_ROLLED_BACK,
  EVENT_BUDGET_EXCEEDED,
} from "./notification-hooks.js";

function dbWithProject(project: { name: string; workspaceId: string | null } | null): PrismaClient {
  return {
    project: { findFirst: vi.fn(async () => project) },
  } as unknown as PrismaClient;
}

interface Scheduled {
  workspaceId: string;
  eventType: string;
  activity: Partial<Activity>;
}

function scheduler(): { schedule: ReturnType<typeof vi.fn>; calls: Scheduled[] } {
  const calls: Scheduled[] = [];
  const schedule = vi.fn((workspaceId: string, eventType: string, activity: Partial<Activity>) => {
    calls.push({ workspaceId, eventType, activity });
  });
  return { schedule, calls };
}

beforeEach(() => {
  // #614 default: no stored preference rows (teams × <event> defaults ON).
  prefFindMany.mockReset();
  prefFindMany.mockResolvedValue([]);
});

describe("notifyAnalysisComplete (#67)", () => {
  it("derives the workspace + project name and schedules an analysis-complete card", async () => {
    const db = dbWithProject({ name: "Acme Portal", workspaceId: "ws-1" });
    const s = scheduler();
    await notifyAnalysisComplete(
      { analysisId: "an-1", projectId: "pr-1", requirementCount: 5 },
      { db, schedule: s.schedule },
    );
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0].workspaceId).toBe("ws-1");
    expect(s.calls[0].eventType).toBe(EVENT_ANALYSIS_COMPLETE);
    expect(s.calls[0].activity.text).toContain("Acme Portal");
  });

  it("no-ops when the project has no workspace", async () => {
    const db = dbWithProject({ name: "P", workspaceId: null });
    const s = scheduler();
    await notifyAnalysisComplete(
      { analysisId: "an-1", projectId: "pr-1" },
      { db, schedule: s.schedule },
    );
    expect(s.schedule).not.toHaveBeenCalled();
  });

  it("no-ops when the project is not found", async () => {
    const db = dbWithProject(null);
    const s = scheduler();
    await notifyAnalysisComplete(
      { analysisId: "an-1", projectId: "pr-x" },
      { db, schedule: s.schedule },
    );
    expect(s.schedule).not.toHaveBeenCalled();
  });

  it("swallows a derivation error (never throws into the emission point)", async () => {
    const db = {
      project: {
        findFirst: vi.fn(async () => {
          throw new Error("db down");
        }),
      },
    } as unknown as PrismaClient;
    const s = scheduler();
    await expect(
      notifyAnalysisComplete(
        { analysisId: "an-1", projectId: "pr-1" },
        { db, schedule: s.schedule },
      ),
    ).resolves.toBeUndefined();
    expect(s.schedule).not.toHaveBeenCalled();
  });
});

describe("notifyAnalysisComplete — preference enforcement (#614)", () => {
  it("suppresses a user-targeted card when the user disabled teams × analysisCompleted", async () => {
    const db = dbWithProject({ name: "Acme Portal", workspaceId: "ws-1" });
    const s = scheduler();
    prefFindMany.mockResolvedValue([
      { channel: "teams", event: "analysisCompleted", enabled: false },
    ]);

    await notifyAnalysisComplete(
      { analysisId: "an-1", projectId: "pr-1", targetUserId: "u1" },
      { db, schedule: s.schedule },
    );

    expect(s.schedule).not.toHaveBeenCalled();
    expect(prefFindMany).toHaveBeenCalledWith({
      where: { userId: "u1", channel: "teams", event: "analysisCompleted" },
    });
  });

  it("sends a user-targeted card when the preference is enabled (default)", async () => {
    const db = dbWithProject({ name: "Acme Portal", workspaceId: "ws-1" });
    const s = scheduler();

    await notifyAnalysisComplete(
      { analysisId: "an-1", projectId: "pr-1", targetUserId: "u1" },
      { db, schedule: s.schedule },
    );

    expect(s.calls).toHaveLength(1);
    expect(s.calls[0].eventType).toBe(EVENT_ANALYSIS_COMPLETE);
  });

  it("FAILS OPEN and sends when the preference lookup throws", async () => {
    const db = dbWithProject({ name: "Acme Portal", workspaceId: "ws-1" });
    const s = scheduler();
    prefFindMany.mockRejectedValue(new Error("db down"));

    await notifyAnalysisComplete(
      { analysisId: "an-1", projectId: "pr-1", targetUserId: "u1" },
      { db, schedule: s.schedule },
    );

    expect(s.calls).toHaveLength(1);
  });

  it("never consults preferences for a workspace-broadcast card (no targetUserId — exemption policy)", async () => {
    const db = dbWithProject({ name: "Acme Portal", workspaceId: "ws-1" });
    const s = scheduler();
    // Even a disabled row must not suppress a broadcast card.
    prefFindMany.mockResolvedValue([
      { channel: "teams", event: "analysisCompleted", enabled: false },
    ]);

    await notifyAnalysisComplete(
      { analysisId: "an-1", projectId: "pr-1" },
      { db, schedule: s.schedule },
    );

    expect(s.calls).toHaveLength(1);
    expect(prefFindMany).not.toHaveBeenCalled();
  });
});

describe("notifyPublishRolledBack (#67)", () => {
  it("schedules a publish-rolled-back card with the reason", async () => {
    const db = dbWithProject({ name: "Acme", workspaceId: "ws-1" });
    const s = scheduler();
    await notifyPublishRolledBack(
      {
        batchId: "b-1",
        projectId: "pr-1",
        reason: "auto-rollback: 3/5 failed",
        repo: "acme/portal",
      },
      { db, schedule: s.schedule },
    );
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0].eventType).toBe(EVENT_PUBLISH_ROLLED_BACK);
    expect(s.calls[0].activity.text).toContain("rolled back");
  });

  it("no-ops when the project has no workspace", async () => {
    const db = dbWithProject({ name: "P", workspaceId: null });
    const s = scheduler();
    await notifyPublishRolledBack(
      { batchId: "b-1", projectId: "pr-1", reason: "r" },
      { db, schedule: s.schedule },
    );
    expect(s.schedule).not.toHaveBeenCalled();
  });
});

describe("notifyPublishRolledBack — preference enforcement (#614)", () => {
  it("suppresses a user-targeted card when the user disabled teams × issuesPublished", async () => {
    const db = dbWithProject({ name: "Acme", workspaceId: "ws-1" });
    const s = scheduler();
    prefFindMany.mockResolvedValue([
      { channel: "teams", event: "issuesPublished", enabled: false },
    ]);

    await notifyPublishRolledBack(
      { batchId: "b-1", projectId: "pr-1", reason: "r", targetUserId: "u1" },
      { db, schedule: s.schedule },
    );

    expect(s.schedule).not.toHaveBeenCalled();
    expect(prefFindMany).toHaveBeenCalledWith({
      where: { userId: "u1", channel: "teams", event: "issuesPublished" },
    });
  });

  it("sends a user-targeted card when the preference is enabled (default)", async () => {
    const db = dbWithProject({ name: "Acme", workspaceId: "ws-1" });
    const s = scheduler();

    await notifyPublishRolledBack(
      { batchId: "b-1", projectId: "pr-1", reason: "r", targetUserId: "u1" },
      { db, schedule: s.schedule },
    );

    expect(s.calls).toHaveLength(1);
    expect(s.calls[0].eventType).toBe(EVENT_PUBLISH_ROLLED_BACK);
  });
});

describe("notifyBudgetExceeded (#67)", () => {
  const payload = {
    workspaceName: "Eng",
    ruleName: "90% projected",
    basis: "projected",
    spendCents: 11200,
    budgetCents: 10000,
    ratio: 1.12,
  };

  it("schedules a budget-exceeded card for the workspace directly", () => {
    const s = scheduler();
    notifyBudgetExceeded("ws-1", payload, { db: dbWithProject(null), schedule: s.schedule });
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0].workspaceId).toBe("ws-1");
    expect(s.calls[0].eventType).toBe(EVENT_BUDGET_EXCEEDED);
    expect(s.calls[0].activity.text).toContain("112%");
  });

  it("no-ops on a blank workspaceId", () => {
    const s = scheduler();
    notifyBudgetExceeded("", payload, { db: dbWithProject(null), schedule: s.schedule });
    expect(s.schedule).not.toHaveBeenCalled();
  });

  it("is EXEMPT BY DESIGN from user preferences — schedules without ever consulting them (#614)", () => {
    const s = scheduler();
    // A disabled row must be irrelevant: budget cards are workspace-level
    // ops-critical alerts and are never preference-suppressed.
    prefFindMany.mockResolvedValue([{ channel: "teams", event: "systemAlerts", enabled: false }]);

    notifyBudgetExceeded("ws-1", payload, { db: dbWithProject(null), schedule: s.schedule });

    expect(s.calls).toHaveLength(1);
    expect(prefFindMany).not.toHaveBeenCalled();
  });

  it("swallows a render error (never throws into the alert engine)", () => {
    // Force a failure by passing a scheduler that throws.
    const throwingSchedule = vi.fn(() => {
      throw new Error("boom");
    });
    expect(() =>
      notifyBudgetExceeded("ws-1", payload, {
        db: dbWithProject(null),
        schedule: throwingSchedule,
      }),
    ).not.toThrow();
  });
});
