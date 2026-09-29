import { describe, expect, it } from "vitest";
import {
  hubForPath,
  isActiveRoute,
  isNavItemActive,
  isTabActive,
  NAV_DESTINATIONS,
  NAV_ITEMS,
  navItemCurrent,
  PALETTE_DESTINATIONS,
  PUBLIC_PATHS,
  visibleTabs,
} from "@/lib/navigation";

const item = (label: string) => {
  const found = NAV_ITEMS.find((i) => i.label === label);
  if (!found) throw new Error(`no nav item ${label}`);
  return found;
};

describe("navigation registry (#27)", () => {
  it("has six object-level sidebar destinations", () => {
    expect(NAV_ITEMS.map((i) => i.label)).toEqual([
      "Home",
      "Projects",
      "Chat",
      "Activity",
      "Library",
      "Settings",
    ]);
  });

  it("keeps every one of the 21 former sidebar routes reachable through a hub tab", () => {
    const former = [
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
      "/scheduler",
      "/runs",
      "/sessions",
      "/vault",
      "/eval/leaderboard",
      "/settings",
      "/admin",
    ];
    // /skills and /agents are redirect stubs into /admin/skills and /admin/agents.
    const hrefs = NAV_DESTINATIONS.map((t) => t.href);
    for (const href of former) expect(hrefs).toContain(href);
  });

  it("groups the cross-project lookups under Projects", () => {
    expect(item("Projects").tabs.map((t) => t.href)).toEqual([
      "/projects",
      "/products",
      "/documents",
      "/repositories",
      "/databases",
      "/impact-analyses",
    ]);
  });

  it("puts Chat and Workbench behind one entry point", () => {
    expect(item("Chat").tabs.map((t) => t.href)).toEqual(["/chat", "/workbench"]);
  });

  it("groups the activity logs under Activity", () => {
    expect(item("Activity").tabs.map((t) => t.href)).toEqual([
      "/tasks",
      "/runs",
      "/sessions",
      "/scheduler",
      "/reviews",
    ]);
  });

  it("each hub lands on its first tab", () => {
    for (const i of NAV_ITEMS) expect(i.href).toBe(i.tabs[0].href);
  });

  it("never lists one page in two hubs", () => {
    const hrefs = NAV_DESTINATIONS.map((t) => t.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
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

describe("isTabActive", () => {
  it("honours exact: the All projects tab is not active inside a project", () => {
    const all = item("Projects").tabs[0];
    expect(isTabActive("/projects", all)).toBe(true);
    expect(isTabActive("/projects/p1", all)).toBe(false);
  });

  it("uses match over href when given", () => {
    const evalTab = item("Settings").tabs.find((t) => t.label === "Eval");
    expect(evalTab).toBeDefined();
    expect(isTabActive("/eval/leaderboard/run-1", evalTab!)).toBe(true);
    expect(isTabActive("/eval/other", evalTab!)).toBe(true);
    expect(isTabActive("/evaluate", evalTab!)).toBe(false);
  });

  it("matches a detail page below a tab", () => {
    const runs = item("Activity").tabs[1];
    expect(isTabActive("/runs/42", runs)).toBe(true);
  });
});

describe("isNavItemActive", () => {
  it("marks the hub active on any of its tabs", () => {
    expect(isNavItemActive("/runs/42", item("Activity"))).toBe(true);
    expect(isNavItemActive("/repositories", item("Projects"))).toBe(true);
    expect(isNavItemActive("/admin/skills", item("Settings"))).toBe(true);
    expect(isNavItemActive("/workbench", item("Chat"))).toBe(true);
  });

  it("marks Projects active inside a project although its tab is exact", () => {
    expect(isNavItemActive("/projects/p1/analysis", item("Projects"))).toBe(true);
  });

  it("is false outside the hub", () => {
    expect(isNavItemActive("/runs", item("Projects"))).toBe(false);
    expect(isNavItemActive("/runs", item("Home"))).toBe(false);
  });
});

describe("navItemCurrent (#366 review)", () => {
  it("is page only where the sidebar entry is the page's sole marker", () => {
    expect(navItemCurrent("/dashboard", item("Home"))).toBe("page");
    expect(navItemCurrent("/library", item("Library"))).toBe("page");
  });

  it("is true (a location, not the page) where a hub tab or project tab names the page", () => {
    expect(navItemCurrent("/repositories", item("Projects"))).toBe("true");
    expect(navItemCurrent("/projects", item("Projects"))).toBe("true");
    expect(navItemCurrent("/projects/p1/analysis", item("Projects"))).toBe("true");
    expect(navItemCurrent("/settings/profile", item("Settings"))).toBe("true");
  });

  it("is absent outside the hub", () => {
    expect(navItemCurrent("/runs", item("Projects"))).toBeUndefined();
  });
});

describe("PALETTE_DESTINATIONS (#366 review)", () => {
  it("keeps the former Skills and Agents entries findable by name", () => {
    const byLabel = new Map(PALETTE_DESTINATIONS.map((t) => [t.label, t.href]));
    expect(byLabel.get("Skills")).toBe("/admin/skills");
    expect(byLabel.get("Agents")).toBe("/admin/agents");
  });

  it("includes every sidebar destination", () => {
    for (const t of NAV_DESTINATIONS) expect(PALETTE_DESTINATIONS).toContain(t);
  });

  it("labels /dashboard Dashboard, matching its page heading", () => {
    expect(PALETTE_DESTINATIONS.find((t) => t.href === "/dashboard")?.label).toBe("Dashboard");
  });
});

describe("visibleTabs", () => {
  it("hides admin-only tabs from non-admins", () => {
    expect(visibleTabs(item("Settings"), false).map((t) => t.label)).toEqual([
      "Settings",
      "Vault",
      "Eval",
    ]);
  });

  it("shows admin-only tabs to admins", () => {
    expect(visibleTabs(item("Settings"), true).map((t) => t.label)).toContain("Admin");
  });
});

describe("hubForPath", () => {
  it("finds the hub owning a tab route", () => {
    expect(hubForPath("/sessions")?.label).toBe("Activity");
    expect(hubForPath("/impact-analyses/new")?.label).toBe("Projects");
    expect(hubForPath("/vault")?.label).toBe("Settings");
  });

  it("returns no hub inside a project, which has its own tab bar", () => {
    expect(hubForPath("/projects/p1")).toBeUndefined();
  });

  it("returns no hub outside the navigation", () => {
    expect(hubForPath("/somewhere-else")).toBeUndefined();
  });
});
