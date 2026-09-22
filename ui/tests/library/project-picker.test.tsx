/**
 * #28 (epic #26) — Skills are reached from Library, not from a project's Docs
 * tab. The picker is Library's own way into a project's skill allowlist.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { useRouter } from "next/navigation";
import { makeWrapper, TEST_USER } from "../test-utils";

vi.mock("@/lib/projects-api", () => ({ projectsApi: { list: vi.fn() } }));

import { LibraryProjectPicker } from "@/components/library/project-picker";
import { projectsApi } from "@/lib/projects-api";

const listMock = vi.mocked(projectsApi.list);
const replace = vi.mocked(useRouter)().replace as ReturnType<typeof vi.fn>;
const UPDATER = { ...TEST_USER, permissions: ["project.update" as const] };

beforeEach(() => {
  vi.clearAllMocks();
  listMock.mockResolvedValue({
    items: [
      { id: "p1", name: "Alpha" },
      { id: "p 2", name: "Beta" },
    ],
    total: 2,
    limit: 100,
    offset: 0,
  } as never);
});

describe("<LibraryProjectPicker />", () => {
  it("lists projects in a labelled select and reflects the current project", async () => {
    render(<LibraryProjectPicker projectId="p1" />, {
      wrapper: makeWrapper({ initialUser: UPDATER }),
    });
    const select = screen.getByLabelText("Manage skills and agents for");
    await waitFor(() => expect(screen.getByRole("option", { name: "Beta" })).toBeInTheDocument());
    expect(select).toHaveValue("p1");
    expect(listMock).toHaveBeenCalledWith({ limit: 100 });
  });

  it("navigates to the chosen project's allowlist, and back to browse-only", async () => {
    render(<LibraryProjectPicker projectId={null} />, {
      wrapper: makeWrapper({ initialUser: UPDATER }),
    });
    const select = screen.getByTestId("library-project-picker");
    await waitFor(() => expect(select).toBeEnabled());
    fireEvent.change(select, { target: { value: "p 2" } });
    expect(replace).toHaveBeenCalledWith("/library?projectId=p%202");
    fireEvent.change(select, { target: { value: "" } });
    expect(replace).toHaveBeenLastCalledWith("/library");
  });

  it("renders nothing, and fetches nothing, without project.update", () => {
    const { container } = render(<LibraryProjectPicker projectId={null} />, {
      wrapper: makeWrapper({ initialUser: { ...TEST_USER, permissions: [] } }),
    });
    expect(container).toBeEmptyDOMElement();
    expect(listMock).not.toHaveBeenCalled();
  });
});
