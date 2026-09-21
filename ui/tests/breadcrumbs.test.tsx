/**
 * N7 (#152) — header breadcrumb hierarchy (Workspace › Project).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { makeWrapper } from "./test-utils";
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
});
