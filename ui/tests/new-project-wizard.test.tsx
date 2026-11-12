/**
 * #273 — the New-project wizard: name → source → create in one dialog, the
 * ingest started in the background.
 *
 * #2349 — the one project-creation flow: it starts on "Documents only" (an
 * analyst with no repository or database is asked for nothing they lack), and
 * its last step offers "New change request" or the project's Overview.
 */
import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
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

import {
  NewProjectDialog,
  NewProjectWizard,
  deriveSlug,
} from "@/components/projects/new-project-wizard";
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

type User = ReturnType<typeof userEvent.setup>;
const next = () => screen.getByRole("button", { name: "Next" });

async function fillName(user: User, name = "Acme") {
  await user.type(screen.getByLabelText("Name"), name);
  await user.click(next());
}

async function fillRepo(user: User) {
  await user.click(screen.getByLabelText("A GitHub repository"));
  await user.type(screen.getByLabelText("Owner / Org"), "acme-corp");
  await user.type(screen.getByLabelText("Repository"), "legacy-app");
  await user.click(next());
}

/** The documents-only path, through Create, to the last step. */
async function createDocumentsOnly(user: User) {
  await fillName(user);
  await user.click(next());
  await user.click(screen.getByRole("button", { name: "Create project" }));
  return screen.findByTestId("wizard-next-step");
}

const current = () =>
  screen.getByRole("list", { name: "New project steps" }).querySelector("[aria-current]");

