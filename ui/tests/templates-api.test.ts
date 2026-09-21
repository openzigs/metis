/**
 * Issue #129 — templates-api client unit tests.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const mockApiFetch = vi.fn();
vi.mock("@/lib/api-client", () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

const { templatesApi } = await import("../src/lib/templates-api");

const schema = {
  name: "Epic",
  platform: "github" as const,
  templateType: "epic" as const,
  sections: [],
};

beforeEach(() => mockApiFetch.mockReset());

describe("templatesApi", () => {
  it("list fetches templates for a project", async () => {
    mockApiFetch.mockResolvedValue([]);
    await templatesApi.list("p1");
    expect(mockApiFetch).toHaveBeenCalledWith("/projects/p1/templates");
  });

  it("get fetches a single template", async () => {
    mockApiFetch.mockResolvedValue({ id: "t1" });
    await templatesApi.get("p1", "t1");
    expect(mockApiFetch).toHaveBeenCalledWith("/projects/p1/templates/t1");
  });

  it("create POSTs the body", async () => {
    mockApiFetch.mockResolvedValue({ id: "t1" });
    await templatesApi.create("p1", {
      name: "Epic",
      platform: "github",
      templateType: "epic",
      schema,
    });
    expect(mockApiFetch).toHaveBeenCalledWith("/projects/p1/templates", {
      method: "POST",
      body: { name: "Epic", platform: "github", templateType: "epic", schema },
    });
  });

  it("update PUTs the body", async () => {
    mockApiFetch.mockResolvedValue({ id: "t1" });
    await templatesApi.update("p1", "t1", { name: "Renamed" });
    expect(mockApiFetch).toHaveBeenCalledWith("/projects/p1/templates/t1", {
      method: "PUT",
      body: { name: "Renamed" },
    });
  });

  it("delete DELETEs the template", async () => {
    mockApiFetch.mockResolvedValue({ deleted: true });
    await templatesApi.delete("p1", "t1");
    expect(mockApiFetch).toHaveBeenCalledWith("/projects/p1/templates/t1", { method: "DELETE" });
  });

  it("propagates errors from apiFetch", async () => {
    mockApiFetch.mockRejectedValueOnce(new Error("boom"));
    await expect(templatesApi.list("p1")).rejects.toThrow("boom");
  });
});
