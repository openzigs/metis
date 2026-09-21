/**
 * Epic #594 / Issue #607 — UsageService unit tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../prisma.js", () => ({
  prisma: {
    aITokenUsage: {
      findMany: vi.fn(),
    },
  },
}));

import { prisma } from "../prisma.js";
import { UsageService, getUsageService, __resetUsageServiceSingleton } from "./usage-service.js";

const mockFindMany = prisma.aITokenUsage.findMany as ReturnType<typeof vi.fn>;

function makeRow(
  overrides: Partial<{
    dayBucket: string;
    provider: string;
    model: string;
    userId: string;
    projectId: string | null;
    agentStep: string | null;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    estimatedCostUsd: number | null;
  }> = {},
) {
  return {
    dayBucket: "2025-01-15",
    provider: "bedrock",
    model: "claude-sonnet",
    userId: "user-1",
    projectId: null,
    agentStep: null,
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    estimatedCostUsd: 0.001,
    ...overrides,
  };
}

describe("UsageService", () => {
  let svc: UsageService;

  beforeEach(() => {
    __resetUsageServiceSingleton();
    svc = new UsageService();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("projectUsage", () => {
    it("returns summary with aggregated rows", async () => {
      mockFindMany.mockResolvedValue([
        makeRow({ dayBucket: "2025-01-15", totalTokens: 100, estimatedCostUsd: 0.001 }),
        makeRow({ dayBucket: "2025-01-15", totalTokens: 200, estimatedCostUsd: 0.002 }),
        makeRow({ dayBucket: "2025-01-16", totalTokens: 300, estimatedCostUsd: 0.003 }),
      ]);

      const result = await svc.projectUsage("proj-1", { range: "7d", groupBy: "day" });
      expect(result.totalTokens).toBe(600);
      expect(result.totalCostUsd).toBeCloseTo(0.006);
      // Two day buckets
      expect(result.rows).toHaveLength(2);
    });

    it("returns empty when no data", async () => {
      mockFindMany.mockResolvedValue([]);
      const result = await svc.projectUsage("proj-1");
      expect(result.totalTokens).toBe(0);
      expect(result.rows).toHaveLength(0);
    });

    // Issue #428 — the detail/by-agent-step views queried AITokenUsage by the
    // direct `projectId` column only. Chat traffic writes those rows with
    // projectId=null, associating them to the project ONLY via the session
    // relation, so the detail view showed "No data" while the KPI/by-provider
    // aggregates (sourced from TokenUsage with a non-null projectId) showed
    // data. The query must match rows by direct projectId OR session.projectId.
    it("matches rows by direct projectId OR session.projectId (#428)", async () => {
      mockFindMany.mockResolvedValue([]);
      await svc.projectUsage("proj-1", { range: "7d", groupBy: "day" });
      const callArg = mockFindMany.mock.calls[0][0];
      expect(callArg.where).toEqual(
        expect.objectContaining({
          OR: [{ projectId: "proj-1" }, { session: { projectId: "proj-1" } }],
        }),
      );
      // The direct `projectId: "proj-1"` equality filter must NOT be present at
      // the top level — that is exactly what dropped the session-only rows.
      expect(callArg.where.projectId).toBeUndefined();
    });

    it("surfaces session-only rows (projectId=null) so detail matches aggregates (#428)", async () => {
      // Simulate the real chat write path: AITokenUsage rows with projectId
      // null, associated to the project purely via the session relation. Once
      // the OR filter is in place Prisma returns these rows, so the detail view
      // is populated for the same window the aggregates are populated.
      mockFindMany.mockResolvedValue([
        makeRow({ projectId: null, agentStep: "chat", totalTokens: 137_514 }),
      ]);
      const result = await svc.projectUsage("proj-1", { groupBy: "agentStep" });
      expect(result.totalTokens).toBe(137_514);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].agentStep).toBe("chat");
    });

    it("groups by user", async () => {
      mockFindMany.mockResolvedValue([
        makeRow({ userId: "user-a", totalTokens: 40 }),
        makeRow({ userId: "user-b", totalTokens: 60 }),
        makeRow({ userId: "user-a", totalTokens: 10 }),
      ]);
      const result = await svc.projectUsage("proj-1", { groupBy: "user" });
      expect(result.rows).toHaveLength(2);
      const userA = result.rows.find((r) => r.userId === "user-a");
      expect(userA!.totalTokens).toBe(50);
    });

    it("groups by model", async () => {
      mockFindMany.mockResolvedValue([
        makeRow({ model: "haiku", totalTokens: 50 }),
        makeRow({ model: "sonnet", totalTokens: 200 }),
        makeRow({ model: "haiku", totalTokens: 100 }),
      ]);

      const result = await svc.projectUsage("proj-1", { groupBy: "model" });
      expect(result.rows).toHaveLength(2);
      const haikuRow = result.rows.find((r) => r.model === "haiku");
      expect(haikuRow!.totalTokens).toBe(150);
    });
  });

  describe("adminUsage", () => {
    it("aggregates across projects", async () => {
      mockFindMany.mockResolvedValue([
        makeRow({ projectId: "proj-1", totalTokens: 500 }),
        makeRow({ projectId: "proj-2", totalTokens: 300 }),
      ]);

      const result = await svc.adminUsage({ groupBy: "project" });
      expect(result.rows).toHaveLength(2);
      expect(result.totalTokens).toBe(800);
    });

    it("handles null projectId as 'unassigned'", async () => {
      mockFindMany.mockResolvedValue([makeRow({ projectId: null, totalTokens: 100 })]);

      const result = await svc.adminUsage({ groupBy: "project" });
      expect(result.rows[0].projectId).toBeUndefined();
    });

    it("respects range filter", async () => {
      mockFindMany.mockResolvedValue([]);
      await svc.adminUsage({ range: "90d" });
      expect(mockFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            ts: expect.objectContaining({ gte: expect.any(Date) }),
          }),
        }),
      );
    });

    it("filters by userId", async () => {
      mockFindMany.mockResolvedValue([]);
      await svc.adminUsage({ userId: "user-42" });
      expect(mockFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: "user-42" }),
        }),
      );
    });
  });

  describe("toCSV", () => {
    it("generates valid CSV string", () => {
      const rows = [
        {
          dayBucket: "2025-01-15",
          provider: "bedrock",
          model: "sonnet",
          userId: "user-1",
          projectId: "proj-1",
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
          estimatedCostUsd: 0.001234,
          count: 3,
        },
      ];

      const csv = svc.toCSV(rows);
      const lines = csv.split("\n");
      expect(lines[0]).toContain("dayBucket");
      expect(lines[0]).toContain("estimatedCostUsd");
      expect(lines[1]).toContain("2025-01-15");
      expect(lines[1]).toContain("0.001234");
    });

    it("handles empty rows", () => {
      const csv = svc.toCSV([]);
      const lines = csv.split("\n");
      expect(lines).toHaveLength(1); // header only
    });
  });

  describe("singleton", () => {
    it("returns same instance", () => {
      const a = getUsageService();
      const b = getUsageService();
      expect(a).toBe(b);
    });

    it("resets on __resetUsageServiceSingleton", () => {
      const a = getUsageService();
      __resetUsageServiceSingleton();
      const b = getUsageService();
      expect(a).not.toBe(b);
    });
  });
});
