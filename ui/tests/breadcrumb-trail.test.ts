/**
 * #271 — the page-level breadcrumb trail, as data. The component test
 * (`breadcrumbs.test.tsx`) checks the rendered crumbs and `aria-current`.
 */
import { describe, expect, it } from "vitest";
import { leafLabel, pageCrumbs } from "@/lib/breadcrumb-trail";

describe("pageCrumbs (#271)", () => {
  it("ends every trail with exactly one crumb that has no link", () => {
    for (const path of [
      "/dashboard",
      "/settings/profile",
      "/projects/p1",
      "/projects/p1/analysis",
      "/projects/p1/publish",
      "/projects/p1/sync",
      "/projects/p1/baselines/abc123def456ghi789jkl0",
      "/runs/42",
    ]) {
      const crumbs = pageCrumbs(path);
      expect(crumbs.length, path).toBeGreaterThan(0);
      expect(crumbs[crumbs.length - 1].href, path).toBeUndefined();
      expect(
        crumbs.slice(0, -1).every((c) => c.href),
        path,
      ).toBe(true);
    }
  });

  it("Analyze › Requirements Analysis on the analysis page", () => {
    expect(pageCrumbs("/projects/p1/analysis/")).toEqual([
      { label: "Analyze", href: "/projects/p1/analysis" },
      { label: "Requirements Analysis" },
    ]);
  });

  it("a route reached from inside a section (issue sync) ends at its own label", () => {
    expect(pageCrumbs("/projects/p1/sync")).toEqual([
      { label: "Publish", href: "/projects/p1/publish" },
      { label: "Sync" },
    ]);
  });

  it("an id-like detail segment is named by its parent", () => {
    expect(pageCrumbs("/projects/p1/baselines/clx0123456789abcdefghijk")).toEqual([
      { label: "Requirements", href: "/projects/p1/requirements" },
      { label: "Baselines", href: "/projects/p1/baselines" },
      { label: "Baseline" },
    ]);
    expect(pageCrumbs("/runs/42")).toEqual([{ label: "Runs", href: "/runs" }, { label: "Run" }]);
  });

  it("a Settings section is named by the settings nav, not its URL segment (#545)", () => {
    expect(pageCrumbs("/settings/mcp")).toEqual([
      { label: "Settings", href: "/settings" },
      { label: "MCP servers" },
    ]);
    expect(pageCrumbs("/settings/api-keys/")).toEqual([
      { label: "Settings", href: "/settings" },
      { label: "Configuration" },
    ]);
    expect(pageCrumbs("/settings")).toEqual([{ label: "Settings" }]);
    // Below a section, the leaf is still the page's own segment.
    expect(pageCrumbs("/settings/integrations/teams")).toEqual([
      { label: "Settings", href: "/settings" },
      { label: "Teams" },
    ]);
  });

  it("is empty for a project route outside the project tabs", () => {
    expect(pageCrumbs("/projects/p1/nowhere")).toEqual([]);
  });

  it("is empty for a route outside the navigation", () => {
    expect(pageCrumbs("/somewhere-else")).toEqual([]);
    expect(pageCrumbs("/")).toEqual([]);
  });
});

describe("leafLabel (#271)", () => {
  it("names detail pages, ids and plain segments", () => {
    expect(leafLabel("42", "pulls")).toBe("#42");
    expect(leafLabel("0f8fad5b-d9cb-469f-a165-70867728950e", "baselines")).toBe("Baseline");
    expect(leafLabel("0f8fad5b-d9cb-469f-a165-70867728950e", "unknown")).toBe("Details");
    expect(leafLabel("spec-kit", undefined)).toBe("Spec kit");
    expect(leafLabel("new", "impact-analyses")).toBe("New");
    const id = "clx0123456789abcdefghijk";
    expect(
      [
        "baselines",
        "discussions",
        "runs",
        "reviews",
        "products",
        "impact-analyses",
        "leaderboard",
        "workspaces",
      ].map((parent) => leafLabel(id, parent)),
    ).toEqual([
      "Baseline",
      "Discussion",
      "Run",
      "Review",
      "Product",
      "Analysis",
      "Run",
      "Workspace",
    ]);
  });

  it("has no detail label for the removed bug-scanner routes (#803)", () => {
    const id = "clx0123456789abcdefghijk";
    expect(leafLabel(id, "scans")).toBe("Details");
    expect(leafLabel(id, "repositories")).toBe("Details");
  });

  it("keeps a segment it cannot decode", () => {
    expect(leafLabel("%E0%A4%A", undefined)).toBe("%E0%A4%A");
  });
});
