/**
 * Smoke tests for the spec-kit-api client (Epic #193).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api-client", () => ({
  apiFetch: vi.fn(),
  ApiError: class extends Error {},
}));

import { apiFetch } from "@/lib/api-client";
import { specKitApi } from "@/lib/spec-kit-api";

const mockFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch.mockReset();
});
afterEach(() => vi.clearAllMocks());

describe("specKitApi", () => {
  it("getEnabled hits /enabled", async () => {
    mockFetch.mockResolvedValue({ enabled: true });
    await specKitApi.getEnabled("p1");
    expect(mockFetch).toHaveBeenCalledWith("/projects/p1/spec-kit/enabled");
  });

  it("setEnabled sends PUT with body", async () => {
    mockFetch.mockResolvedValue({ enabled: false });
    await specKitApi.setEnabled("p1", false);
    expect(mockFetch).toHaveBeenCalledWith(
      "/projects/p1/spec-kit/enabled",
      expect.objectContaining({ method: "PUT", body: { enabled: false } }),
    );
  });

  it("listFiles + getFile + putFile + deleteFile build the right paths", async () => {
    mockFetch.mockResolvedValue({});
    await specKitApi.listFiles("p1");
    expect(mockFetch).toHaveBeenLastCalledWith("/projects/p1/spec-kit/files");

    await specKitApi.getFile("p1", "spec.md");
    expect(mockFetch).toHaveBeenLastCalledWith("/projects/p1/spec-kit/files/spec.md");

    await specKitApi.putFile("p1", "plan.md", "X");
    expect(mockFetch).toHaveBeenLastCalledWith(
      "/projects/p1/spec-kit/files/plan.md",
      expect.objectContaining({ method: "PUT", body: { content: "X" } }),
    );

    await specKitApi.deleteFile("p1", "tasks.md");
    expect(mockFetch).toHaveBeenLastCalledWith(
      "/projects/p1/spec-kit/files/tasks.md",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("generateConstitution sends overrides when provided", async () => {
    mockFetch.mockResolvedValue({});
    await specKitApi.generateConstitution("p1", "must be fast");
    expect(mockFetch).toHaveBeenLastCalledWith(
      "/projects/p1/spec-kit/constitution",
      expect.objectContaining({ method: "POST", body: { projectOverrides: "must be fast" } }),
    );
  });

  it("runCommand posts to the speckit.* route with the input and options", async () => {
    mockFetch.mockResolvedValue({});
    await specKitApi.runCommand("p1", "speckit.specify", { input: "build it" });
    expect(mockFetch).toHaveBeenLastCalledWith(
      "/projects/p1/spec-kit/commands/speckit.specify",
      expect.objectContaining({ method: "POST", body: { input: "build it" } }),
    );
    await specKitApi.runCommand("p1", "speckit.taskstoissues", {
      featureSlug: "001-a",
      dryRun: true,
    });
    expect(mockFetch).toHaveBeenLastCalledWith(
      "/projects/p1/spec-kit/commands/speckit.taskstoissues",
      expect.objectContaining({
        method: "POST",
        body: { input: "", featureSlug: "001-a", dryRun: true },
      }),
    );
  });

  // #789 — the per-feature surface.
  it("feature routes build the right paths and encode the slug and key", async () => {
    mockFetch.mockResolvedValue({});
    await specKitApi.listFeatures("p1", true);
    expect(mockFetch).toHaveBeenLastCalledWith(
      "/projects/p1/spec-kit/features?includeArchived=true",
    );
    await specKitApi.listFeatures("p1", false);
    expect(mockFetch).toHaveBeenLastCalledWith("/projects/p1/spec-kit/features");
    await specKitApi.listFeatureArtifacts("p1", "001-a b");
    expect(mockFetch).toHaveBeenLastCalledWith(
      "/projects/p1/spec-kit/features/001-a%20b/artifacts",
    );
    await specKitApi.featureStatus("p1", "001-a");
    expect(mockFetch).toHaveBeenLastCalledWith("/projects/p1/spec-kit/features/001-a/status");
    await specKitApi.archiveFeature("p1", "001-a");
    expect(mockFetch).toHaveBeenLastCalledWith(
      "/projects/p1/spec-kit/features/001-a/archive",
      expect.objectContaining({ method: "POST" }),
    );
    await specKitApi.restoreFeature("p1", "001-a");
    expect(mockFetch).toHaveBeenLastCalledWith(
      "/projects/p1/spec-kit/features/001-a/restore",
      expect.objectContaining({ method: "POST" }),
    );
    // A nested key keeps its `/` separators, each segment encoded.
    await specKitApi.deleteFeatureArtifact("p1", "001-a", "contracts/api v1.yaml");
    expect(mockFetch).toHaveBeenLastCalledWith(
      "/projects/p1/spec-kit/features/001-a/artifacts/contracts/api%20v1.yaml",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});
