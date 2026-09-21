/**
 * Epic #594 / Issue #606 — TokenBudgetController unit tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../prisma.js", () => ({
  prisma: {
    tokenBudget: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    aITokenUsage: {
      aggregate: vi.fn(),
    },
  },
}));
vi.mock("../logger.js", () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { prisma } from "../prisma.js";
import {
  TokenBudgetController,
  getTokenBudgetController,
  __resetTokenBudgetControllerSingleton,
} from "./token-budget-controller.js";

const mockFindUnique = prisma.tokenBudget.findUnique as ReturnType<typeof vi.fn>;
const mockFindFirst = prisma.tokenBudget.findFirst as ReturnType<typeof vi.fn>;
const mockAggregate = prisma.aITokenUsage.aggregate as ReturnType<typeof vi.fn>;
const mockUpsert = prisma.tokenBudget.upsert as ReturnType<typeof vi.fn>;
const mockCreate = prisma.tokenBudget.create as ReturnType<typeof vi.fn>;
const mockUpdate = prisma.tokenBudget.update as ReturnType<typeof vi.fn>;

describe("TokenBudgetController", () => {
  let ctrl: TokenBudgetController;

  beforeEach(() => {
    __resetTokenBudgetControllerSingleton();
    ctrl = new TokenBudgetController();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("check — no budgets", () => {
    it("allows when no budget exists for project or user", async () => {
      mockFindUnique.mockResolvedValue(null);
      mockFindFirst.mockResolvedValue(null);
      const result = await ctrl.check("proj-1", "user-1");
      expect(result.allowed).toBe(true);
      expect(result.remainingTokens).toBe(Infinity);
      expect(result.shouldDowngrade).toBe(false);
    });

    it("allows when no projectId and no userId", async () => {
      const result = await ctrl.check();
      expect(result.allowed).toBe(true);
    });
  });

  describe("check — project budget", () => {
    it("allows when usage is below soft threshold", async () => {
      mockFindUnique.mockResolvedValue({
        id: "tb-1",
        projectId: "proj-1",
        dailyTokenLimit: 10000,
        monthlyTokenLimit: null,
        downgradeModel: "haiku",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockAggregate.mockResolvedValue({ _sum: { totalTokens: 5000 } });

      const result = await ctrl.check("proj-1");
      expect(result.allowed).toBe(true);
      expect(result.shouldDowngrade).toBe(false);
      expect(result.percentUsed).toBe(0.5);
      expect(result.remainingTokens).toBe(5000);
    });

    it("triggers soft downgrade at 80%+", async () => {
      mockFindUnique.mockResolvedValue({
        id: "tb-1",
        projectId: "proj-1",
        dailyTokenLimit: 10000,
        monthlyTokenLimit: null,
        downgradeModel: "haiku",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockAggregate.mockResolvedValue({ _sum: { totalTokens: 8500 } });

      const result = await ctrl.check("proj-1");
      expect(result.allowed).toBe(true);
      expect(result.shouldDowngrade).toBe(true);
      expect(result.percentUsed).toBe(0.85);
      expect(result.message).toContain("85%");
      expect(result.message).toContain("haiku");
    });

    it("rejects at 100%+ (hard limit)", async () => {
      mockFindUnique.mockResolvedValue({
        id: "tb-1",
        projectId: "proj-1",
        dailyTokenLimit: 10000,
        monthlyTokenLimit: null,
        downgradeModel: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockAggregate.mockResolvedValue({ _sum: { totalTokens: 10001 } });

      const result = await ctrl.check("proj-1");
      expect(result.allowed).toBe(false);
      expect(result.remainingTokens).toBe(0);
      expect(result.message).toContain("exceeded");
    });
  });

  describe("check — monthly budget", () => {
    it("checks monthly budget when configured", async () => {
      mockFindUnique.mockResolvedValue({
        id: "tb-1",
        projectId: "proj-1",
        dailyTokenLimit: null,
        monthlyTokenLimit: 100000,
        downgradeModel: "haiku",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockAggregate.mockResolvedValue({ _sum: { totalTokens: 85000 } });

      const result = await ctrl.check("proj-1");
      expect(result.allowed).toBe(true);
      expect(result.shouldDowngrade).toBe(true);
      expect(result.percentUsed).toBe(0.85);
    });
  });

  describe("check — user budget", () => {
    it("checks user budget when no project budget", async () => {
      mockFindUnique.mockResolvedValue(null);
      mockFindFirst.mockResolvedValue({
        id: "tb-2",
        projectId: null,
        userId: "user-1",
        dailyTokenLimit: 5000,
        monthlyTokenLimit: null,
        downgradeModel: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockAggregate.mockResolvedValue({ _sum: { totalTokens: 2500 } });

      const result = await ctrl.check(undefined, "user-1");
      expect(result.allowed).toBe(true);
      expect(result.percentUsed).toBe(0.5);
    });
  });

  describe("check — combined budgets (most restrictive wins)", () => {
    it("returns denied result when one budget is exceeded", async () => {
      // Project budget exceeded
      mockFindUnique.mockResolvedValue({
        id: "tb-1",
        projectId: "proj-1",
        dailyTokenLimit: 100,
        monthlyTokenLimit: null,
        downgradeModel: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockFindFirst.mockResolvedValue({
        id: "tb-2",
        projectId: null,
        userId: "user-1",
        dailyTokenLimit: 10000,
        monthlyTokenLimit: null,
        downgradeModel: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockAggregate
        .mockResolvedValueOnce({ _sum: { totalTokens: 200 } }) // project
        .mockResolvedValueOnce({ _sum: { totalTokens: 200 } }); // user

      const result = await ctrl.check("proj-1", "user-1");
      expect(result.allowed).toBe(false);
    });
  });

  describe("setProjectBudget", () => {
    it("upserts a project budget", async () => {
      mockUpsert.mockResolvedValue({ id: "tb-1", projectId: "proj-1", dailyTokenLimit: 5000 });
      const result = await ctrl.setProjectBudget("proj-1", { dailyTokenLimit: 5000 });
      expect(result).toBeDefined();
      expect(mockUpsert).toHaveBeenCalled();
    });
  });

  describe("setUserBudget", () => {
    it("creates a user budget when none exists", async () => {
      mockFindFirst.mockResolvedValue(null);
      mockCreate.mockResolvedValue({ id: "tb-3", userId: "user-1", dailyTokenLimit: 3000 });

      const result = await ctrl.setUserBudget("user-1", { dailyTokenLimit: 3000 });
      expect(result).toBeDefined();
      expect(mockCreate).toHaveBeenCalled();
    });

    it("updates existing user budget", async () => {
      mockFindFirst.mockResolvedValue({ id: "tb-3", userId: "user-1" });
      mockUpdate.mockResolvedValue({ id: "tb-3", userId: "user-1", dailyTokenLimit: 8000 });

      const result = await ctrl.setUserBudget("user-1", { dailyTokenLimit: 8000 });
      expect(result).toBeDefined();
      expect(mockUpdate).toHaveBeenCalled();
    });
  });

  describe("getTokenBudgetController singleton", () => {
    it("returns the same instance", () => {
      const a = getTokenBudgetController();
      const b = getTokenBudgetController();
      expect(a).toBe(b);
    });

    it("resets on __resetTokenBudgetControllerSingleton", () => {
      const a = getTokenBudgetController();
      __resetTokenBudgetControllerSingleton();
      const b = getTokenBudgetController();
      expect(a).not.toBe(b);
    });
  });

  describe("custom soft threshold", () => {
    it("respects custom soft threshold", async () => {
      const customCtrl = new TokenBudgetController(0.5);
      mockFindUnique.mockResolvedValue({
        id: "tb-1",
        projectId: "proj-1",
        dailyTokenLimit: 10000,
        monthlyTokenLimit: null,
        downgradeModel: "haiku",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockAggregate.mockResolvedValue({ _sum: { totalTokens: 6000 } });

      const result = await customCtrl.check("proj-1");
      expect(result.shouldDowngrade).toBe(true);
      expect(result.percentUsed).toBe(0.6);
    });

    it("clamps threshold to [0, 1]", () => {
      const ctrl1 = new TokenBudgetController(-0.5);
      const ctrl2 = new TokenBudgetController(1.5);
      // These should not throw
      expect(ctrl1).toBeDefined();
      expect(ctrl2).toBeDefined();
    });
  });
});
