import { describe, expect, it } from "vitest";
import {
  hubForPath,
  isActiveRoute,
  isNavItemActive,
  isAdminOnlyPath,
  isAdminOnlyTabPath,
  isTabActive,
  NAV_DESTINATIONS,
  NAV_ITEMS,
  navItemCurrent,
  PALETTE_DESTINATIONS,
  paletteDestinations,
  PUBLIC_PATHS,
  visibleNavItems,
  visibleTabs,
} from "@/lib/navigation";

const item = (label: string) => {
  const found = NAV_ITEMS.find((i) => i.label === label);
  if (!found) throw new Error(`no nav item ${label}`);
  return found;
};

describe("navigation registry (#27)", () => {
  it("has seven object-level sidebar destinations, Reviews where its Activity tab sat (#2332)", () => {
    expect(NAV_ITEMS.map((i) => i.label)).toEqual([
      "Home",
      "Projects",
      "Chat",
      "Activity",
      "Reviews",
      "Library",
      "Settings",
    ]);
  });

  // #2332 — an admin keeps the same pages in the same order: Reviews left the
  // Activity tab bar for the sidebar, and nothing else moved.
  it("lists every page in the order it had before Reviews moved (#2332)", () => {
    expect(NAV_DESTINATIONS.map((t) => t.href)).toEqual([
      "/dashboard",
      "/projects",
      "/portfolio",
      "/documents",
      "/impact-analyses",
      "/chat",
      "/workbench",
      "/tasks",
      "/runs",
      "/sessions",
      "/scheduler",
      "/reviews",
      "/library",
      "/settings",
      "/vault",
      "/eval/leaderboard",
    ]);
  });

  it("keeps every one of the 21 former sidebar routes reachable through a hub tab", () => {
    const former = [
      "/dashboard",
      "/projects",
      "/chat",
      "/workbench",
      "/tasks",
      "/reviews",
      "/library",
      "/documents",
      "/impact-analyses",
      "/scheduler",
      "/runs",
      "/sessions",
      "/vault",
      "/eval/leaderboard",
      "/settings",
    ];
    // /admin, /skills and /agents redirect to their one home (#31, lib/legacy-routes);
    // /products lands on Portfolio, and /repositories and /databases on the
    // project list or a project's Knowledge tab (#2353, legacy-routes.test.ts).
    const hrefs = NAV_DESTINATIONS.map((t) => t.href);
    for (const href of former) expect(hrefs).toContain(href);
  });

  it("groups the cross-project lookups under Projects", () => {
    expect(item("Projects").tabs.map((t) => t.href)).toEqual([
      "/projects",
      "/portfolio",
      "/documents",
      "/impact-analyses",
    ]);
  });

  // #2353 — Products and Portfolio coverage are one Portfolio tab; the global
  // Repositories and Databases catalogues are gone (each project's Knowledge
  // tab lists its own).
  it("shows one Portfolio tab and no Products, Repositories or Databases tab (#2353)", () => {
    expect(item("Projects").tabs.map((t) => t.label)).toEqual([
      "All projects",
      "Portfolio",
      "Documents",
      "Impact analyses",
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
    ]);
  });

  it("gives Reviews a sidebar entry of its own (#2332)", () => {
    expect(item("Reviews").href).toBe("/reviews");
    expect(item("Reviews").tabs.map((t) => t.href)).toEqual(["/reviews"]);
  });

  it("marks the operations and developer pages admin-only, and nothing else (#2332)", () => {
    expect(NAV_DESTINATIONS.filter((t) => t.adminOnly).map((t) => t.href)).toEqual([
      "/tasks",
      "/runs",
      "/scheduler",
      "/vault",
      "/eval/leaderboard",
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

  // #2353 — a product's page kept its URL; the Portfolio tab that absorbed the
  // Products list owns it.
  it("lights Portfolio on a product's page, through its routes", () => {
    const portfolio = item("Projects").tabs.find((t) => t.label === "Portfolio")!;
    expect(isTabActive("/portfolio", portfolio)).toBe(true);
    expect(isTabActive("/portfolio/pa-1", portfolio)).toBe(true);
    expect(isTabActive("/products/p1", portfolio)).toBe(true);
    expect(isTabActive("/productsx", portfolio)).toBe(false);
    expect(hubForPath("/products/p1")?.label).toBe("Projects");
  });
});

describe("isNavItemActive", () => {
  it("marks the hub active on any of its tabs", () => {
    expect(isNavItemActive("/runs/42", item("Activity"))).toBe(true);
    expect(isNavItemActive("/portfolio", item("Projects"))).toBe(true);
    expect(isNavItemActive("/products/p1", item("Projects"))).toBe(true);
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
    expect(navItemCurrent("/portfolio", item("Projects"))).toBe("true");
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

  // #2353 — the palette offers the merged Portfolio tab, to an analyst too,
  // and none of the four pages it replaced.
  it("offers Portfolio and none of the removed Projects tabs (#2353)", () => {
    for (const isAdmin of [true, false]) {
      const entries = paletteDestinations(isAdmin);
      expect(entries.filter((t) => t.href === "/portfolio").map((t) => t.label)).toEqual([
        "Portfolio",
      ]);
      for (const removed of ["/products", "/repositories", "/databases"]) {
        expect(entries.map((t) => t.href)).not.toContain(removed);
      }
      for (const label of ["Products", "Portfolio coverage", "Repositories", "Databases"]) {
        expect(entries.map((t) => t.label)).not.toContain(label);
      }
    }
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
    for (const t of PALETTE_DESTINATIONS) {
      if (!isAdminOnlyPath(t.href)) expect(hrefs).toContain(t.href);
    }
  });

  // #2332 — the palette offers a non-admin none of the pages the shell hides.
  it("offers a non-admin no operations or developer page", () => {
    const hrefs = paletteDestinations(false).map((t) => t.href);
    for (const hidden of [
      "/tasks",
      "/runs",
      "/scheduler",
      "/vault",
      "/eval/leaderboard",
      "/settings/mcp",
    ]) {
      expect(hrefs).not.toContain(hidden);
    }
    for (const kept of ["/reviews", "/sessions", "/settings", "/settings/usage", "/chat"]) {
      expect(hrefs).toContain(kept);
    }
    expect(paletteDestinations(true).map((t) => t.href)).toContain("/settings/mcp");
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
  it("hides admin-only tabs from non-admins (#2332)", () => {
    expect(visibleTabs(item("Settings"), false).map((t) => t.label)).toEqual(["Settings"]);
    expect(visibleTabs(item("Activity"), false).map((t) => t.label)).toEqual(["Sessions"]);
  });

  it("shows an admin every Activity tab", () => {
    expect(visibleTabs(item("Activity"), true).map((t) => t.label)).toEqual([
      "Tasks",
      "Runs",
      "Sessions",
      "Scheduler",
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

describe("visibleNavItems (#2332)", () => {
  it("gives an admin every entry unchanged, in order", () => {
    expect(visibleNavItems(true)).toEqual(NAV_ITEMS);
  });

  it("gives a non-admin every entry, each landing on a page they may open", () => {
    const items = visibleNavItems(false);
    expect(items.map((i) => i.label)).toEqual(NAV_ITEMS.map((i) => i.label));
    for (const i of items) {
      expect(i.href).toBe(i.tabs[0].href);
      for (const t of i.tabs) expect(isAdminOnlyPath(t.href)).toBe(false);
    }
    // Activity lands on Sessions, the one page of it a non-admin keeps (#2350).
    expect(items.find((i) => i.label === "Activity")?.href).toBe("/sessions");
    expect(items.find((i) => i.label === "Settings")?.tabs.map((t) => t.href)).toEqual([
      "/settings",
    ]);
  });

  it("drops a hub left with no page the user may open", () => {
    const ops = {
      ...item("Activity"),
      tabs: [{ href: "/tasks", label: "Tasks", adminOnly: true }],
    };
    expect(visibleNavItems(false, [item("Home"), ops]).map((i) => i.label)).toEqual(["Home"]);
    expect(visibleNavItems(true, [item("Home"), ops]).map((i) => i.label)).toEqual([
      "Home",
      "Activity",
    ]);
  });
});

describe("isAdminOnlyTabPath (#2332)", () => {
  it.each(["/tasks", "/runs", "/scheduler", "/vault", "/eval/leaderboard", "/eval/leaderboard/r1"])(
    "refuses %s",
    (path) => expect(isAdminOnlyTabPath(path)).toBe(true),
  );

  it("refuses the pages below an admin-only tab", () => {
    expect(isAdminOnlyTabPath("/tasks/t1")).toBe(true);
    expect(isAdminOnlyTabPath("/scheduler/j1")).toBe(true);
  });

  // A project's PR reviews link a non-admin to the run that reviewed the PR.
  it("leaves a run's own page open below the Runs list", () => {
    expect(isAdminOnlyTabPath("/runs/42")).toBe(false);
    expect(isAdminOnlyTabPath("/runs/42/review")).toBe(false);
  });

  it.each(["/sessions", "/reviews", "/reviews/r1", "/dashboard", "/settings", "/runsheet"])(
    "leaves %s open",
    (path) => expect(isAdminOnlyTabPath(path)).toBe(false),
  );
});

describe("isAdminOnlyPath (#2332)", () => {
  it("covers admin-only hub pages and admin-only Settings sections", () => {
    expect(isAdminOnlyPath("/vault")).toBe(true);
    expect(isAdminOnlyPath("/settings/mcp")).toBe(true);
    expect(isAdminOnlyPath("/settings/hooks")).toBe(true);
    expect(isAdminOnlyPath("/settings/usage")).toBe(false);
    expect(isAdminOnlyPath("/portfolio")).toBe(false);
  });

  it("ignores a query string or fragment", () => {
    expect(isAdminOnlyPath("/settings/mcp?tab=registry")).toBe(true);
    expect(isAdminOnlyPath("/vault#top")).toBe(true);
    expect(isAdminOnlyPath("/library?tab=skills")).toBe(false);
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
