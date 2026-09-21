/**
 * Epic #594 / Issue #604 — InferenceProfileManager unit tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock prisma before importing the module
vi.mock("../prisma.js", () => ({
  prisma: {
    inferenceProfile: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
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
  InferenceProfileManager,
  inferenceProfileSchema,
  __resetInferenceProfileManagerSingleton,
  getInferenceProfileManager,
} from "./inference-profile-manager.js";

const mockFindUnique = prisma.inferenceProfile.findUnique as ReturnType<typeof vi.fn>;
const mockUpsert = prisma.inferenceProfile.upsert as ReturnType<typeof vi.fn>;
const mockDelete = prisma.inferenceProfile.delete as ReturnType<typeof vi.fn>;

describe("InferenceProfileManager", () => {
  let mgr: InferenceProfileManager;

  beforeEach(() => {
    __resetInferenceProfileManagerSingleton();
    mgr = new InferenceProfileManager();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("get", () => {
    it("returns null when no profile exists", async () => {
      mockFindUnique.mockResolvedValue(null);
      const result = await mgr.get("proj-1");
      expect(result).toBeNull();
      expect(mockFindUnique).toHaveBeenCalledWith({ where: { projectId: "proj-1" } });
    });

    it("returns the profile with parsed tags", async () => {
      mockFindUnique.mockResolvedValue({
        id: "ip-1",
        projectId: "proj-1",
        arn: "arn:aws:bedrock:us-east-1:123456789012:inference-profile/test",
        modelId: "us.anthropic.claude-sonnet-4-20250514-v1:0",
        costCenter: "eng-team",
        environment: "prod",
        tags: '{"team":"platform"}',
        createdAt: new Date("2025-01-01"),
        updatedAt: new Date("2025-01-02"),
      });

      const result = await mgr.get("proj-1");
      expect(result).not.toBeNull();
      expect(result!.tags).toEqual({ team: "platform" });
      expect(result!.arn).toBe("arn:aws:bedrock:us-east-1:123456789012:inference-profile/test");
    });

    it("handles invalid JSON tags gracefully", async () => {
      mockFindUnique.mockResolvedValue({
        id: "ip-1",
        projectId: "proj-1",
        arn: "arn:aws:bedrock:us-east-1:123456789012:test",
        modelId: "model-1",
        costCenter: null,
        environment: null,
        tags: "not-json",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await mgr.get("proj-1");
      expect(result!.tags).toEqual({});
    });
  });

  describe("upsert", () => {
    it("creates/updates an inference profile", async () => {
      mockUpsert.mockResolvedValue({
        id: "ip-1",
        projectId: "proj-1",
        arn: "arn:aws:bedrock:us-east-1:123456789012:inference-profile/test",
        modelId: "claude-sonnet",
        costCenter: "eng",
        environment: "staging",
        tags: '{"cost":"center-1"}',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await mgr.upsert("proj-1", {
        arn: "arn:aws:bedrock:us-east-1:123456789012:inference-profile/test",
        modelId: "claude-sonnet",
        costCenter: "eng",
        environment: "staging",
        tags: { cost: "center-1" },
      });

      expect(result.arn).toBe("arn:aws:bedrock:us-east-1:123456789012:inference-profile/test");
      expect(result.tags).toEqual({ cost: "center-1" });
      expect(mockUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { projectId: "proj-1" },
        }),
      );
    });

    it("defaults optional fields to null", async () => {
      mockUpsert.mockResolvedValue({
        id: "ip-1",
        projectId: "proj-1",
        arn: "arn:aws:bedrock:us-east-1:123456789012:test",
        modelId: "model-1",
        costCenter: null,
        environment: null,
        tags: "{}",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await mgr.upsert("proj-1", {
        arn: "arn:aws:bedrock:us-east-1:123456789012:test",
        modelId: "model-1",
      });

      expect(mockUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            costCenter: null,
            environment: null,
            tags: "{}",
          }),
        }),
      );
    });
  });

  describe("delete", () => {
    it("returns true when profile is deleted", async () => {
      mockDelete.mockResolvedValue({});
      const result = await mgr.delete("proj-1");
      expect(result).toBe(true);
    });

    it("returns false when delete fails", async () => {
      mockDelete.mockRejectedValue(new Error("Not found"));
      const result = await mgr.delete("proj-1");
      expect(result).toBe(false);
    });
  });

  describe("resolveModelId", () => {
    it("returns default model when no projectId", async () => {
      const result = await mgr.resolveModelId(undefined, "default-model");
      expect(result).toBe("default-model");
    });

    it("returns default model when no profile exists", async () => {
      mockFindUnique.mockResolvedValue(null);
      const result = await mgr.resolveModelId("proj-1", "default-model");
      expect(result).toBe("default-model");
    });

    it("returns profile ARN when available", async () => {
      mockFindUnique.mockResolvedValue({
        id: "ip-1",
        projectId: "proj-1",
        arn: "arn:aws:bedrock:us-east-1:123456789012:inference-profile/custom",
        modelId: "model-1",
        costCenter: null,
        environment: null,
        tags: "{}",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const result = await mgr.resolveModelId("proj-1", "default-model");
      expect(result).toBe("arn:aws:bedrock:us-east-1:123456789012:inference-profile/custom");
    });
  });

  describe("getInferenceProfileManager singleton", () => {
    it("returns the same instance", () => {
      const a = getInferenceProfileManager();
      const b = getInferenceProfileManager();
      expect(a).toBe(b);
    });

    it("resets on __resetInferenceProfileManagerSingleton", () => {
      const a = getInferenceProfileManager();
      __resetInferenceProfileManagerSingleton();
      const b = getInferenceProfileManager();
      expect(a).not.toBe(b);
    });
  });
});

describe("inferenceProfileSchema", () => {
  it("validates a valid Bedrock ARN", () => {
    const result = inferenceProfileSchema.safeParse({
      arn: "arn:aws:bedrock:us-east-1:123456789012:inference-profile/test",
      modelId: "claude-sonnet",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid ARN", () => {
    const result = inferenceProfileSchema.safeParse({
      arn: "not-an-arn",
      modelId: "claude-sonnet",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty modelId", () => {
    const result = inferenceProfileSchema.safeParse({
      arn: "arn:aws:bedrock:us-east-1:123456789012:test",
      modelId: "",
    });
    expect(result.success).toBe(false);
  });

  it("accepts optional tags", () => {
    const result = inferenceProfileSchema.safeParse({
      arn: "arn:aws:bedrock:us-east-1:123456789012:test",
      modelId: "model",
      tags: { key: "value" },
    });
    expect(result.success).toBe(true);
  });
});
