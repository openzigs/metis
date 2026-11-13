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
      const crumbs = pageCrumbs(path, true);
      expect(crumbs.length, path).toBeGreaterThan(0);
      expect(crumbs[crumbs.length - 1].href, path).toBeUndefined();
      expect(
        crumbs.slice(0, -1).every((c) => c.href),
        path,
      ).toBe(true);
    }
  });

  it("Change requests › Requirements Analysis on the analysis page (#2334)", () => {
    expect(pageCrumbs("/projects/p1/analysis/", true)).toEqual([
      { label: "Change requests", href: "/projects/p1/analysis" },
      { label: "Requirements Analysis" },
    ]);
  });

  it("names the moved pages by their new tab (#2334)", () => {
    expect(pageCrumbs("/projects/p1/publish", true)).toEqual([
      { label: "Deliverables", href: "/projects/p1/documentation" },
      { label: "Publish" },
    ]);
    expect(pageCrumbs("/projects/p1/changes", true)).toEqual([
      { label: "Requirements", href: "/projects/p1/requirements" },
      { label: "Compare analyses" },
    ]);
    expect(pageCrumbs("/projects/p1/spec-kit", true)).toEqual([
      { label: "Project settings", href: "/projects/p1/settings" },
      { label: "Spec Kit" },
    ]);
  });

  it("a route reached from inside a section (issue sync) ends at its own label", () => {
    // #2381 — issue updates are reached from Publish, so the trail runs through it
    // rather than jumping from Deliverables (which lands on Documentation).
    expect(pageCrumbs("/projects/p1/sync", true)).toEqual([
      { label: "Deliverables", href: "/projects/p1/documentation" },
      { label: "Publish", href: "/projects/p1/publish" },
      { label: "Issue updates" },
    ]);
  });

  it("an id-like detail segment is named by its parent", () => {
    expect(pageCrumbs("/projects/p1/baselines/clx0123456789abcdefghijk", true)).toEqual([
      { label: "Requirements", href: "/projects/p1/requirements" },
      { label: "Baselines", href: "/projects/p1/baselines" },
      { label: "Baseline" },
    ]);
    expect(pageCrumbs("/runs/42", true)).toEqual([
      { label: "Runs", href: "/runs" },
      { label: "Run" },
    ]);
  });

  it("a Settings section is named by the settings nav, not its URL segment (#545)", () => {
    expect(pageCrumbs("/settings/mcp", true)).toEqual([
      { label: "Settings", href: "/settings" },
      { label: "MCP servers" },
    ]);
    expect(pageCrumbs("/settings/api-keys/", true)).toEqual([
      { label: "Settings", href: "/settings" },
      { label: "Configuration" },
    ]);
    expect(pageCrumbs("/settings", true)).toEqual([{ label: "Settings" }]);
    // Below a section, the leaf is still the page's own segment.
    expect(pageCrumbs("/settings/integrations/teams", true)).toEqual([
      { label: "Settings", href: "/settings" },
      { label: "Teams" },
    ]);
  });

  it("names a page a non-admin is refused without linking to it (#2370)", () => {
    // A non-admin may open a run's own page (a project's PR reviews link
    // there), but not the Runs list its crumb leads to (#2332).
    expect(pageCrumbs("/runs/42", false)).toEqual([{ label: "Runs" }, { label: "Run" }]);
    // A crumb they may open keeps its link.
    expect(pageCrumbs("/settings/integrations/teams", false)).toEqual([
      { label: "Settings", href: "/settings" },
      { label: "Teams" },
    ]);
    expect(pageCrumbs("/projects/p1/baselines/clx0123456789abcdefghijk", false)).toEqual([
      { label: "Requirements", href: "/projects/p1/requirements" },
      { label: "Baselines", href: "/projects/p1/baselines" },
      { label: "Baseline" },
    ]);
  });

  // #2353 — Products merged into the Portfolio tab; a product's own page kept
  // its URL and now sits under Portfolio.
  it("runs a product's page and a check through Portfolio (#2353)", () => {
    expect(pageCrumbs("/products/clx0123456789abcdefghijk", false)).toEqual([
      { label: "Portfolio", href: "/portfolio" },
      { label: "Product" },
    ]);
    expect(pageCrumbs("/portfolio/clx0123456789abcdefghijk", false)).toEqual([
      { label: "Portfolio", href: "/portfolio" },
      { label: "Check" },
    ]);
    expect(pageCrumbs("/portfolio", false)).toEqual([{ label: "Portfolio" }]);
  });

  it("is empty for a project route outside the project tabs", () => {
    expect(pageCrumbs("/projects/p1/nowhere", true)).toEqual([]);
  });

  it("is empty for a route outside the navigation", () => {
    expect(pageCrumbs("/somewhere-else", true)).toEqual([]);
    expect(pageCrumbs("/", true)).toEqual([]);
  });
});

describe("leafLabel (#271)", () => {
  it("names detail pages, ids and plain segments", () => {
    expect(leafLabel("42", "pulls")).toBe("#42");
    expect(leafLabel("0f8fad5b-d9cb-469f-a165-70867728950e", "baselines")).toBe("Baseline");
    expect(leafLabel("0f8fad5b-d9cb-469f-a165-70867728950e", "unknown")).toBe("Details");
    expect(leafLabel("spec-kit", undefined)).toBe("Spec kit");
    expect(leafLabel("new", "impact-analyses")).toBe("New");
    // #1626 — one portfolio check.
    expect(leafLabel("clx0123456789abcdefghijk", "portfolio")).toBe("Check");
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
