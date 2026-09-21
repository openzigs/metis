/**
 * N2 (#142) — Project tab restructure: ~5 primary tabs + "More" overflow menu.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { usePathname } from "next/navigation";
import {
  ProjectTabs,
  getProjectTabModel,
  flattenProjectTabs,
  isProjectTabActive,
} from "@/components/projects/project-tabs";
import { makeWrapper, TEST_USER } from "./test-utils";
import type { AuthUser } from "@/lib/auth-types";

const usePathnameMock = vi.mocked(usePathname);

// #469 — <ProjectTabs> now reads `useAuth()` to decide whether to show the
// permission-gated "Skills" entry, so it must render inside an AuthProvider.
function renderTabs(projectId = "p1", user: AuthUser | null = TEST_USER) {
  return render(<ProjectTabs projectId={projectId} />, {
    wrapper: makeWrapper({ initialUser: user }),
  });
}

describe("getProjectTabModel", () => {
  it("exposes a small primary set (no horizontal scroll)", () => {
    const model = getProjectTabModel("p1");
    // #371 promoted Spec Kit to a primary tab (6→7); #486 added Discussions as a
    // primary tab beside it (7→8). Still small enough to render without a
    // horizontal scroller; the "More" overflow absorbs the long tail.
    expect(model.primary.length).toBeLessThanOrEqual(8);
  });

  // #371 — Spec Kit is a planning surface, not documentation. It moved out of
  // the "Docs" group to sit beside Analysis as its own primary tab.
  it("surfaces Spec Kit as a primary link, not inside the Docs group", () => {
    const model = getProjectTabModel("p1");
    const docsGroup = model.primary.find((t) => t.kind === "group" && t.label === "Docs");
    expect(docsGroup).toBeDefined();
    // Docs no longer contains Spec Kit.
    if (docsGroup && docsGroup.kind === "group") {
      const docsHrefs = docsGroup.items.map((i) => i.href);
      expect(docsHrefs).not.toContain("/projects/p1/spec-kit");
      // Docs still renders its remaining members.
      expect(docsHrefs).toEqual(["/projects/p1/documentation", "/projects/p1/settings/templates"]);
    }
    // Spec Kit is now a primary link.
    const specKit = model.primary.find(
      (t) => t.kind === "link" && t.href === "/projects/p1/spec-kit",
    );
    expect(specKit).toBeDefined();
    expect(specKit && specKit.kind === "link" && specKit.label).toBe("Spec Kit");
  });

  it("places Spec Kit immediately after Analysis among the primary tabs", () => {
    const model = getProjectTabModel("p1");
    const labels = model.primary.map((t) => t.label);
    const analysisIdx = labels.indexOf("Analysis");
    expect(analysisIdx).toBeGreaterThanOrEqual(0);
    expect(labels[analysisIdx + 1]).toBe("Spec Kit");
  });

  // #486 — Discussions is a project-scoped collaborative room surfaced as a
  // primary tab (not the global sidebar), pointing at `${base}/discussions`.
  it("surfaces Discussions as a primary link after Spec Kit", () => {
    const model = getProjectTabModel("p1");
    const labels = model.primary.map((t) => t.label);
    const specKitIdx = labels.indexOf("Spec Kit");
    expect(specKitIdx).toBeGreaterThanOrEqual(0);
    expect(labels[specKitIdx + 1]).toBe("Discussions");
    const discussions = model.primary.find(
      (t) => t.kind === "link" && t.href === "/projects/p1/discussions",
    );
    expect(discussions).toBeDefined();
  });

  it("keeps /discussions reachable via flattenProjectTabs", () => {
    const model = getProjectTabModel("p1");
    const hrefs = flattenProjectTabs(model).map((l) => l.href);
    expect(hrefs).toContain("/projects/p1/discussions");
  });

  // #371 — the canonical URL is unchanged, so the route must remain reachable
  // through the flattened model (guards against a lost link / accidental rename).
  it("keeps /spec-kit reachable via flattenProjectTabs (no redirect needed)", () => {
    const model = getProjectTabModel("p1");
    const hrefs = flattenProjectTabs(model).map((l) => l.href);
    expect(hrefs).toContain("/projects/p1/spec-kit");
    // The canonical path is preserved, so no next.config redirect is required;
    // this assertion is the guard the issue AC asks for in lieu of a redirect.
  });

  // Epic #609 (#620) — baselines live in the overflow menu.
  it("keeps /baselines reachable via flattenProjectTabs", () => {
    const model = getProjectTabModel("p1");
    const hrefs = flattenProjectTabs(model).map((l) => l.href);
    expect(hrefs).toContain("/projects/p1/baselines");
  });

  it("keeps every original destination reachable", () => {
    const model = getProjectTabModel("p1");
    const hrefs = flattenProjectTabs(model).map((l) => l.href);
    const expected = [
      "/projects/p1",
      "/projects/p1/documents",
      "/projects/p1/analysis",
      "/projects/p1/discussions",
      "/projects/p1/overview",
      "/projects/p1/changes",
      "/projects/p1/pulls",
      "/projects/p1/rule-sets",
      "/projects/p1/scans",
      "/projects/p1/test-coverage",
      "/projects/p1/documentation",
      "/projects/p1/spec-kit",
      "/projects/p1/settings/templates",
      "/projects/p1/connections",
      "/projects/p1/jira",
      "/projects/p1/import",
      "/projects/p1/publish",
      "/projects/p1/plugins",
      "/projects/p1/usage",
    ];
    for (const href of expected) expect(hrefs).toContain(href);
  });
});

describe("isProjectTabActive", () => {
  const base = "/projects/p1";
  it("matches the index only on exact path", () => {
    expect(isProjectTabActive(base, base, base)).toBe(true);
    expect(isProjectTabActive(`${base}/analysis`, base, base)).toBe(false);
  });
  it("matches section prefixes", () => {
    expect(isProjectTabActive(`${base}/scans/123`, `${base}/scans`, base)).toBe(true);
    expect(isProjectTabActive(`${base}/scanstwo`, `${base}/scans`, base)).toBe(false);
  });

  // #371 — active-state for the relocated Spec Kit primary tab.
  it("lights Spec Kit on the canonical route and any sub-path", () => {
    const href = `${base}/spec-kit`;
    expect(isProjectTabActive(`${base}/spec-kit`, href, base)).toBe(true);
    expect(isProjectTabActive(`${base}/spec-kit/spec.md`, href, base)).toBe(true);
    // Sibling Analysis route must not light Spec Kit.
    expect(isProjectTabActive(`${base}/analysis`, href, base)).toBe(false);
  });
});

describe("<ProjectTabs />", () => {
  it("renders primary link tabs and group triggers without a horizontal scroller", () => {
    usePathnameMock.mockReturnValue("/projects/p1");
    renderTabs();
    expect(screen.getByRole("link", { name: "Overview" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Documents" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Analysis" })).toBeInTheDocument();
    // #371 — Spec Kit is now a primary link beside Analysis, not a Docs item.
    expect(screen.getByRole("link", { name: "Spec Kit" })).toBeInTheDocument();
    // #486 — Discussions primary tab.
    expect(screen.getByRole("link", { name: "Discussions" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Code" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Quality" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Docs" })).toBeInTheDocument();
    // No overflow-x-auto scroller on the row.
    const nav = screen.getByTestId("project-tabs");
    expect(nav.querySelector(".overflow-x-auto")).toBeNull();
  });

  it("marks the Code group as active when a child route is active", () => {
    usePathnameMock.mockReturnValue("/projects/p1/changes");
    renderTabs();
    expect(screen.getByRole("button", { name: "Code" })).toHaveAttribute("aria-current", "page");
  });

  it("marks the More overflow as active when a hidden destination is active", () => {
    usePathnameMock.mockReturnValue("/projects/p1/jira");
    renderTabs();
    expect(screen.getByRole("button", { name: /more project sections/i })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("opens the More menu via keyboard and exposes overflow links", async () => {
    usePathnameMock.mockReturnValue("/projects/p1");
    const user = userEvent.setup();
    renderTabs();
    const more = screen.getByRole("button", { name: /more project sections/i });
    more.focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("menuitem", { name: "Connections" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Usage" })).toBeInTheDocument();
  });

  it("opens a group menu and renders its child links", async () => {
    usePathnameMock.mockReturnValue("/projects/p1");
    const user = userEvent.setup();
    renderTabs();
    await user.click(screen.getByRole("button", { name: "Code" }));
    expect(await screen.findByRole("menuitem", { name: "Code Overview" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Pull Requests" })).toBeInTheDocument();
  });

  // #371 — the relocated Spec Kit primary link lights up on its route.
  it("marks the Spec Kit primary link active on /spec-kit and sub-paths", () => {
    usePathnameMock.mockReturnValue("/projects/p1/spec-kit/spec.md");
    renderTabs();
    expect(screen.getByRole("link", { name: "Spec Kit" })).toHaveAttribute("aria-current", "page");
  });

  // #371 — Docs still renders with its remaining members (no Spec Kit).
  it("keeps the Docs group with Documentation and Templates only", async () => {
    usePathnameMock.mockReturnValue("/projects/p1");
    const user = userEvent.setup();
    renderTabs();
    await user.click(screen.getByRole("button", { name: "Docs" }));
    expect(await screen.findByRole("menuitem", { name: "Documentation" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Templates" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Spec Kit" })).not.toBeInTheDocument();
  });
});

// #469 — reachable, permission-gated entry to the per-project skill allowlist.
describe("project skill allowlist entry (#469)", () => {
  const PROJECT_UPDATER: AuthUser = { ...TEST_USER, permissions: ["project.update"] };

  it("omits the Skills entry from the model without project.update", () => {
    const model = getProjectTabModel("p1", { canManageSkills: false });
    const hrefs = flattenProjectTabs(model).map((l) => l.href);
    expect(hrefs).not.toContain("/library?projectId=p1");
  });

  it("adds a Skills entry pointing at /library?projectId when permitted", () => {
    const model = getProjectTabModel("p1", { canManageSkills: true });
    const docsGroup = model.primary.find((t) => t.kind === "group" && t.label === "Docs");
    expect(docsGroup).toBeDefined();
    if (docsGroup && docsGroup.kind === "group") {
      const skills = docsGroup.items.find((i) => i.label === "Skills");
      expect(skills).toBeDefined();
      expect(skills?.href).toBe("/library?projectId=p1");
    }
  });

  it("renders the Skills link for a user holding project.update", async () => {
    usePathnameMock.mockReturnValue("/projects/p1");
    const user = userEvent.setup();
    renderTabs("p1", PROJECT_UPDATER);
    await user.click(screen.getByRole("button", { name: "Docs" }));
    const link = await screen.findByRole("menuitem", { name: "Skills" });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "/library?projectId=p1");
  });

  it("hides the Skills link for a user lacking project.update", async () => {
    usePathnameMock.mockReturnValue("/projects/p1");
    const user = userEvent.setup();
    renderTabs("p1", { ...TEST_USER, permissions: [] });
    await user.click(screen.getByRole("button", { name: "Docs" }));
    expect(await screen.findByRole("menuitem", { name: "Documentation" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Skills" })).not.toBeInTheDocument();
  });
});

describe("<ProjectTabs /> — mobile collapse (R1 #156)", () => {
  it("renders a single mobile dropdown trigger labeled with the current section", () => {
    usePathnameMock.mockReturnValue("/projects/p1/changes");
    renderTabs();
    const mobile = screen.getByTestId("project-tabs-mobile");
    expect(mobile).toHaveAccessibleName("Project section menu");
    expect(mobile).toHaveTextContent("Changes");
  });

  it("defaults the mobile label to Overview on the index route", () => {
    usePathnameMock.mockReturnValue("/projects/p1");
    renderTabs();
    expect(screen.getByTestId("project-tabs-mobile")).toHaveTextContent("Overview");
  });

  it("lists every destination in the mobile dropdown when opened", async () => {
    usePathnameMock.mockReturnValue("/projects/p1");
    const user = userEvent.setup();
    renderTabs();
    await user.click(screen.getByTestId("project-tabs-mobile"));
    // Both a primary and an overflow destination are reachable from one menu.
    expect(await screen.findByRole("menuitem", { name: "Code Overview" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Usage" })).toBeInTheDocument();
  });
});
