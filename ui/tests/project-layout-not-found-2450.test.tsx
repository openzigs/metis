/**
 * #2450 — a project the viewer cannot open (absent, or in another workspace)
 * 404s on read. The Overview rendered "Page not found", but every sub-page
 * (`/analysis`, `/requirements`, …) rendered the project shell with a heading
 * stuck on "loading…" and forms whose every call 404'd. The project layout now
 * sends a 404 to the shared not-found boundary for every sub-page.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { ApiError } from "@/lib/api-client";
import { makeWrapper } from "./test-utils";

const notFound = vi.fn();
const getProject = vi.fn();

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useParams: () => ({ id: "p-other" }),
  usePathname: () => "/projects/p-other/analysis",
  notFound: () => notFound(),
}));
vi.mock("@/lib/projects-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/projects-api")>();
  return { ...actual, projectsApi: { ...actual.projectsApi, get: (id: string) => getProject(id) } };
});

vi.mock("@/components/projects/project-tabs", () => ({
  ProjectTabs: () => <nav>project tabs</nav>,
}));

const { default: ProjectLayout } = await import("@/app/(authed)/projects/[id]/layout");

function renderLayout() {
  const Wrapper = makeWrapper({ withAuth: false });
  return render(
    <Wrapper>
      <ProjectLayout>
        <p>sub-page body</p>
      </ProjectLayout>
    </Wrapper>,
  );
}

afterEach(() => vi.clearAllMocks());

describe("ProjectLayout (#2450)", () => {
  it("renders the not-found boundary for a project the viewer cannot open", async () => {
    getProject.mockRejectedValue(new ApiError(404, "Project not found", "NOT_FOUND"));
    renderLayout();
    await waitFor(() => expect(notFound).toHaveBeenCalled());
    expect(getProject).toHaveBeenCalledWith("p-other");
  });

  it("renders the tabs and the sub-page for a project the viewer can open", async () => {
    getProject.mockResolvedValue({ id: "p-other", name: "Payments", status: "active" });
    renderLayout();
    expect(screen.getByText("project tabs")).toBeInTheDocument();
    expect(screen.getByText("sub-page body")).toBeInTheDocument();
    await waitFor(() => expect(getProject).toHaveBeenCalled());
    expect(notFound).not.toHaveBeenCalled();
  });

  it("does not treat a server error as not found", async () => {
    getProject.mockRejectedValue(new ApiError(500, "boom"));
    renderLayout();
    await waitFor(() => expect(getProject).toHaveBeenCalled());
    // Let the rejected query settle before asserting nothing threw to the boundary.
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByText("sub-page body")).toBeInTheDocument();
    expect(notFound).not.toHaveBeenCalled();
  });
});
