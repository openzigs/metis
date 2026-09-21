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

beforeEach(() => mockFetch.mockReset());
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

  it("runCommand sends the command + input", async () => {
    mockFetch.mockResolvedValue({});
    await specKitApi.runCommand("p1", "specify", "build it");
    expect(mockFetch).toHaveBeenLastCalledWith(
      "/projects/p1/spec-kit/commands/specify",
      expect.objectContaining({ method: "POST", body: { input: "build it" } }),
    );
  });
});
