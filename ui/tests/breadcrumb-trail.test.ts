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
      "/projects/p1/scans/abc123def456ghi789jkl0",
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
    expect(pageCrumbs("/projects/p1/scans/clx0123456789abcdefghijk")).toEqual([
      { label: "Code", href: "/projects/p1/overview" },
      { label: "Bug Scans", href: "/projects/p1/scans" },
      { label: "Scan" },
    ]);
    expect(pageCrumbs("/runs/42")).toEqual([{ label: "Runs", href: "/runs" }, { label: "Run" }]);
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
    expect(leafLabel("test-coverage", undefined)).toBe("Test coverage");
    expect(leafLabel("new", "impact-analyses")).toBe("New");
    const id = "clx0123456789abcdefghijk";
    expect(
      [
        "scans",
        "baselines",
        "discussions",
        "repositories",
        "runs",
        "reviews",
        "products",
        "impact-analyses",
        "leaderboard",
        "workspaces",
      ].map((parent) => leafLabel(id, parent)),
    ).toEqual([
      "Scan",
      "Baseline",
      "Discussion",
      "Repository",
      "Run",
      "Review",
      "Product",
      "Analysis",
      "Run",
      "Workspace",
    ]);
  });

  it("keeps a segment it cannot decode", () => {
    expect(leafLabel("%E0%A4%A", undefined)).toBe("%E0%A4%A");
  });
});
