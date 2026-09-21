/**
 * Issue #58 — screen-reader audit for the Projects index page.
 *
 * The Projects page is coverage-excluded (thin Next client wrapper), but its
 * screen-reader affordances are an explicit acceptance criterion for the SR
 * audit, so they are asserted here:
 *   - a single top-level heading names the page,
 *   - each project card exposes a level-2 heading (navigable by heading),
 *   - the load-failure message is an assertive live region (role="alert") so
 *     SR users hear it instead of silently seeing red text.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { makeWrapper } from "./test-utils";

vi.mock("@/lib/projects-api", () => ({
  projectsApi: {
    list: vi.fn(),
    remove: vi.fn(),
  },
}));

import { projectsApi } from "@/lib/projects-api";
import ProjectsPage from "@/app/(authed)/projects/page";

const listMock = vi.mocked(projectsApi.list);

function renderPage() {
  render(<ProjectsPage />, { wrapper: makeWrapper({ withAuth: false }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe("ProjectsPage — screen-reader affordances (#58)", () => {
  it("exposes an h1 and a level-2 heading per project card", async () => {
    listMock.mockResolvedValue({
      items: [
        { id: "p1", name: "Alpha", slug: "alpha", status: "active", description: null },
        { id: "p2", name: "Beta", slug: "beta", status: "active", description: null },
      ],
      total: 2,
      limit: 50,
      offset: 0,
    } as unknown as Awaited<ReturnType<typeof projectsApi.list>>);

    renderPage();

    expect(screen.getByRole("heading", { level: 1, name: "Projects" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { level: 2, name: "Alpha" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Beta" })).toBeInTheDocument();
    // The per-card overflow control has an accessible name (icon-only button).
    expect(screen.getAllByRole("button", { name: "Project actions" }).length).toBe(2);
  });

  it("announces a load failure as an alert", async () => {
    listMock.mockRejectedValue(new Error("boom"));
    renderPage();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Failed to load projects.");
  });
});
