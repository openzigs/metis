/**
 * #28 (epic #26) — the project tab bar follows the pipeline, left to right:
 *
 *   Overview · Sources · Analyze · Requirements · Docs · Publish · Code · ⚙
 *
 * Every primary tab is a direct link (one click lands on the section), the
 * section's other pages sit in a visible sub-nav, and the "More" overflow menu
 * is gone. No project route moved, so every existing URL still resolves — the
 * route-inventory test below reads the real `app/` tree to prove each one maps
 * to a section.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { usePathname } from "next/navigation";
import {
  ProjectTabs,
  getProjectTabModel,
  flattenProjectTabs,
  isProjectTabActive,
  resolveActiveProjectTab,
} from "@/components/projects/project-tabs";
import { makeWrapper, TEST_USER } from "./test-utils";

const usePathnameMock = vi.mocked(usePathname);

function renderTabs(projectId = "p1") {
  return render(<ProjectTabs projectId={projectId} />, {
    wrapper: makeWrapper({ initialUser: TEST_USER }),
  });
}

const B = "/projects/p1";

describe("getProjectTabModel — pipeline order (#28)", () => {
  it("orders the primary tabs by the pipeline, left to right", () => {
    const model = getProjectTabModel("p1");
    expect(model.sections.map((s) => s.label)).toEqual([
      "Overview",
      "Sources",
      "Analyze",
      "Requirements",
      "Docs",
      "Publish",
      "Code",
      "Settings",
    ]);
  });

  it("has no overflow menu — every section is a primary tab", () => {
    const model = getProjectTabModel("p1") as unknown as Record<string, unknown>;
    expect(model.overflow).toBeUndefined();
  });

  it("groups each section's pages as the issue specifies", () => {
    const model = getProjectTabModel("p1");
    const items = Object.fromEntries(
      model.sections.map((s) => [s.id, s.items.map((i) => [i.label, i.href])]),
    );
    expect(items.overview).toEqual([]);
    expect(items.sources).toEqual([
      ["Connections", `${B}/connections`],
      ["Documents", `${B}/documents`],
      ["Import", `${B}/import`],
      ["Jira", `${B}/jira`],
    ]);
    expect(items.analyze).toEqual([
      ["Requirements Analysis", `${B}/analysis`],
      ["Impact Analysis", `${B}/impact`],
      ["Spec Kit", `${B}/spec-kit`],
    ]);
    expect(items.requirements).toEqual([
      ["Review", `${B}/requirements`],
      ["Baselines", `${B}/baselines`],
      ["Discussions", `${B}/discussions`],
    ]);
    expect(items.docs).toEqual([
      ["Documentation", `${B}/documentation`],
      ["Templates", `${B}/settings/templates`],
    ]);
    expect(items.publish).toEqual([]);
    expect(items.code).toEqual([
      ["Code Overview", `${B}/overview`],
      ["Changes", `${B}/changes`],
      ["Pull Requests", `${B}/pulls`],
      ["Bug Rules", `${B}/rule-sets`],
      ["Bug Scans", `${B}/scans`],
      ["Test Coverage", `${B}/test-coverage`],
    ]);
    expect(items.settings).toEqual([
      ["General", `${B}/settings`],
      ["Models", `${B}/settings/models`],
      ["Plugins", `${B}/plugins`],
      ["Usage", `${B}/usage`],
    ]);
  });

  it("lands each primary tab on the first step of its section (one click)", () => {
    const model = getProjectTabModel("p1");
    const hrefs = Object.fromEntries(model.sections.map((s) => [s.id, s.href]));
    expect(hrefs).toEqual({
      overview: B,
      sources: `${B}/connections`,
      analyze: `${B}/analysis`,
      requirements: `${B}/requirements`,
      docs: `${B}/documentation`,
      publish: `${B}/publish`,
      code: `${B}/overview`,
      settings: `${B}/settings`,
    });
  });

  it("does not link Skills from any project tab — Skills live in Library", () => {
    const links = flattenProjectTabs(getProjectTabModel("p1"));
    expect(links.some((l) => l.href.startsWith("/library"))).toBe(false);
    expect(links.map((l) => l.label)).not.toContain("Skills");
  });

  it("names exactly one destination 'Overview'", () => {
    const labels = flattenProjectTabs(getProjectTabModel("p1")).map((l) => l.label);
    expect(labels.filter((l) => l === "Overview")).toHaveLength(1);
    expect(labels).toContain("Code Overview");
  });

  it("keeps every pre-#28 destination reachable from the tab bar", () => {
    const hrefs = flattenProjectTabs(getProjectTabModel("p1")).map((l) => l.href);
    for (const suffix of [
      "",
      "/documents",
      "/analysis",
      "/spec-kit",
      "/discussions",
      "/overview",
      "/changes",
      "/pulls",
      "/rule-sets",
      "/scans",
      "/test-coverage",
      "/documentation",
      "/settings/templates",
      "/baselines",
      "/connections",
      "/jira",
      "/import",
      "/publish",
      "/plugins",
      "/usage",
    ]) {
      expect(hrefs).toContain(`${B}${suffix}`);
    }
  });

  it("flattens without duplicate hrefs", () => {
    const hrefs = flattenProjectTabs(getProjectTabModel("p1")).map((l) => l.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});

describe("resolveActiveProjectTab", () => {
  const model = getProjectTabModel("p1");
  const active = (p: string) => {
    const r = resolveActiveProjectTab(p, model);
    return r ? [r.section.id, r.item?.label ?? null] : null;
  };

  it("lights Overview only on the exact project index", () => {
    expect(active(B)).toEqual(["overview", null]);
    expect(active(`${B}/`)).toEqual(["overview", null]);
  });

  it("maps section pages and their sub-paths to the owning section", () => {
    expect(active(`${B}/documents`)).toEqual(["sources", "Documents"]);
    expect(active(`${B}/jira`)).toEqual(["sources", "Jira"]);
    expect(active(`${B}/spec-kit/spec.md`)).toEqual(["analyze", "Spec Kit"]);
    expect(active(`${B}/baselines/b1`)).toEqual(["requirements", "Baselines"]);
    expect(active(`${B}/discussions/d1`)).toEqual(["requirements", "Discussions"]);
    expect(active(`${B}/pulls/12`)).toEqual(["code", "Pull Requests"]);
    expect(active(`${B}/scans/s1`)).toEqual(["code", "Bug Scans"]);
    expect(active(`${B}/test-coverage/connections`)).toEqual(["code", "Test Coverage"]);
  });

  it("prefers the longest match, so Templates is Docs even under /settings", () => {
    expect(active(`${B}/settings/templates`)).toEqual(["docs", "Templates"]);
    expect(active(`${B}/settings/models`)).toEqual(["settings", "Models"]);
    expect(active(`${B}/settings`)).toEqual(["settings", "General"]);
  });

  it("maps routes that are not in the sub-nav to their section", () => {
    expect(active(`${B}/repositories/r1/scanner`)).toEqual(["sources", null]);
    expect(active(`${B}/sync`)).toEqual(["publish", null]);
  });

  it("does not match a sibling that merely shares a prefix", () => {
    expect(active(`${B}/scanstwo`)).toBeNull();
    expect(active("/projects/p2/analysis")).toBeNull();
  });

  // The route inventory: every page.tsx under app/(authed)/projects/[id] must
  // resolve to a tab, so no bookmarked project URL lands outside the nav.
  it("resolves every project route on disk to a section", () => {
    const root = path.resolve(__dirname, "../src/app/(authed)/projects/[id]");
    const routes: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name === "page.tsx") routes.push(path.relative(root, dir));
      }
    };
    walk(root);
    expect(routes.length).toBeGreaterThan(20);
    for (const rel of routes) {
      const url = rel
        ? `${B}/${rel
            .split(path.sep)
            .join("/")
            .replace(/\[[^\]]+\]/g, "x")}`
        : B;
      expect(resolveActiveProjectTab(url, model), url).not.toBeNull();
    }
  });
});

describe("isProjectTabActive", () => {
  it("matches the index only on exact path", () => {
    expect(isProjectTabActive(B, B, B)).toBe(true);
    expect(isProjectTabActive(`${B}/analysis`, B, B)).toBe(false);
  });
  it("matches section prefixes", () => {
    expect(isProjectTabActive(`${B}/scans/123`, `${B}/scans`, B)).toBe(true);
    expect(isProjectTabActive(`${B}/scanstwo`, `${B}/scans`, B)).toBe(false);
  });
});

describe("<ProjectTabs />", () => {
  it("renders the eight primary tabs as links, in order, with no More menu", () => {
    usePathnameMock.mockReturnValue(B);
    renderTabs();
    const nav = screen.getByRole("navigation", { name: "Project sections" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => l.textContent?.trim())).toEqual([
      "Overview",
      "Sources",
      "Analyze",
      "Requirements",
      "Docs",
      "Publish",
      "Code",
      "Settings",
    ]);
    expect(screen.queryByRole("button", { name: /more project sections/i })).toBeNull();
    expect(screen.queryByTestId("project-tabs-more")).toBeNull();
    expect(nav.querySelector(".overflow-x-auto")).toBeNull();
  });

  it("renders the settings tab as a gear icon with an accessible name", () => {
    usePathnameMock.mockReturnValue(B);
    renderTabs();
    const gear = screen.getByTestId("project-tab-settings");
    expect(gear).toHaveAccessibleName("Settings");
    expect(gear.querySelector("svg")).not.toBeNull();
    expect(gear).toHaveAttribute("href", `${B}/settings`);
  });

  it("marks Overview as the current page on the index and shows no sub-nav", () => {
    usePathnameMock.mockReturnValue(B);
    renderTabs();
    expect(screen.getByTestId("project-tab-overview")).toHaveAttribute("aria-current", "page");
    expect(screen.queryByTestId("project-subnav")).toBeNull();
  });

  it("shows the active section's pages in a labelled sub-nav", () => {
    usePathnameMock.mockReturnValue(`${B}/changes`);
    renderTabs();
    // The section tab is marked current-within-set, the page itself as "page".
    expect(screen.getByTestId("project-tab-code")).toHaveAttribute("aria-current", "true");
    const sub = screen.getByRole("navigation", { name: "Code pages" });
    const names = within(sub)
      .getAllByRole("link")
      .map((l) => l.textContent);
    expect(names).toEqual([
      "Code Overview",
      "Changes",
      "Pull Requests",
      "Bug Rules",
      "Bug Scans",
      "Test Coverage",
    ]);
    expect(within(sub).getByRole("link", { name: "Changes" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(sub).getByRole("link", { name: "Pull Requests" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("marks a section tab 'page' when its landing page is the current page", () => {
    usePathnameMock.mockReturnValue(`${B}/connections`);
    renderTabs();
    expect(screen.getByTestId("project-tab-sources")).toHaveAttribute("aria-current", "page");
    expect(screen.getByTestId("project-tab-overview")).not.toHaveAttribute("aria-current");
  });

  it("lights Docs, not Settings, on /settings/templates", () => {
    usePathnameMock.mockReturnValue(`${B}/settings/templates`);
    renderTabs();
    expect(screen.getByTestId("project-tab-docs")).toHaveAttribute("aria-current", "true");
    expect(screen.getByTestId("project-tab-settings")).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("navigation", { name: "Docs pages" })).toBeInTheDocument();
  });

  it("shows no sub-nav for a single-page section", () => {
    usePathnameMock.mockReturnValue(`${B}/publish`);
    renderTabs();
    expect(screen.getByTestId("project-tab-publish")).toHaveAttribute("aria-current", "page");
    expect(screen.queryByTestId("project-subnav")).toBeNull();
  });

  it("renders no current tab on an unknown path", () => {
    usePathnameMock.mockReturnValue(`${B}/nope`);
    renderTabs();
    const nav = screen.getByRole("navigation", { name: "Project sections" });
    expect(nav.querySelector("[aria-current]")).toBeNull();
    expect(screen.queryByTestId("project-subnav")).toBeNull();
  });
});

describe("<ProjectTabs /> — mobile collapse (R1 #156)", () => {
  it("labels the single mobile trigger with the current page", () => {
    usePathnameMock.mockReturnValue(`${B}/changes`);
    renderTabs();
    const mobile = screen.getByTestId("project-tabs-mobile");
    expect(mobile).toHaveAccessibleName("Project section menu");
    expect(mobile).toHaveTextContent("Changes");
  });

  it("falls back to the section label, then to Overview", () => {
    usePathnameMock.mockReturnValue(`${B}/sync`);
    const { unmount } = renderTabs();
    expect(screen.getByTestId("project-tabs-mobile")).toHaveTextContent("Publish");
    unmount();
    usePathnameMock.mockReturnValue(`${B}/nope`);
    renderTabs();
    expect(screen.getByTestId("project-tabs-mobile")).toHaveTextContent("Overview");
  });

  it("lists every destination, grouped by section, when opened", async () => {
    usePathnameMock.mockReturnValue(`${B}/documents`);
    const user = userEvent.setup();
    renderTabs();
    await user.click(screen.getByTestId("project-tabs-mobile"));
    expect(await screen.findByRole("menuitem", { name: "Overview" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Code Overview" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Publish" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Usage" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Documents" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    // Section headings group the menu.
    expect(within(screen.getByRole("menu")).getByText("Sources")).toBeInTheDocument();
    const count = flattenProjectTabs(getProjectTabModel("p1")).length;
    expect(screen.getAllByRole("menuitem")).toHaveLength(count);
  });
});
