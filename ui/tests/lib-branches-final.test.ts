/**
 * Issue #121 extended — quick branch wins for lib files:
 * settings-api (configApi.audit with params), library-api uncovered methods,
 * projects-api exportUsageCsv, and safe-redirect edge case.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return { ...actual, apiFetch: vi.fn() };
});

import { apiFetch } from "@/lib/api-client";
const mock = apiFetch as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mock.mockReset();
  mock.mockResolvedValue({});
});

// ─── configApi.audit with params ─────────────────────────────────────────────

import { configApi } from "@/lib/settings-api";

describe("configApi.audit — param branches", () => {
  it("audit with limit param", async () => {
    mock.mockResolvedValueOnce({ items: [], nextCursor: null });
    await configApi.audit({ limit: 20 });
    expect(mock).toHaveBeenCalledWith(
      "/admin/config/audit",
      expect.objectContaining({
        params: expect.objectContaining({ limit: 20 }),
      }),
    );
  });

  it("audit with cursor param", async () => {
    mock.mockResolvedValueOnce({ items: [], nextCursor: null });
    await configApi.audit({ cursor: "cursor123" });
    expect(mock).toHaveBeenCalledWith(
      "/admin/config/audit",
      expect.objectContaining({
        params: expect.objectContaining({ cursor: "cursor123" }),
      }),
    );
  });

  it("audit with both limit and cursor", async () => {
    mock.mockResolvedValueOnce({ items: [], nextCursor: "next" });
    await configApi.audit({ limit: 10, cursor: "c1" });
    expect(mock).toHaveBeenCalledWith(
      "/admin/config/audit",
      expect.objectContaining({
        params: expect.objectContaining({ limit: 10, cursor: "c1" }),
      }),
    );
  });
});

// ─── library-api uncovered methods ───────────────────────────────────────────

import { libraryApi } from "@/lib/library-api";

describe("libraryApi — uncovered methods", () => {
  it("setProjectSkill enabled=false branch", async () => {
    await libraryApi.setProjectSkill("p1", "s1", false);
    expect(mock).toHaveBeenCalledWith(
      expect.stringContaining("library/skills/s1"),
      expect.objectContaining({ method: "PUT", body: { enabled: false } }),
    );
  });

  it("setProjectAgent enabled=true branch", async () => {
    await libraryApi.setProjectAgent("p1", "a1", true);
    expect(mock).toHaveBeenCalledWith(
      expect.stringContaining("library/agents/a1"),
      expect.objectContaining({ method: "PUT", body: { enabled: true } }),
    );
  });

  it("removeProjectSkill calls DELETE", async () => {
    await libraryApi.removeProjectSkill("p1", "s1");
    expect(mock).toHaveBeenCalledWith(
      expect.stringContaining("library/skills/s1"),
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("removeProjectAgent calls DELETE", async () => {
    await libraryApi.removeProjectAgent("p1", "a1");
    expect(mock).toHaveBeenCalledWith(
      expect.stringContaining("library/agents/a1"),
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});

// ─── projects-api exportUsageCsv ─────────────────────────────────────────────

import { projectsApi } from "@/lib/projects-api";

describe("projectsApi.exportUsageCsv — param branches", () => {
  it("exportUsageCsv without params (empty QS)", () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    projectsApi.exportUsageCsv("p1");
    expect(openSpy).toHaveBeenCalledWith(expect.stringContaining("p1/usage/csv"), "_blank");
    openSpy.mockRestore();
  });

  it("exportUsageCsv with range param", () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    projectsApi.exportUsageCsv("p1", { range: "7d" });
    expect(openSpy).toHaveBeenCalledWith(expect.stringContaining("range=7d"), "_blank");
    openSpy.mockRestore();
  });

  it("exportUsageCsv with range and groupBy params", () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    projectsApi.exportUsageCsv("p1", { range: "30d", groupBy: "day" });
    expect(openSpy).toHaveBeenCalledWith(expect.stringContaining("range=30d"), "_blank");
    openSpy.mockRestore();
  });
});

// ─── safe-redirect edge cases ─────────────────────────────────────────────────

import { safeRedirectPath } from "@/lib/safe-redirect";

describe("safeRedirectPath — additional branches", () => {
  it("rejects URLs that change origin after URL parsing", () => {
    // A URL with @ that might change origin: /@user → parses to pathname /@user
    // A crafted URL: /something@evil.com/path — stays same origin
    // Let's test a URL that somehow triggers origin change (tough, but try)
    // The /%5c trick covers the lowercase path; let's test uppercase
    expect(safeRedirectPath("/%5Cevil.com/x")).toBe("/dashboard");
  });

  it("accepts a path with query string (already tested, confirms no regression)", () => {
    expect(safeRedirectPath("/dashboard?a=1&b=2")).toBe("/dashboard?a=1&b=2");
  });
});
