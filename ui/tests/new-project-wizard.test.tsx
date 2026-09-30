/**
 * #273 — the first-run New-project wizard: name → source → ingest in one dialog,
 * landing on the new project's Overview with the ingest running.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRouter } from "next/navigation";
import { ApiError } from "@/lib/api-client";
import { makeWrapper } from "./test-utils";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/projects-api", () => ({ projectsApi: { create: vi.fn() } }));
vi.mock("@/lib/connectors-api", () => ({ repoConnectorsApi: { deepIngest: vi.fn() } }));
// The REAL active-jobs store, spied on: the Overview reads what the wizard writes.
vi.mock("@/hooks/use-active-jobs", async (orig) => {
  const actual = await orig<typeof import("@/hooks/use-active-jobs")>();
  return { ...actual, applyJobLifecycleEvent: vi.fn(actual.applyJobLifecycleEvent) };
});
vi.mock("@/lib/socket-client", async (orig) => ({
  ...(await orig<typeof import("@/lib/socket-client")>()),
  useSocket: () => null,
}));

import { NewProjectDialog, NewProjectWizard } from "@/components/projects/new-project-wizard";
import { projectsApi } from "@/lib/projects-api";
import { repoConnectorsApi } from "@/lib/connectors-api";
import {
  __resetActiveJobsForTests,
  applyJobLifecycleEvent,
  useActiveJobs,
} from "@/hooks/use-active-jobs";
import { isProjectRepoIngestJob } from "@/lib/project-pipeline";
import { toast } from "sonner";

const create = vi.mocked(projectsApi.create);
const deepIngest = vi.mocked(repoConnectorsApi.deepIngest);
const push = () => vi.mocked(useRouter()).push;

const PROJECT = { id: "p-new", name: "Acme", slug: "acme" };

beforeEach(() => {
  vi.clearAllMocks();
  __resetActiveJobsForTests();
  push().mockClear();
});

function renderWizard(props: { workspaceId?: string | null; onDone?: () => void } = {}) {
  const Wrapper = makeWrapper({});
  return render(
    <Wrapper>
      <NewProjectWizard {...props} />
    </Wrapper>,
  );
}

const next = () => screen.getByRole("button", { name: "Next" });

async function fillName(user: ReturnType<typeof userEvent.setup>, name = "Acme") {
  await user.type(screen.getByLabelText("Name"), name);
  await user.click(next());
}

async function fillRepo(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Owner / Org"), "acme-corp");
  await user.type(screen.getByLabelText("Repository"), "legacy-app");
  await user.click(next());
}

describe("NewProjectWizard", () => {
  it("walks name → source → ingest, marking the current step", async () => {
    const user = userEvent.setup();
    renderWizard();
    const current = () =>
      screen.getByRole("list", { name: "New project steps" }).querySelector("[aria-current]");
    expect(current()).toHaveTextContent("Name");
    expect(next()).toBeDisabled();
    await fillName(user);
    expect(current()).toHaveTextContent("Source");
    await fillRepo(user);
    expect(current()).toHaveTextContent("Ingest");
    expect(screen.getByTestId("wizard-summary")).toHaveTextContent("acme-corp/legacy-app");
    expect(screen.getByTestId("wizard-summary")).toHaveTextContent("acme");
  });

  it("creates the project, starts the ingest and lands on the Overview", async () => {
    const user = userEvent.setup();
    const onDone = vi.fn();
    create.mockResolvedValue({ ...PROJECT, primaryRepo: { id: "c-1" } } as never);
    deepIngest.mockResolvedValue({ jobId: "job-1", connectorId: "c-1", status: "started" });
    renderWizard({ workspaceId: "ws-1", onDone });
    await fillName(user);
    await fillRepo(user);
    await user.click(screen.getByRole("button", { name: "Create and start ingest" }));

    await waitFor(() => expect(push()).toHaveBeenCalledWith("/projects/p-new"));
    expect(create).toHaveBeenCalledWith({
      name: "Acme",
      slug: "acme",
      description: undefined,
      workspaceId: "ws-1",
      primaryRepo: {
        ownerOrOrg: "acme-corp",
        repoName: "legacy-app",
        apiBaseUrl: undefined,
        secretRef: undefined,
      },
    });
    expect(deepIngest).toHaveBeenCalledWith("p-new", "c-1");
    // The Overview reads the running ingest from the active-jobs store.
    expect(applyJobLifecycleEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job-1",
        kind: "repo-ingest",
        projectId: "p-new",
        status: "started",
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("Project created — ingest started");
    expect(onDone).toHaveBeenCalled();
  });

  it("leaves a job in the real store that the Overview counts as this project's ingest", async () => {
    const user = userEvent.setup();
    create.mockResolvedValue({ ...PROJECT, primaryRepo: { id: "c-1" } } as never);
    deepIngest.mockResolvedValue({ jobId: "job-1", connectorId: "c-1", status: "started" });
    renderWizard();
    await fillName(user);
    await fillRepo(user);
    await user.click(screen.getByRole("button", { name: "Create and start ingest" }));
    await waitFor(() => expect(push()).toHaveBeenCalledWith("/projects/p-new"));

    // The same read + predicate `ProjectPipelineOverview` uses for its Ingest stage.
    const jobs = renderHook(() => useActiveJobs()).result.current;
    expect(jobs.filter((j) => isProjectRepoIngestJob(j, "p-new")).map((j) => j.jobId)).toEqual([
      "job-1",
    ]);
    expect(jobs.filter((j) => isProjectRepoIngestJob(j, "p-other"))).toEqual([]);
  });

  it("creates without a source when the user skips it, and starts no ingest", async () => {
    const user = userEvent.setup();
    create.mockResolvedValue({ ...PROJECT, primaryRepo: null } as never);
    renderWizard();
    await fillName(user);
    await user.click(screen.getByLabelText("Skip — add a source later"));
    expect(screen.queryByLabelText("Owner / Org")).not.toBeInTheDocument();
    await user.click(next());
    expect(screen.getByTestId("wizard-summary")).toHaveTextContent("None");
    await user.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() => expect(push()).toHaveBeenCalledWith("/projects/p-new"));
    expect(create.mock.calls[0][0].primaryRepo).toBeUndefined();
    expect(create.mock.calls[0][0].workspaceId).toBeUndefined();
    expect(deepIngest).not.toHaveBeenCalled();
    expect(applyJobLifecycleEvent).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith("Project created");
  });

  // #448 — the wizard used to show a generic "could not be connected" and drop
  // the reason the server now returns in `primaryRepoError` (#428).
  it("names the reason, and starts nothing, when the server could not link the repository", async () => {
    const user = userEvent.setup();
    create.mockResolvedValue({
      ...PROJECT,
      primaryRepo: null,
      primaryRepoError: {
        code: "VAULT_SECRET_NOT_FOUND",
        message: "vault secret 'gh-pat' not found",
      },
    } as never);
    renderWizard();
    await fillName(user);
    await fillRepo(user);
    await user.click(screen.getByRole("button", { name: "Create and start ingest" }));

    await waitFor(() => expect(push()).toHaveBeenCalledWith("/projects/p-new"));
    expect(deepIngest).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledTimes(1);
    const [title, opts] = vi.mocked(toast.warning).mock.calls[0] as unknown as [
      string,
      { description: string; duration: number; action: { label: string; onClick: () => void } },
    ];
    expect(title).toMatch(/repository was not linked/i);
    expect(opts.description).toBe("vault secret 'gh-pat' not found");
    expect(opts.duration).toBeGreaterThanOrEqual(10_000);
    push().mockClear();
    opts.action.onClick();
    expect(push()).toHaveBeenCalledWith("/projects/p-new/connections");
  });

  it("falls back to a generic reason when the server names none", async () => {
    // An answer without `primaryRepoError` (a server from before #428).
    const user = userEvent.setup();
    create.mockResolvedValue({ ...PROJECT, primaryRepo: null } as never);
    renderWizard();
    await fillName(user);
    await fillRepo(user);
    await user.click(screen.getByRole("button", { name: "Create and start ingest" }));

    await waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(1));
    const [, opts] = vi.mocked(toast.warning).mock.calls[0] as unknown as [
      string,
      { description: string },
    ];
    expect(opts.description).toBe(
      "The repository could not be linked. Add it from the project's Connections page.",
    );
  });

  it("still lands on the new project when the ingest fails to start", async () => {
    const user = userEvent.setup();
    create.mockResolvedValue({ ...PROJECT, primaryRepo: { id: "c-1" } } as never);
    deepIngest.mockRejectedValue(new ApiError(403, "Forbidden"));
    renderWizard();
    await fillName(user);
    await fillRepo(user);
    await user.click(screen.getByRole("button", { name: "Create and start ingest" }));

    await waitFor(() => expect(push()).toHaveBeenCalledWith("/projects/p-new"));
    expect(applyJobLifecycleEvent).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringMatching(/ingest did not start: Forbidden/),
    );
  });

  it("returns to the Name step with the server's field error when the slug is taken", async () => {
    const user = userEvent.setup();
    create.mockRejectedValue(
      new ApiError(409, "Conflict", "CONFLICT", {
        fields: [{ field: "slug", message: "Slug already in use" }],
      }),
    );
    renderWizard();
    await fillName(user);
    await fillRepo(user);
    await user.click(screen.getByRole("button", { name: "Create and start ingest" }));

    expect(await screen.findByText("Slug already in use")).toBeInTheDocument();
    expect(screen.getByLabelText("Slug")).toHaveAttribute("aria-invalid", "true");
    expect(push()).not.toHaveBeenCalled();
    expect(deepIngest).not.toHaveBeenCalled();
  });

  it("shows a top-level alert and stays on Ingest for a non-field failure", async () => {
    const user = userEvent.setup();
    create.mockRejectedValue(new ApiError(500, "Server exploded"));
    renderWizard();
    await fillName(user);
    await user.click(screen.getByLabelText("Skip — add a source later"));
    await user.click(next());
    await user.click(screen.getByRole("button", { name: "Create project" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Server exploded");
    expect(screen.getByTestId("wizard-summary")).toBeInTheDocument();
    expect(push()).not.toHaveBeenCalled();
  });

  it("derives the slug from the name and keeps a hand-edited one", async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.type(screen.getByLabelText("Name"), "My Cool Project!");
    expect(screen.getByLabelText("Slug")).toHaveValue("my-cool-project");
    await user.clear(screen.getByLabelText("Slug"));
    await user.type(screen.getByLabelText("Slug"), "custom");
    await user.type(screen.getByLabelText("Name"), " Two");
    expect(screen.getByLabelText("Slug")).toHaveValue("custom");
  });

  it("blocks Next on a malformed slug", async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.type(screen.getByLabelText("Name"), "Acme");
    await user.clear(screen.getByLabelText("Slug"));
    await user.type(screen.getByLabelText("Slug"), "bad slug");
    expect(next()).toBeDisabled();
  });

  it("requires both Owner and Repository, and a URL for the API base", async () => {
    const user = userEvent.setup();
    renderWizard();
    await fillName(user);
    await user.type(screen.getByLabelText("Owner / Org"), "acme-corp");
    expect(next()).toBeDisabled();
    await user.type(screen.getByLabelText("Repository"), "legacy-app");
    expect(next()).toBeEnabled();
    await user.type(screen.getByLabelText("API base URL (optional)"), "not a url");
    expect(next()).toBeDisabled();
    expect(screen.getByText(/https:\/\//)).toBeInTheDocument();
  });

  it("sends the enterprise API base and a trimmed description", async () => {
    const user = userEvent.setup();
    create.mockResolvedValue({ ...PROJECT, primaryRepo: { id: "c-1" } } as never);
    deepIngest.mockResolvedValue({ jobId: "job-1", connectorId: "c-1", status: "started" });
    renderWizard();
    await user.type(screen.getByLabelText("Name"), "Acme");
    await user.type(screen.getByLabelText("Description"), "  Legacy estate ");
    await user.click(next());
    await user.type(screen.getByLabelText("Owner / Org"), "acme-corp");
    await user.type(screen.getByLabelText("Repository"), "legacy-app");
    await user.type(
      screen.getByLabelText("API base URL (optional)"),
      "https://ghe.acme.test/api/v3",
    );
    await user.click(next());
    await user.click(screen.getByRole("button", { name: "Create and start ingest" }));

    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][0]).toMatchObject({
      description: "Legacy estate",
      primaryRepo: { apiBaseUrl: "https://ghe.acme.test/api/v3", secretRef: undefined },
    });
  });

  it("goes Back without losing what was typed", async () => {
    const user = userEvent.setup();
    renderWizard();
    await fillName(user);
    await fillRepo(user);
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByLabelText("Owner / Org")).toHaveValue("acme-corp");
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByLabelText("Name")).toHaveValue("Acme");
  });
});

describe("NewProjectDialog", () => {
  it("opens the wizard, creates in the active workspace, and closes on success", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem("metis.activeWorkspaceId", "ws-9");
    create.mockResolvedValue({ ...PROJECT, primaryRepo: null } as never);
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <NewProjectDialog />
      </Wrapper>,
    );
    expect(screen.queryByTestId("new-project-wizard")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "New project" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await fillName(user);
    await user.click(screen.getByLabelText("Skip — add a source later"));
    await user.click(next());
    await user.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(create.mock.calls[0][0].workspaceId).toBe("ws-9");
    window.localStorage.clear();
  });
});
