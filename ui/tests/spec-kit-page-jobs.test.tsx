/**
 * #1059 — the Spec Kit page running a command as a background job: progress,
 * completion and failure rendered as before, cancel, and re-attaching to a job
 * after a reload or a visit to another page.
 *
 * The page and the job module are real. The API is a small in-memory stand-in
 * for the server's job endpoints whose state the test moves by hand, so nothing
 * here depends on how long anything takes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import type { SpecKitJobDto } from "@metis/shared";
import { makeWrapper, TEST_USER } from "./test-utils";
import type { AuthUser } from "@/lib/auth-types";

const routerReplace = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof import("next/navigation")>("next/navigation");
  return {
    ...actual,
    useParams: () => ({ id: "p1" }),
    usePathname: () => "/projects/p1/spec-kit",
    useRouter: () => ({
      push: vi.fn(),
      replace: routerReplace,
      back: vi.fn(),
      forward: vi.fn(),
      prefetch: vi.fn(),
      refresh: vi.fn(),
    }),
    useSearchParams: () => new URLSearchParams(""),
  };
});

vi.mock("@/lib/spec-kit-api", () => ({
  specKitApi: {
    getEnabled: vi.fn(),
    setEnabled: vi.fn(),
    listFiles: vi.fn(),
    getFile: vi.fn(),
    putFile: vi.fn(),
    deleteFile: vi.fn(),
    generateConstitution: vi.fn(),
    runCommand: vi.fn(),
    startCommandJob: vi.fn(),
    getJob: vi.fn(),
    listActiveJobs: vi.fn(),
    cancelJob: vi.fn(),
    listFeatures: vi.fn(),
    listFeatureArtifacts: vi.fn(),
    featureStatus: vi.fn(),
    archiveFeature: vi.fn(),
    restoreFeature: vi.fn(),
    deleteFeatureArtifact: vi.fn(),
  },
}));

// The real job module, reading every few milliseconds instead of every 3 s.
vi.mock("@/lib/spec-kit-jobs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/spec-kit-jobs")>();
  const fast = <T extends object>(hooks: T | undefined): T & { intervalMs: number } => ({
    ...(hooks as T),
    intervalMs: 5,
  });
  return {
    ...actual,
    runSpecKitCommand: (
      projectId: string,
      command: Parameters<typeof actual.runSpecKitCommand>[1],
      options: Parameters<typeof actual.runSpecKitCommand>[2],
      hooks: Parameters<typeof actual.runSpecKitCommand>[3],
    ) => actual.runSpecKitCommand(projectId, command, options, fast(hooks)),
    watchSpecKitJob: (
      projectId: string,
      jobId: string,
      hooks: Parameters<typeof actual.watchSpecKitJob>[2],
      first: Parameters<typeof actual.watchSpecKitJob>[3],
    ) => actual.watchSpecKitJob(projectId, jobId, fast(hooks), first),
  };
});

vi.mock("@/components/connectors/vault-picker", () => ({ VaultPicker: () => null }));
vi.mock("@/lib/analysis-api", () => ({ analysisApi: { start: vi.fn() } }));
vi.mock("@/lib/socket-client", () => ({
  useSocket: () => ({ emit: vi.fn(), on: vi.fn(), off: vi.fn() }),
}));
const toastSuccess = vi.fn();
const toastError = vi.fn();
const toastWarning = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (msg: string) => toastSuccess(msg),
    error: (msg: string) => toastError(msg),
    warning: (msg: string) => toastWarning(msg),
  },
}));
vi.mock("@/lib/collaboration-api", () => ({
  commentApi: {
    listForArtifact: vi.fn().mockResolvedValue([]),
    createForArtifact: vi.fn(),
    listForRequirement: vi.fn().mockResolvedValue([]),
    createForRequirement: vi.fn(),
    reply: vi.fn(),
    edit: vi.fn(),
    delete: vi.fn(),
  },
}));

import { specKitApi } from "@/lib/spec-kit-api";
import SpecKitPage from "@/app/(authed)/projects/[id]/spec-kit/page";
import { ApiError } from "@/lib/api-client";
import { loadWatchedJob } from "@/lib/spec-kit-jobs";

const m = specKitApi as unknown as Record<string, ReturnType<typeof vi.fn>>;
const WRITER: AuthUser = {
  ...TEST_USER,
  role: "developer",
  permissions: ["project.read", "project.update"],
};

/** The server's jobs. Tests change a job's state here, as the server would. */
const server = { jobs: new Map<string, SpecKitJobDto>() };
const isActive = (job: SpecKitJobDto): boolean =>
  job.status === "running" || job.status === "cancelling";
