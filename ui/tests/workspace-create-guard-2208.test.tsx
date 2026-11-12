/**
 * #2208 — a project must not be created in no workspace without notice.
 *
 * While GET /workspaces is pending or has failed, the validated active
 * workspace is `null` — unknown, not "none". Both create paths (the /projects
 * dialog and the New project wizard) used to send that as no workspace. Create
 * now stays disabled with a notice until the workspaces are read, and an error
 * offers a retry. These run the real pages over a fake API.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ProjectsPage from "@/app/(authed)/projects/page";
import { NewProjectDialog } from "@/components/projects/new-project-wizard";
import {
  ACTIVE_WORKSPACE_STORAGE_KEY,
  useValidatedActiveWorkspaceId,
} from "@/lib/active-workspace";
import { makeWrapper, TEST_USER, userWith } from "./test-utils";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

const WORKSPACES = [{ id: "ws-a", name: "Alpha", slug: "a", logoUrl: null, role: "member" }];

function respond(data: unknown, status = 200) {
  return Promise.resolve({
    ok: status < 400,
    status,
    statusText: status < 400 ? "OK" : "Error",
    text: () =>
      Promise.resolve(
        JSON.stringify(
          status < 400 ? { success: true, data } : { success: false, error: { code: "E" } },
        ),
      ),
  });
}

/** `"pending"` holds GET /workspaces open; a number answers with that status. */
let workspaces: "pending" | number = 200;
let fetchMock: ReturnType<typeof vi.fn>;

function route(input: RequestInfo | URL, init?: RequestInit) {
  const url = new URL(String(input), "http://x");
  if (/\/workspaces$/.test(url.pathname)) {
    if (workspaces === "pending") return new Promise(() => undefined);
    return workspaces === 200 ? respond(WORKSPACES) : respond(null, workspaces);
  }
  if (/\/projects$/.test(url.pathname)) {
    if (init?.method === "POST") {
      return respond({ id: "p-new", name: "Acme", slug: "acme", primaryRepo: null }, 201);
    }
    return respond({ items: [], total: 0, limit: 25, offset: 0 });
  }
  return respond(null, 404);
}

/** The body of every POST /projects, in order. */
const created = () =>
  fetchMock.mock.calls
    .filter(([u, init]) => /\/projects$/.test(String(u)) && init?.method === "POST")
    .map(([, init]) => JSON.parse(String(init.body)) as { workspaceId?: string });

beforeEach(() => {
  window.localStorage.clear();
  workspaces = 200;
  fetchMock = vi.fn(route);
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function openProjectsCreate() {
  const user = userEvent.setup();
  render(<ProjectsPage />, { wrapper: makeWrapper({ initialUser: userWith("project.create") }) });
  await user.click(screen.getByTestId("new-project-button"));
  await user.type(await screen.findByTestId("project-name-input"), "Acme");
  return user;
}

describe("/projects Create waits for the workspaces (#2208)", () => {
  it("is disabled, saying why, while the workspaces load", async () => {
    workspaces = "pending";
    await openProjectsCreate();
    expect(screen.getByTestId("project-create-submit")).toBeDisabled();
    const notice = screen.getByTestId("workspace-status");
    expect(notice).toHaveAttribute("role", "status");
    expect(notice).toHaveTextContent("Loading your workspaces");
  });

  it("is disabled with a retry when the workspaces fail, and creates in the workspace once read", async () => {
    workspaces = 500;
    const user = await openProjectsCreate();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("could not be loaded");
    expect(screen.getByTestId("project-create-submit")).toBeDisabled();

    workspaces = 200;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByTestId("project-create-submit")).toBeEnabled());
    expect(screen.queryByTestId("workspace-status")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("project-create-submit"));
    await waitFor(() => expect(created()).toHaveLength(1));
    expect(created()[0].workspaceId).toBe("ws-a");
  });
});

describe("the New project wizard waits for the workspaces (#2208)", () => {
  it("disables Create with a retry while the workspaces cannot be read", async () => {
    workspaces = 500;
    const user = userEvent.setup();
    render(<NewProjectDialog />, {
      wrapper: makeWrapper({ initialUser: userWith("project.create") }),
    });
    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.type(screen.getByLabelText("Name"), "Acme");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByLabelText("Skip — add a source later"));
    await user.click(screen.getByRole("button", { name: "Next" }));

    expect(await screen.findByTestId("workspace-status")).toHaveTextContent("could not be loaded");
    expect(screen.getByRole("button", { name: "Create project" })).toBeDisabled();

    workspaces = 200;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Create project" })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(created()).toHaveLength(1));
    expect(created()[0].workspaceId).toBe("ws-a");
  });
});

describe("useValidatedActiveWorkspaceId status (#2208)", () => {
  it("reports an error, with no id, when the workspaces cannot be read", async () => {
    workspaces = 500;
    window.localStorage.setItem(ACTIVE_WORKSPACE_STORAGE_KEY, "ws-a");
    const { result } = renderHook(() => useValidatedActiveWorkspaceId(), {
      wrapper: makeWrapper({ initialUser: TEST_USER }),
    });
    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.workspaceId).toBeNull();
  });
});
