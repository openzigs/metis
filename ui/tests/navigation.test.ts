import { describe, expect, it } from "vitest";
import { isActiveRoute, NAV_ITEMS, NAV_SECTIONS, PUBLIC_PATHS } from "@/lib/navigation";

describe("navigation registry", () => {
  it("exposes all 21 sidebar routes derived from grouped sections", () => {
    expect(NAV_ITEMS.map((i) => i.href)).toEqual([
      "/dashboard",
      "/projects",
      "/products",
      "/chat",
      "/workbench",
      "/tasks",
      "/reviews",
      "/library",
      "/documents",
      "/repositories",
      "/databases",
      "/impact-analyses",
      "/skills",
      "/agents",
      "/scheduler",
      "/runs",
      "/sessions",
      "/vault",
      "/eval/leaderboard",
      "/settings",
      "/admin",
    ]);
  });

  it("includes a Sessions entry pointing to /sessions in the Automation group", () => {
    const automation = NAV_SECTIONS.find((s) => s.id === "automation");
    expect(automation).toBeDefined();
    const sessions = automation?.items.find((i) => i.href === "/sessions");
    expect(sessions).toBeDefined();
    expect(sessions?.label).toBe("Sessions");
    expect(sessions?.icon).toBeTruthy();
  });

  it("groups the 21 routes into four labeled sections", () => {
    expect(NAV_SECTIONS.map((s) => s.label)).toEqual([
      "Work",
      "Knowledge",
      "Automation",
      "Platform",
    ]);
    expect(NAV_SECTIONS.flatMap((s) => s.items)).toEqual(NAV_ITEMS);
  });

  it("places each route under the correct section", () => {
    const byId = Object.fromEntries(NAV_SECTIONS.map((s) => [s.id, s.items.map((i) => i.href)]));
    expect(byId.work).toContain("/dashboard");
    expect(byId.work).toContain("/tasks");
    expect(byId.knowledge).toContain("/repositories");
    expect(byId.knowledge).toContain("/databases");
    expect(byId.automation).toContain("/agents");
    expect(byId.platform).toContain("/vault");
    expect(byId.platform).toContain("/admin");
  });

  it("gives every section a unique id", () => {
    const ids = NAV_SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("exposes /login as a public path", () => {
    expect(PUBLIC_PATHS).toContain("/login");
  });
});

describe("isActiveRoute", () => {
  it("matches exact paths", () => {
    expect(isActiveRoute("/projects", "/projects")).toBe(true);
  });

  it("matches nested children of a section", () => {
    expect(isActiveRoute("/projects/abc-123", "/projects")).toBe(true);
  });

  it("does not match unrelated paths that share a prefix", () => {
    expect(isActiveRoute("/projection", "/projects")).toBe(false);
  });

  it("returns false for siblings", () => {
    expect(isActiveRoute("/dashboard", "/projects")).toBe(false);
  });
});