describe("NewProjectWizard", () => {
  it("walks name → source → create → change request, marking the current step", async () => {
    const user = userEvent.setup();
    create.mockResolvedValue({ ...PROJECT, primaryRepo: { id: "c-1" } } as never);
    deepIngest.mockResolvedValue({ jobId: "job-1", connectorId: "c-1", status: "started" });
    renderWizard();
    expect(current()).toHaveTextContent("Name");
    expect(next()).toBeDisabled();
    await fillName(user);
    expect(current()).toHaveTextContent("Source");
    await fillRepo(user);
    expect(current()).toHaveTextContent("Create");
    expect(screen.getByTestId("wizard-summary")).toHaveTextContent("acme-corp/legacy-app");
    expect(screen.getByTestId("wizard-summary")).toHaveTextContent("acme");
    await user.click(screen.getByRole("button", { name: "Create and start ingest" }));
    await screen.findByTestId("wizard-next-step");
    expect(current()).toHaveTextContent("Change request");
  });

  // #2349 — an analyst with only documents is asked for nothing they lack.
  it("starts on Documents only, asking for no repository or database", async () => {
    const user = userEvent.setup();
    renderWizard();
    await fillName(user);
    expect(screen.getByLabelText("Documents only")).toBeChecked();
    expect(screen.queryByLabelText("Owner / Org")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(next()).toBeEnabled();
    await user.click(next());
    expect(screen.getByTestId("wizard-summary")).toHaveTextContent("Documents only");
    expect(screen.getByRole("button", { name: "Create project" })).toBeEnabled();
  });

  it("creates a documents-only project, starts no ingest, and offers the next step", async () => {
    const user = userEvent.setup();
    const onDone = vi.fn();
    create.mockResolvedValue({ ...PROJECT, primaryRepo: null } as never);
    renderWizard({ onDone });
    const last = await createDocumentsOnly(user);

    expect(create.mock.calls[0][0].primaryRepo).toBeUndefined();
    expect(create.mock.calls[0][0].workspaceId).toBeUndefined();
    expect(deepIngest).not.toHaveBeenCalled();
    expect(applyJobLifecycleEvent).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith("Project created");
    expect(last).toHaveTextContent("Acme is created.");
    expect(last).not.toHaveTextContent("being ingested");
    // Nothing navigates until the user picks where to go.
    expect(push()).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("goes to New change request from the last step", async () => {
    const user = userEvent.setup();
    const onDone = vi.fn();
    create.mockResolvedValue({ ...PROJECT, primaryRepo: null } as never);
    renderWizard({ onDone });
    await createDocumentsOnly(user);
    await user.click(screen.getByRole("button", { name: "New change request" }));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(push()).toHaveBeenCalledWith("/projects/p-new/analysis");
  });

  it("lands on the project's Overview when the last step is skipped", async () => {
    const user = userEvent.setup();
    const onDone = vi.fn();
    create.mockResolvedValue({ ...PROJECT, primaryRepo: null } as never);
    renderWizard({ onDone });
    await createDocumentsOnly(user);
    await user.click(screen.getByRole("button", { name: "Skip — open the Overview" }));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(push()).toHaveBeenCalledWith("/projects/p-new");
  });

  it("creates the project with its repository and starts the ingest", async () => {
    const user = userEvent.setup();
    create.mockResolvedValue({ ...PROJECT, primaryRepo: { id: "c-1" } } as never);
    deepIngest.mockResolvedValue({ jobId: "job-1", connectorId: "c-1", status: "started" });
    renderWizard({ workspaceId: "ws-1" });
    await fillName(user);
    await fillRepo(user);
    await user.click(screen.getByRole("button", { name: "Create and start ingest" }));

    const last = await screen.findByTestId("wizard-next-step");
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
    expect(last).toHaveTextContent("Its repository is being ingested.");
  });

  it("leaves a job in the real store that the Overview counts as this project's ingest", async () => {
    const user = userEvent.setup();
    create.mockResolvedValue({ ...PROJECT, primaryRepo: { id: "c-1" } } as never);
    deepIngest.mockResolvedValue({ jobId: "job-1", connectorId: "c-1", status: "started" });
    renderWizard();
    await fillName(user);
    await fillRepo(user);
    await user.click(screen.getByRole("button", { name: "Create and start ingest" }));
    await screen.findByTestId("wizard-next-step");

    // The same read + predicate `ProjectPipelineOverview` uses for its Ingest stage.
    const jobs = renderHook(() => useActiveJobs()).result.current;
    expect(jobs.filter((j) => isProjectRepoIngestJob(j, "p-new")).map((j) => j.jobId)).toEqual([
      "job-1",
    ]);
    expect(jobs.filter((j) => isProjectRepoIngestJob(j, "p-other"))).toEqual([]);
  });

  it("drops the repository when the user switches back to Documents only", async () => {
    const user = userEvent.setup();
    create.mockResolvedValue({ ...PROJECT, primaryRepo: null } as never);
    renderWizard();
    await fillName(user);
    await user.click(screen.getByLabelText("A GitHub repository"));
    await user.type(screen.getByLabelText("Owner / Org"), "acme-corp");
    await user.click(screen.getByLabelText("Documents only"));
    expect(screen.queryByLabelText("Owner / Org")).not.toBeInTheDocument();
    await user.click(next());
    await user.click(screen.getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][0].primaryRepo).toBeUndefined();
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

    await screen.findByTestId("wizard-next-step");
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

  it("still offers the next step when the ingest fails to start", async () => {
    const user = userEvent.setup();
    create.mockResolvedValue({ ...PROJECT, primaryRepo: { id: "c-1" } } as never);
    deepIngest.mockRejectedValue(new ApiError(403, "Forbidden"));
    renderWizard();
    await fillName(user);
    await fillRepo(user);
    await user.click(screen.getByRole("button", { name: "Create and start ingest" }));

    const last = await screen.findByTestId("wizard-next-step");
    expect(last).not.toHaveTextContent("being ingested");
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
    expect(screen.queryByTestId("wizard-next-step")).not.toBeInTheDocument();
    expect(deepIngest).not.toHaveBeenCalled();
  });

  it("shows a top-level alert and stays on Create for a non-field failure", async () => {
    const user = userEvent.setup();
    create.mockRejectedValue(new ApiError(500, "Server exploded"));
    renderWizard();
    await fillName(user);
    await user.click(next());
    await user.click(screen.getByRole("button", { name: "Create project" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Server exploded");
    expect(screen.getByTestId("wizard-summary")).toBeInTheDocument();
    expect(screen.queryByTestId("wizard-next-step")).not.toBeInTheDocument();
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

  it("refills a cleared Slug from the Name on blur (#23)", async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.type(screen.getByLabelText("Name"), "Acme Two");
    await user.clear(screen.getByLabelText("Slug"));
    fireEvent.blur(screen.getByLabelText("Slug"));
    expect(screen.getByLabelText("Slug")).toHaveValue("acme-two");
  });

  // #23, carried over from the removed Create form.
  it("caps the derived Slug at the schema's 64 characters, with no trailing hyphen", () => {
    // 63 × "a", then a space: an uncapped cut at 64 would end in a hyphen.
    expect(deriveSlug(`${"a".repeat(63)} ${"b".repeat(40)}`)).toBe("a".repeat(63));
    expect(deriveSlug("c".repeat(100))).toBe("c".repeat(64));
  });

  it("says why Next is disabled when the Name yields no Slug (#23)", async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.type(screen.getByLabelText("Name"), "!!!");
    expect(screen.getByLabelText("Slug")).toHaveValue("");
    expect(next()).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Slug is required");
  });

  it("blocks Next on a malformed slug, suggesting a fix", async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.type(screen.getByLabelText("Name"), "Acme");
    await user.clear(screen.getByLabelText("Slug"));
    await user.type(screen.getByLabelText("Slug"), "bad slug");
    expect(next()).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("bad-slug");
  });

  it("requires both Owner and Repository, saying so, and a URL for the API base", async () => {
    const user = userEvent.setup();
    renderWizard();
    await fillName(user);
    await user.click(screen.getByLabelText("A GitHub repository"));
    expect(next()).toBeDisabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Owner / Org"), "acme-corp");
    expect(next()).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Both Owner and Repository are required when specifying a repo.",
    );
    await user.type(screen.getByLabelText("Repository"), "legacy-app");
    expect(next()).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
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
    await user.click(screen.getByLabelText("A GitHub repository"));
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

  // WCAG SC 1.3.5 (#659), carried over from the removed Create form: project
  // metadata is not information about the user, so these inputs carry no
  // `autocomplete` token ("Owner / Org" is the repository's owner, not the user's).
  it("omits autocomplete on project-metadata inputs (#659)", async () => {
    const user = userEvent.setup();
    renderWizard();
    expect(screen.getByLabelText("Name")).not.toHaveAttribute("autocomplete");
    expect(screen.getByLabelText("Slug")).not.toHaveAttribute("autocomplete");
    await fillName(user);
    await user.click(screen.getByLabelText("A GitHub repository"));
    expect(screen.getByLabelText("Owner / Org")).not.toHaveAttribute("autocomplete");
    expect(screen.getByLabelText("Repository")).not.toHaveAttribute("autocomplete");
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
  // #2197 — the dialog sends the active workspace only once validated against
  // the caller's workspaces (GET /workspaces).
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          statusText: "OK",
          text: () =>
            Promise.resolve(
              JSON.stringify({
                success: true,
                data: [
                  { id: "ws-1", name: "One", slug: "one", logoUrl: null, role: "member" },
                  { id: "ws-9", name: "Nine", slug: "nine", logoUrl: null, role: "member" },
                ],
              }),
            ),
        }),
      ),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  function renderDialog(props: Parameters<typeof NewProjectDialog>[0] = {}) {
    const Wrapper = makeWrapper({});
    return render(
      <Wrapper>
        <NewProjectDialog {...props} />
      </Wrapper>,
    );
  }

  async function createThroughDialog(user: User) {
    create.mockResolvedValue({ ...PROJECT, primaryRepo: null } as never);
    await user.click(screen.getByRole("button", { name: "New project" }));
    await createDocumentsOnly(user);
    return create.mock.calls[0][0].workspaceId;
  }

  it("never sends a stored workspace the caller is not in (#2197)", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem("metis.activeWorkspaceId", "ws-previous-user");
    renderDialog();
    expect(await createThroughDialog(user)).toBe("ws-1");
  });

  it("creates in the active workspace and closes on New change request", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem("metis.activeWorkspaceId", "ws-9");
    renderDialog();
    expect(screen.queryByTestId("new-project-wizard")).not.toBeInTheDocument();
    expect(await createThroughDialog(user)).toBe("ws-9");
    // Still open: the last step is offered, not skipped.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "New change request" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(push()).toHaveBeenCalledTimes(1);
    expect(push()).toHaveBeenCalledWith("/projects/p-new/analysis");
  });

  it("lands on the Overview when closed on the last step", async () => {
    const user = userEvent.setup();
    renderDialog();
    await createThroughDialog(user);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(push()).toHaveBeenCalledWith("/projects/p-new");
  });

  it("goes nowhere when closed before anything is created", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(push()).not.toHaveBeenCalled();
  });

  it("starts fresh, and goes nowhere on close, when reopened after a project was made", async () => {
    const user = userEvent.setup();
    renderDialog();
    await createThroughDialog(user);
    await user.click(screen.getByRole("button", { name: "Skip — open the Overview" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    push().mockClear();

    await user.click(screen.getByRole("button", { name: "New project" }));
    expect(screen.getByLabelText("Name")).toHaveValue("");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(push()).not.toHaveBeenCalled();
  });

  it("names its trigger as the caller asks", async () => {
    renderDialog({ triggerTestId: "new-project-button" });
    expect(screen.getByTestId("new-project-button")).toHaveTextContent("New project");
    expect(screen.queryByTestId("new-project-wizard-button")).not.toBeInTheDocument();
    // Let the auth provider's first read settle inside the test.
    await act(async () => {});
  });

  it("renders no trigger when controlled, and reports its close", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderDialog({ open: true, onOpenChange });
    expect(await screen.findByRole("dialog", { name: "New project" })).toBeInTheDocument();
    expect(screen.queryByTestId("new-project-wizard-button")).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
