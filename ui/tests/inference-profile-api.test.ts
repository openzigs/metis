/**
 * Issue #127 — Inference-profile API client unit tests.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const mockApiFetch = vi.fn();
vi.mock("@/lib/api-client", () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

const { inferenceProfileApi } = await import("../src/lib/inference-profile-api");

describe("inferenceProfileApi", () => {
  beforeEach(() => mockApiFetch.mockReset());

  it("get calls the correct endpoint", async () => {
    mockApiFetch.mockResolvedValue({ profile: null });
    await inferenceProfileApi.get("p1");
    expect(mockApiFetch).toHaveBeenCalledWith("/projects/p1/inference-profile");
  });

  it("update sends a PUT with the body", async () => {
    mockApiFetch.mockResolvedValue({ profile: { id: "ip1" } });
    await inferenceProfileApi.update("p1", {
      arn: "arn:aws:bedrock:us-east-1:1:inference-profile/x",
      modelId: "m",
    });
    expect(mockApiFetch).toHaveBeenCalledWith("/projects/p1/inference-profile", {
      method: "PUT",
      body: { arn: "arn:aws:bedrock:us-east-1:1:inference-profile/x", modelId: "m" },
    });
  });
});
