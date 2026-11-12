/**
 * #2334 (epic #2328) — the project tab bar follows the analyst's job:
 *
 *   Overview · Knowledge · Change requests · Requirements · Deliverables · ⚙
 *
 * Every primary tab is a direct link (one click lands on the section), the
 * section's other pages sit in a visible sub-nav (a second click), and there is
 * no "More" overflow menu. No project route moved, so every existing URL still
 * resolves — the route-inventory test below reads the real `app/` tree to prove
 * each one maps to a section.
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
const USAGE = "/settings/usage?scope=project&projectId=p1";

const SIX_TABS = [
  "Overview",
  "Knowledge",
  "Change requests",
  "Requirements",
  "Deliverables",
  "Project settings",
];

describe("getProjectTabModel — the analyst's job (#2334)", () => {
  it("has exactly six primary tabs, in the job's order", () => {
    const model = getProjectTabModel("p1");
    expect(model.sections.map((s) => s.label)).toEqual(SIX_TABS);
    expect(model.sections.map((s) => s.id)).toEqual([
      "overview",
      "knowledge",
      "change-requests",
      "requirements",
      "deliverables",
      "settings",
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
    expect(items.knowledge).toEqual([
      ["Connections", `${B}/connections`],
      ["Documents", `${B}/documents`],
    ]);
    expect(items["change-requests"]).toEqual([
      ["Requirements Analysis", `${B}/analysis`],
      ["Import", `${B}/import`],
      ["Jira", `${B}/jira`],
      ["Impact Analysis", `${B}/impact`],
    ]);
    expect(items.requirements).toEqual([
      ["Review", `${B}/requirements`],
      ["Baselines", `${B}/baselines`],
      ["Discussions", `${B}/discussions`],
      ["Compare analyses", `${B}/changes`],
    ]);
    expect(items.deliverables).toEqual([
      ["Documentation", `${B}/documentation`],
      ["Templates", `${B}/settings/templates`],
      ["Publish", `${B}/publish`],
    ]);
    expect(items.settings).toEqual([
      ["General", `${B}/settings`],
      ["Models", `${B}/settings/models`],
      ["Plugins", `${B}/plugins`],
      ["Usage", USAGE],
      ["Code Overview", `${B}/overview`],
      ["Pull Requests", `${B}/pulls`],
      ["Spec Kit", `${B}/spec-kit`],
    ]);
  });

  it("lands each primary tab on the first page of its section (one click)", () => {
    const model = getProjectTabModel("p1");
    const hrefs = Object.fromEntries(model.sections.map((s) => [s.id, s.href]));
    expect(hrefs).toEqual({
      overview: B,
      knowledge: `${B}/connections`,
      "change-requests": `${B}/analysis`,
      requirements: `${B}/requirements`,
      deliverables: `${B}/documentation`,
      settings: `${B}/settings`,
    });
    for (const section of model.sections.slice(1)) {
      expect(section.items[0].href, section.id).toBe(section.href);
    }
  });

  it("puts the code views and planning tools under ⚙ and nowhere else", () => {
    const model = getProjectTabModel("p1");
    for (const label of ["Code Overview", "Pull Requests", "Models", "Plugins", "Spec Kit"]) {
      const owners = model.sections.filter((s) => s.items.some((i) => i.label === label));
      expect(
        owners.map((s) => s.id),
        label,
      ).toEqual(["settings"]);
    }
    expect(model.sections.map((s) => s.label)).not.toContain("Code");
  });

  it("labels Change Analysis so it cannot be read as a change request", () => {
    const model = getProjectTabModel("p1");
    const requirements = model.sections.find((s) => s.id === "requirements");
    const changes = requirements?.items.find((i) => i.href === `${B}/changes`);
    expect(changes?.label).toBe("Compare analyses");
    expect(changes?.label).not.toMatch(/change/i);
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

  it("keeps every page the old tab bar reached, at the same URL, two clicks away", () => {
    const model = getProjectTabModel("p1");
    // A primary tab is one click; a sub-nav item under it is the second.
    const withinTwoClicks = new Set(
      model.sections.flatMap((s) => [s.href, ...s.items.map((i) => i.href)]),
    );
    for (const suffix of [
      "",
      "/connections",
      "/documents",
      "/import",
      "/jira",
      "/analysis",
      "/impact",
      "/spec-kit",
      "/requirements",
      "/baselines",
      "/discussions",
      "/documentation",
      "/settings/templates",
      "/publish",
      "/overview",
      "/changes",
      "/pulls",
      "/settings",
      "/settings/models",
      "/plugins",
    ]) {
      expect(withinTwoClicks, suffix || "/").toContain(`${B}${suffix}`);
    }
    expect(withinTwoClicks).toContain(USAGE);
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

  // Every project route that exists today, with the tab and sub-item it lights.
  it.each([
    ["/connections", "knowledge", "Connections"],
    ["/documents", "knowledge", "Documents"],
    ["/repositories", "knowledge", null],
    ["/analysis", "change-requests", "Requirements Analysis"],
    ["/import", "change-requests", "Import"],
    ["/jira", "change-requests", "Jira"],
    ["/impact", "change-requests", "Impact Analysis"],
    ["/requirements", "requirements", "Review"],
    ["/baselines", "requirements", "Baselines"],
    ["/baselines/b1", "requirements", "Baselines"],
    ["/discussions", "requirements", "Discussions"],
    ["/discussions/d1", "requirements", "Discussions"],
    ["/changes", "requirements", "Compare analyses"],
    ["/documentation", "deliverables", "Documentation"],
    ["/settings/templates", "deliverables", "Templates"],
    ["/publish", "deliverables", "Publish"],
    ["/sync", "deliverables", null],
    ["/settings", "settings", "General"],
    ["/settings/models", "settings", "Models"],
    ["/plugins", "settings", "Plugins"],
    ["/overview", "settings", "Code Overview"],
    ["/pulls", "settings", "Pull Requests"],
    ["/pulls/12", "settings", "Pull Requests"],
    ["/spec-kit", "settings", "Spec Kit"],
    ["/spec-kit/spec.md", "settings", "Spec Kit"],
  ])("%s lights %s › %s", (suffix, section, item) => {
    expect(active(`${B}${suffix}`)).toEqual([section, item]);
  });

  it("prefers the longest match, so Templates is Deliverables even under /settings", () => {
    expect(active(`${B}/settings/templates`)).toEqual(["deliverables", "Templates"]);
    expect(active(`${B}/settings/models`)).toEqual(["settings", "Models"]);
    expect(active(`${B}/settings`)).toEqual(["settings", "General"]);
  });

  it("does not match a sibling that merely shares a prefix", () => {
    expect(active(`${B}/pullstwo`)).toBeNull();
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
    // #31 — `usage` only redirects to Settings → Usage & cost; it is no project page.
    const redirectOnly = new Set(["usage"]);
    for (const rel of routes.filter((r) => !redirectOnly.has(r))) {
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
    expect(isProjectTabActive(`${B}/pulls/123`, `${B}/pulls`, B)).toBe(true);
    expect(isProjectTabActive(`${B}/pullstwo`, `${B}/pulls`, B)).toBe(false);
  });
});

describe("<ProjectTabs />", () => {
  it("renders the six primary tabs as links, in order, with no More menu", () => {
    usePathnameMock.mockReturnValue(B);
    renderTabs();
    const nav = screen.getByRole("navigation", { name: "Project sections" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => l.textContent?.trim())).toEqual(SIX_TABS);
    expect(screen.queryByRole("button", { name: /more project sections/i })).toBeNull();
    expect(screen.queryByTestId("project-tabs-more")).toBeNull();
    expect(nav.querySelector(".overflow-x-auto")).toBeNull();
  });

  it("renders ⚙ as a gear with a text accessible name and a tooltip", () => {
    usePathnameMock.mockReturnValue(B);
    renderTabs();
    const gear = screen.getByTestId("project-tab-settings");
    expect(gear).toHaveAccessibleName("Project settings");
    expect(gear).toHaveAttribute("title", "Project settings");
    expect(gear.querySelector("svg")).not.toBeNull();
    expect(gear).toHaveAttribute("href", `${B}/settings`);
  });

  it("gives no other tab a tooltip", () => {
    usePathnameMock.mockReturnValue(B);
    renderTabs();
    for (const id of ["overview", "knowledge", "change-requests", "requirements", "deliverables"]) {
      expect(screen.getByTestId(`project-tab-${id}`)).not.toHaveAttribute("title");
    }
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
    expect(screen.getByTestId("project-tab-requirements")).toHaveAttribute("aria-current", "true");
    const sub = screen.getByRole("navigation", { name: "Requirements pages" });
    const names = within(sub)
      .getAllByRole("link")
      .map((l) => l.textContent);
    expect(names).toEqual(["Review", "Baselines", "Discussions", "Compare analyses"]);
    expect(within(sub).getByRole("link", { name: "Compare analyses" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(sub).getByRole("link", { name: "Review" })).not.toHaveAttribute("aria-current");
  });

  it("marks a section tab 'page' when its landing page is the current page", () => {
    usePathnameMock.mockReturnValue(`${B}/connections`);
    renderTabs();
    expect(screen.getByTestId("project-tab-knowledge")).toHaveAttribute("aria-current", "page");
    expect(screen.getByTestId("project-tab-overview")).not.toHaveAttribute("aria-current");
  });

  it("lights Deliverables, not ⚙, on /settings/templates", () => {
    usePathnameMock.mockReturnValue(`${B}/settings/templates`);
    renderTabs();
    expect(screen.getByTestId("project-tab-deliverables")).toHaveAttribute("aria-current", "true");
    expect(screen.getByTestId("project-tab-settings")).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("navigation", { name: "Deliverables pages" })).toBeInTheDocument();
  });

  it("shows the ⚙ sub-nav, code views included, on a code page", () => {
    usePathnameMock.mockReturnValue(`${B}/pulls/7`);
    renderTabs();
    expect(screen.getByTestId("project-tab-settings")).toHaveAttribute("aria-current", "true");
    const sub = screen.getByRole("navigation", { name: "Project settings pages" });
    expect(within(sub).getByRole("link", { name: "Pull Requests" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("keeps the section's sub-nav on a route reached from inside it", () => {
    usePathnameMock.mockReturnValue(`${B}/sync`);
    renderTabs();
    expect(screen.getByTestId("project-tab-deliverables")).toHaveAttribute("aria-current", "true");
    const sub = screen.getByRole("navigation", { name: "Deliverables pages" });
    expect(sub.querySelector("[aria-current]")).toBeNull();
  });

  it("renders no current tab on an unknown path", () => {
    usePathnameMock.mockReturnValue(`${B}/nope`);
    renderTabs();
    const nav = screen.getByRole("navigation", { name: "Project sections" });
    expect(nav.querySelector("[aria-current]")).toBeNull();
    expect(screen.queryByTestId("project-subnav")).toBeNull();
  });
});

describe("<ProjectTabs /> — narrow-viewport collapse (R1 #156)", () => {
  it("labels the single trigger with the current page", () => {
    usePathnameMock.mockReturnValue(`${B}/changes`);
    renderTabs();
    const mobile = screen.getByTestId("project-tabs-mobile");
    expect(mobile).toHaveAccessibleName("Project section menu");
    expect(mobile).toHaveTextContent("Compare analyses");
  });

  it("falls back to the section label, then to Overview", () => {
    usePathnameMock.mockReturnValue(`${B}/sync`);
    const { unmount } = renderTabs();
    expect(screen.getByTestId("project-tabs-mobile")).toHaveTextContent("Deliverables");
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
    const menu = screen.getByRole("menu");
    for (const label of SIX_TABS.slice(1)) {
      expect(within(menu).getByText(label)).toBeInTheDocument();
    }
    const count = flattenProjectTabs(getProjectTabModel("p1")).length;
    expect(screen.getAllByRole("menuitem")).toHaveLength(count);
  });
});