const patch = (id: string, change: Partial<SpecKitJobDto>): void => {
  server.jobs.set(id, { ...server.jobs.get(id)!, ...change });
};
const plant = (job: Partial<SpecKitJobDto> & { id: string }): void => {
  server.jobs.set(job.id, {
    projectId: "p1",
    command: "speckit.tasks",
    featureSlug: null,
    status: "running",
    phase: null,
    startedById: WRITER.id,
    startedAt: "2026-10-12T00:00:00.000Z",
    finishedAt: null,
    ...job,
  });
};

beforeEach(() => {
  window.sessionStorage.clear();
  server.jobs.clear();
  routerReplace.mockReset();
  for (const fn of [toastSuccess, toastError, toastWarning]) fn.mockClear();
  for (const key of Object.keys(m)) m[key]!.mockReset();
  m.getEnabled!.mockResolvedValue({ enabled: true });
  m.listFiles!.mockResolvedValue({ enabled: true, artifacts: [] });
  m.listFeatures!.mockResolvedValue({ features: [] });
  m.featureStatus!.mockResolvedValue({ slug: "" });
  m.listFeatureArtifacts!.mockResolvedValue({ feature: null, artifacts: [] });
  m.startCommandJob!.mockImplementation(
    async (_projectId: string, command: SpecKitJobDto["command"]) => {
      const id = `job-${server.jobs.size + 1}`;
      plant({ id, command });
      return { jobId: id, job: server.jobs.get(id)! };
    },
  );
  m.getJob!.mockImplementation(async (_projectId: string, id: string) => {
    const job = server.jobs.get(id);
    if (!job) throw new ApiError(404, "No such Spec Kit job", "SPEC_KIT_JOB_NOT_FOUND");
    return { job };
  });
  m.listActiveJobs!.mockImplementation(async () => ({
    jobs: [...server.jobs.values()].filter(isActive),
  }));
  m.cancelJob!.mockImplementation(async (_projectId: string, id: string) => {
    patch(id, { status: "cancelled" });
    return { job: server.jobs.get(id)! };
  });
});

const open = () => render(<SpecKitPage />, { wrapper: makeWrapper({ initialUser: WRITER }) });
const ready = (): Promise<void> =>
  waitFor(() => expect(screen.getByTestId("spec-kit-command-input")).toBeInTheDocument());
async function run(command: string): Promise<void> {
  await ready();
  fireEvent.change(screen.getByTestId("spec-kit-command-input"), { target: { value: command } });
  fireEvent.click(screen.getByTestId("spec-kit-run-button"));
}
const progress = (): HTMLElement => screen.getByTestId("spec-kit-progress-message");

