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
  paletteDestinations,
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
    ];
    // /admin, /skills and /agents redirect to their one home (#31, lib/legacy-routes).
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
    expect(isNavItemActive("/settings/workspaces", item("Settings"))).toBe(true);
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
  it("finds each concept's one home by name (#31)", () => {
    const byLabel = new Map(PALETTE_DESTINATIONS.map((t) => [t.label, t.href]));
    expect(byLabel.get("Skills")).toBe("/library?tab=skills");
    expect(byLabel.get("Agents")).toBe("/library?tab=agents");
    expect(byLabel.get("MCP servers")).toBe("/settings/mcp");
    expect(byLabel.get("Usage & cost")).toBe("/settings/usage");
  });

  it("points no palette entry at a retired Admin route (#31)", () => {
    for (const t of PALETTE_DESTINATIONS) expect(t.href.startsWith("/admin")).toBe(false);
  });

  it("includes every sidebar destination", () => {
    for (const t of NAV_DESTINATIONS) expect(PALETTE_DESTINATIONS).toContain(t);
  });

  it("labels /dashboard Dashboard, matching its page heading", () => {
    expect(PALETTE_DESTINATIONS.find((t) => t.href === "/dashboard")?.label).toBe("Dashboard");
  });
});

describe("paletteDestinations (#368)", () => {
  const withAdminEntries = [
    ...PALETTE_DESTINATIONS,
    { href: "/x-admin", label: "X admin", adminOnly: true },
    { href: "/settings/auth", label: "SSO & authentication" },
    { href: "/settings/embeddings/models", label: "Embedding models" },
  ];

  it("hides adminOnly entries and admin-only Settings sections from non-admins", () => {
    const hrefs = paletteDestinations(false, withAdminEntries).map((t) => t.href);
    expect(hrefs).not.toContain("/x-admin");
    expect(hrefs).not.toContain("/settings/auth");
    expect(hrefs).not.toContain("/settings/embeddings/models");
    for (const t of PALETTE_DESTINATIONS) expect(hrefs).toContain(t.href);
  });

  it("shows every entry to admins", () => {
    expect(paletteDestinations(true, withAdminEntries)).toEqual(withAdminEntries);
  });

  it("defaults to the static palette registry", () => {
    expect(paletteDestinations(true)).toEqual(PALETTE_DESTINATIONS);
    expect(paletteDestinations(false).length).toBeGreaterThan(0);
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
    const hub = {
      ...item("Settings"),
      tabs: [...item("Settings").tabs, { href: "/x", label: "X", adminOnly: true }],
    };
    expect(visibleTabs(hub, true).map((t) => t.label)).toContain("X");
    expect(visibleTabs(hub, false).map((t) => t.label)).not.toContain("X");
  });

  it("gives Settings no separate Admin tab — Admin merged into Settings (#31)", () => {
    expect(visibleTabs(item("Settings"), true).map((t) => t.label)).toEqual([
      "Settings",
      "Vault",
      "Eval",
    ]);
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
