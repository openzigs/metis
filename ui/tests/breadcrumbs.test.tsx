/**
 * N7 (#152) — header breadcrumb hierarchy (Workspace › Project).
 * #271 — extended down to the page: Workspace › Project › Section › Page, with
 * `aria-current="page"` on the last crumb only (it used to sit on the project
 * crumb on every project sub-page).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { makeWrapper, TEST_USER } from "./test-utils";
import type { AuthUser } from "@/lib/auth-types";
import { usePathname } from "next/navigation";

vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return { ...actual, apiFetch: vi.fn() };
});

vi.mock("@/lib/projects-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/projects-api")>("@/lib/projects-api");
  return { ...actual, projectsApi: { ...actual.projectsApi, list: vi.fn() } };
});

import { apiFetch } from "@/lib/api-client";
import { projectsApi } from "@/lib/projects-api";
import { Breadcrumbs } from "@/components/layout/breadcrumbs";

const apiFetchMock = apiFetch as unknown as ReturnType<typeof vi.fn>;
const listMock = projectsApi.list as unknown as ReturnType<typeof vi.fn>;
const usePathnameMock = vi.mocked(usePathname);

beforeEach(() => {
  apiFetchMock.mockReset();
  listMock.mockReset();
  // WorkspaceSwitcher fetches /workspaces.
  apiFetchMock.mockResolvedValue([
    { id: "w1", name: "Acme", slug: "acme", logoUrl: null, role: "admin" },
  ]);
});

describe("<Breadcrumbs />", () => {
  it("renders an accessible breadcrumb nav with both crumbs when projects exist", async () => {
    usePathnameMock.mockReturnValue("/dashboard");
    listMock.mockResolvedValue({ items: [{ id: "p1", name: "Proj One", status: "active" }] });
    render(<Breadcrumbs />, { wrapper: makeWrapper({}) });

    const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(nav).toBeInTheDocument();
    // Project crumb appears once the projects query resolves.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /active project/i })).toBeInTheDocument(),
    );
    // Marks the deepest crumb as the current page.
    expect(nav.querySelector('[aria-current="page"]')).not.toBeNull();
  });

  it("degrades to workspace-only when there is no project context", async () => {
    usePathnameMock.mockReturnValue("/dashboard");
    listMock.mockResolvedValue({ items: [] });
    render(<Breadcrumbs />, { wrapper: makeWrapper({}) });
    await waitFor(() =>
      expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: /active project/i })).not.toBeInTheDocument();
  });

  it("shows the project crumb on a project route even before the list resolves", async () => {
    usePathnameMock.mockReturnValue("/projects/p1");
    listMock.mockResolvedValue({ items: [] });
    render(<Breadcrumbs />, { wrapper: makeWrapper({}) });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /active project/i })).toBeInTheDocument(),
    );
  });

  describe("down to the page (#271)", () => {
    beforeEach(() => {
      listMock.mockResolvedValue({ items: [{ id: "p1", name: "Proj One", status: "active" }] });
    });

    /** Renders at `path` and returns the crumbs after the two switchers. */
    async function crumbsAt(path: string, initialUser: AuthUser | null = null) {
      usePathnameMock.mockReturnValue(path);
      render(<Breadcrumbs />, { wrapper: makeWrapper({ initialUser }) });
      const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /active project/i })).toBeInTheDocument(),
      );
      const current = Array.from(nav.querySelectorAll('[aria-current="page"]'));
      const links = Array.from(nav.querySelectorAll('[data-slot="breadcrumb-link"]')).map((a) => [
        a.textContent,
        a.getAttribute("href"),
      ]);
      return { nav, current, links };
    }

    it("section › page on a sub-nav page; only the page is current", async () => {
      const { current, links } = await crumbsAt("/projects/p1/connections");
      expect(current).toHaveLength(1);
      expect(current[0]).toHaveTextContent("Connections");
      expect(links).toEqual([["Knowledge", "/projects/p1/connections"]]);
    });

    it("never marks the project switcher as the current page", async () => {
      const { nav } = await crumbsAt("/projects/p1/impact");
      const projectCrumb = screen.getByRole("button", { name: /active project/i }).closest("li");
      expect(projectCrumb).not.toHaveAttribute("aria-current");
      expect(projectCrumb?.querySelector("[aria-current]")).toBeNull();
      expect(nav.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    });

    it("the page crumb is the LAST crumb", async () => {
      const { nav, current } = await crumbsAt("/projects/p1/settings/templates");
      const items = Array.from(nav.querySelectorAll('[data-slot="breadcrumb-item"]'));
      expect(items[items.length - 1]).toContainElement(current[0] as HTMLElement);
      // /settings/templates belongs to Deliverables, not to ⚙ Project settings.
      expect(current[0]).toHaveTextContent("Templates");
      expect(screen.getByRole("link", { name: "Deliverables" })).toHaveAttribute(
        "href",
        "/projects/p1/documentation",
      );
    });

    it("a section's landing page still names its section", async () => {
      const { current, links } = await crumbsAt("/projects/p1/documentation");
      expect(current[0]).toHaveTextContent("Documentation");
      expect(links).toEqual([["Deliverables", "/projects/p1/documentation"]]);
    });

    it("the project index ends at Overview", async () => {
      const { current } = await crumbsAt("/projects/p1");
      expect(current).toHaveLength(1);
      expect(current[0]).toHaveTextContent("Overview");
    });

    it("a detail page links its list page and ends at the detail", async () => {
      const { current, links } = await crumbsAt("/projects/p1/pulls/42");
      expect(links).toEqual([
        ["Project settings", "/projects/p1/settings"],
        ["Pull Requests", "/projects/p1/pulls"],
      ]);
      expect(current).toHaveLength(1);
      expect(current[0]).toHaveTextContent("#42");
    });

    it("a route reached from inside a section ends at its own label", async () => {
      const { current, links } = await crumbsAt("/projects/p1/sync");
      expect(links).toEqual([
        ["Deliverables", "/projects/p1/documentation"],
        ["Publish", "/projects/p1/publish"],
      ]);
      expect(current[0]).toHaveTextContent("Issue updates");
    });

    it("outside a project, the page is the sidebar entry and is the only current crumb", async () => {
      const { current } = await crumbsAt("/settings/profile");
      expect(current).toHaveLength(1);
      expect(current[0]).toHaveTextContent("Profile");
      expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
    });

    it("on a run's page, links Runs for an admin only (#2370)", async () => {
      const admin = await crumbsAt("/runs/42", { ...TEST_USER, role: "admin" });
      expect(admin.links).toEqual([["Runs", "/runs"]]);
      expect(admin.current[0]).toHaveTextContent("Run");
    });

    it("on a run's page, names Runs without a link a non-admin would be refused (#2370)", async () => {
      const { nav, current, links } = await crumbsAt("/runs/42", {
        ...TEST_USER,
        role: "developer",
      });
      expect(links).toEqual([]);
      expect(nav).toHaveTextContent("Runs");
      expect(current[0]).toHaveTextContent("Run");
    });
  });
});