describe("Spec Kit page — a command as a background job (#1059)", () => {
  it("shows the job's phases while it runs, then the result exactly as before", async () => {
    open();
    await run("/speckit.tasks");

    await waitFor(() => expect(progress()).toHaveTextContent("/speckit.tasks: starting…"));
    expect(screen.getByTestId("spec-kit-run-button")).toBeDisabled();
    expect(screen.getByTestId("spec-kit-job-note")).toHaveTextContent(/leave this page/);
    expect(m.runCommand).not.toHaveBeenCalled();

    patch("job-1", { phase: "Waiting for the model (/tasks)" });
    await waitFor(() =>
      expect(progress()).toHaveTextContent("/speckit.tasks: Waiting for the model (/tasks)…"),
    );
    // Nothing is reported while it runs.
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(screen.queryByTestId("spec-kit-result")).not.toBeInTheDocument();

    const grounded = "Generated tasks.md (v1) in 900 tokens — grounded on 4 retrieved chunks.";
    patch("job-1", {
      status: "succeeded",
      result: { command: "tasks", artifactName: "tasks.md", message: grounded, tokensUsed: 900 },
    });

    await waitFor(() => expect(screen.getByTestId("spec-kit-result")).toHaveTextContent(grounded));
    expect(toastSuccess).toHaveBeenCalledWith(grounded);
    expect(screen.queryByTestId("spec-kit-progress")).not.toBeInTheDocument();
    expect(screen.queryByTestId("spec-kit-error")).not.toBeInTheDocument();
    expect(screen.getByTestId("spec-kit-run-button")).not.toBeDisabled();
    expect(m.startCommandJob).toHaveBeenCalledTimes(1);
    expect(loadWatchedJob("p1")).toBeNull();
  });

  it("shows a failed job in the error card with the server's message and code", async () => {
    open();
    await run("/speckit.tasks");
    await waitFor(() => expect(progress()).toBeInTheDocument());

    const message =
      "/tasks: the model reached its output-token limit before writing any text. Nothing was saved; the previous version is kept.";
    patch("job-1", {
      status: "failed",
      error: { status: 502, code: "SPEC_KIT_OUTPUT_EXHAUSTED", message },
    });

    await waitFor(() => expect(screen.getByTestId("spec-kit-error")).toHaveTextContent(message));
    expect(screen.getByTestId("spec-kit-error-code")).toHaveTextContent(
      "SPEC_KIT_OUTPUT_EXHAUSTED",
    );
    expect(toastError).toHaveBeenCalledWith(message);
    expect(screen.queryByTestId("spec-kit-result")).not.toBeInTheDocument();
    expect(screen.queryByTestId("spec-kit-progress")).not.toBeInTheDocument();
  });

  it("shows why a start was refused when the feature already has a running job", async () => {
    const refusal = "/speckit.plan is already running. Wait for it to finish, or cancel it.";
    m.startCommandJob!.mockRejectedValue(
      new ApiError(409, refusal, "SPEC_KIT_JOB_RUNNING", { jobId: "theirs" }),
    );
    open();
    await run("/speckit.tasks");

    await waitFor(() => expect(screen.getByTestId("spec-kit-error")).toHaveTextContent(refusal));
    expect(screen.getByTestId("spec-kit-error-code")).toHaveTextContent("SPEC_KIT_JOB_RUNNING");
    expect(m.getJob).not.toHaveBeenCalled();
  });

  describe("re-attaching", () => {
    it("picks a running job up again after a reload, without starting it twice", async () => {
      const first = open();
      await run("/speckit.tasks");
      await waitFor(() => expect(progress()).toBeInTheDocument());
      patch("job-1", { phase: "Waiting for the model (/tasks)" });

      first.unmount(); // the reload
      open();

      await waitFor(() =>
        expect(progress()).toHaveTextContent("/speckit.tasks: Waiting for the model (/tasks)…"),
      );
      expect(screen.getByTestId("spec-kit-run-button")).toBeDisabled();
      expect(screen.getByTestId("spec-kit-job-cancel")).toBeInTheDocument();
      expect(m.startCommandJob).toHaveBeenCalledTimes(1);

      patch("job-1", {
        status: "succeeded",
        result: { command: "tasks", artifactName: "tasks.md", message: "Generated tasks.md (v1)." },
      });
      await waitFor(() =>
        expect(screen.getByTestId("spec-kit-result")).toHaveTextContent("Generated tasks.md (v1)."),
      );
      expect(toastSuccess).toHaveBeenCalledTimes(1);
      expect(loadWatchedJob("p1")).toBeNull();
    });

    it("shows the outcome of a job that finished while the page was away — once", async () => {
      const first = open();
      await run("/speckit.tasks");
      await waitFor(() => expect(progress()).toBeInTheDocument());
      first.unmount(); // off to another page…
      // …where nothing is reported about the job.
      patch("job-1", {
        status: "failed",
        error: {
          status: 502,
          code: "SPEC_KIT_EMPTY_OUTPUT",
          message: "The model returned an empty reply.",
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(toastError).not.toHaveBeenCalled();

      const second = open(); // …and back
      await waitFor(() =>
        expect(screen.getByTestId("spec-kit-error")).toHaveTextContent(
          "The model returned an empty reply.",
        ),
      );
      expect(screen.getByTestId("spec-kit-error-code")).toHaveTextContent("SPEC_KIT_EMPTY_OUTPUT");
      expect(toastError).toHaveBeenCalledTimes(1);
      expect(m.startCommandJob).toHaveBeenCalledTimes(1);

      second.unmount();
      open();
      await ready();
      await waitFor(() => expect(m.listActiveJobs).toHaveBeenCalledTimes(3));
      expect(screen.queryByTestId("spec-kit-error")).not.toBeInTheDocument();
      expect(toastError).toHaveBeenCalledTimes(1);
    });

    it("picks up the viewer's job started somewhere else, in that job's feature", async () => {
      plant({
        id: "from-another-tab",
        command: "speckit.plan",
        featureSlug: "001-mark-read",
        phase: "Generating research.md (2 of 5)",
      });
      open();

      await waitFor(() =>
        expect(progress()).toHaveTextContent(
          "/speckit.plan on 001-mark-read: Generating research.md (2 of 5)…",
        ),
      );
      expect(m.startCommandJob).not.toHaveBeenCalled();
      // The job's feature is the one opened, so its result lands where it belongs.
      await waitFor(() =>
        expect(m.listFeatureArtifacts).toHaveBeenCalledWith("p1", "001-mark-read"),
      );
    });

    it("leaves another member's running job alone", async () => {
      plant({ id: "theirs", startedById: "someone-else" });
      open();
      await ready();
      await waitFor(() => expect(m.listActiveJobs).toHaveBeenCalled());
      // Give an attach every chance to happen before saying it did not.
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(screen.queryByTestId("spec-kit-progress")).not.toBeInTheDocument();
      expect(screen.getByTestId("spec-kit-run-button")).not.toBeDisabled();
      expect(m.getJob).not.toHaveBeenCalled();
    });
  });

  describe("cancel", () => {
    it("cancels the running job and says so, as a cancellation rather than a failure", async () => {
      open();
      await run("/speckit.tasks");
      await waitFor(() => expect(screen.getByTestId("spec-kit-job-cancel")).toBeInTheDocument());

      fireEvent.click(screen.getByTestId("spec-kit-job-cancel"));

      const cancelled =
        "The command was cancelled. Nothing was saved; the previous version is kept.";
      await waitFor(() =>
        expect(screen.getByTestId("spec-kit-error")).toHaveTextContent(cancelled),
      );
      expect(m.cancelJob).toHaveBeenCalledWith("p1", "job-1");
      expect(screen.queryByTestId("spec-kit-error-code")).not.toBeInTheDocument();
      expect(toastWarning).toHaveBeenCalledWith(cancelled);
      expect(toastError).not.toHaveBeenCalled();
      expect(screen.queryByTestId("spec-kit-result")).not.toBeInTheDocument();
      expect(screen.queryByTestId("spec-kit-progress")).not.toBeInTheDocument();
      expect(loadWatchedJob("p1")).toBeNull();
    });

    it("says so when the job is already saving, and goes on to show its result", async () => {
      const saving = "The command is already saving its result and can no longer be cancelled.";
      m.cancelJob!.mockRejectedValue(new ApiError(409, saving, "SPEC_KIT_JOB_SAVING"));
      open();
      await run("/speckit.tasks");
      await waitFor(() => expect(screen.getByTestId("spec-kit-job-cancel")).toBeInTheDocument());

      fireEvent.click(screen.getByTestId("spec-kit-job-cancel"));

      await waitFor(() => expect(toastError).toHaveBeenCalledWith(saving));
      expect(screen.getByTestId("spec-kit-progress")).toBeInTheDocument();
      patch("job-1", { status: "succeeded", result: { message: "Generated tasks.md (v2)." } });
      await waitFor(() =>
        expect(screen.getByTestId("spec-kit-result")).toHaveTextContent("Generated tasks.md (v2)."),
      );
    });

    it("shows the cancel as under way while the server winds the job down", async () => {
      m.cancelJob!.mockImplementation(async (_projectId: string, id: string) => {
        patch(id, { status: "cancelling" });
        return { job: server.jobs.get(id)! };
      });
      open();
      await run("/speckit.tasks");
      await waitFor(() => expect(screen.getByTestId("spec-kit-job-cancel")).toBeInTheDocument());

      fireEvent.click(screen.getByTestId("spec-kit-job-cancel"));

      await waitFor(() => expect(progress()).toHaveTextContent("Cancelling /speckit.tasks…"));
      expect(screen.getByTestId("spec-kit-job-cancel")).toBeDisabled();
      expect(screen.getByTestId("spec-kit-job-cancel")).toHaveTextContent("Cancelling…");
    });
  });
});
