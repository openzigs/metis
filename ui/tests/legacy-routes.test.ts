/**
 * #31 — every route retired by "one home per concept" redirects to that home.
 */
import { describe, expect, it } from "vitest";
import { legacyRedirect } from "@/lib/legacy-routes";

describe("legacyRedirect", () => {
  it.each([
    ["/admin", "/settings"],
    ["/admin/workspaces", "/settings/workspaces"],
    ["/admin/workspaces/ws-1/settings", "/settings/workspaces/ws-1"],
    ["/admin/auth", "/settings/auth"],
    ["/admin/embeddings", "/settings/embeddings"],
    ["/admin/mcp", "/settings/mcp?tab=servers"],
    ["/admin/usage", "/settings/usage?scope=platform"],
    ["/admin/skills", "/library?tab=skills"],
    ["/skills", "/library?tab=skills"],
    ["/admin/agents", "/library?tab=agents"],
    ["/agents", "/library?tab=agents"],
    ["/settings/agents", "/library?tab=agents"],
    ["/projects/p1/usage", "/settings/usage?scope=project&projectId=p1"],
    ["/workspaces/ws-1/finops", "/settings/usage?scope=workspace&workspaceId=ws-1"],
  ])("sends %s to %s", (from, to) => {
    expect(legacyRedirect(from)).toBe(to);
  });

  it("sends an unknown admin sub-page to the merged Settings area", () => {
    expect(legacyRedirect("/admin/nope/deeper")).toBe("/settings");
  });

  it("tolerates a trailing slash", () => {
    expect(legacyRedirect("/admin/auth/")).toBe("/settings/auth");
  });

  it("carries the caller's query through, with the target's own keys winning", () => {
    expect(legacyRedirect("/admin/skills", { projectId: "p9", tab: "templates" })).toBe(
      "/library?tab=skills&projectId=p9",
    );
  });

  it("keeps only the first value of a repeated query key and drops empty ones", () => {
    expect(legacyRedirect("/agents", { projectId: ["a", "b"], q: undefined })).toBe(
      "/library?tab=agents&projectId=a",
    );
  });

  it("encodes a project id taken from the path", () => {
    expect(legacyRedirect("/projects/a%20b/usage")).toBe(
      "/settings/usage?scope=project&projectId=a+b",
    );
  });

  it("passes a path it does not know through unchanged", () => {
    expect(legacyRedirect("/vault")).toBe("/vault");
  });
});
