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
// One socket for the page, so a test can see what the page asks of it.
const socket = vi.hoisted(() => ({ emit: vi.fn(), on: vi.fn(), off: vi.fn() }));
vi.mock("@/lib/socket-client", () => ({ useSocket: () => socket }));
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
import { loadWatchedJobs, rememberWatchedJob } from "@/lib/spec-kit-jobs";
import { loadHandoff, saveHandoff } from "@/lib/spec-kit-display";

const m = specKitApi as unknown as Record<string, ReturnType<typeof vi.fn>>;
const WRITER: AuthUser = {
  ...TEST_USER,
  role: "developer",
  permissions: ["project.read", "project.update"],
};

/** The server's jobs. Tests change a job's state here, as the server would. */
const server = { jobs: new Map<string, SpecKitJobDto>() };
const isActive = (job: SpecKitJobDto): boolean =>
  job.status === "running" || job.status === "cancelling" || job.status === "saving";
const minutesAgo = (n: number): string => new Date(Date.now() - n * 60_000).toISOString();
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
  for (const fn of Object.values(socket)) fn.mockReset();
  for (const key of Object.keys(m)) m[key]!.mockReset();
  m.getEnabled!.mockResolvedValue({ enabled: true });
  m.listFiles!.mockResolvedValue({ enabled: true, artifacts: [] });
  m.listFeatures!.mockResolvedValue({ features: [] });
  m.featureStatus!.mockResolvedValue({ slug: "" });
  m.listFeatureArtifacts!.mockResolvedValue({ feature: null, artifacts: [] });
  m.startCommandJob!.mockImplementation(
    async (
      _projectId: string,
      command: SpecKitJobDto["command"],
      options: { featureSlug?: string } = {},
    ) => {
      const id = `job-${server.jobs.size + 1}`;
      plant({ id, command, featureSlug: options.featureSlug ?? null });
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
    expect(loadWatchedJobs("p1")).toEqual([]);
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

  it("follows the job's own lifecycle events while it runs, and stops when it ends", async () => {
    open();
    await run("/speckit.tasks");
    await waitFor(() => expect(progress()).toBeInTheDocument());

    // The job room is joined and the page listens for `job:lifecycle`…
    expect(socket.emit).toHaveBeenCalledWith("subscribe:job", { jobId: "job-1" });
    const listening = socket.on.mock.calls.filter(([event]) => event === "job:lifecycle");
    expect(listening).toHaveLength(1);

    patch("job-1", { status: "succeeded", result: { message: "Generated tasks.md (v1)." } });
    await waitFor(() => expect(screen.getByTestId("spec-kit-result")).toBeInTheDocument());
    // …and both are given up once the job is over.
    expect(socket.off).toHaveBeenCalledWith("job:lifecycle", listening[0]![1]);
    expect(socket.emit).toHaveBeenCalledWith("unsubscribe:job", { jobId: "job-1" });
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
      expect(loadWatchedJobs("p1")).toEqual([]);
    });

    it("shows the outcome of a job that finished while the page was away — once", async () => {
      const first = open();
      await run("/speckit.tasks");
      await waitFor(() => expect(progress()).toBeInTheDocument());
      first.unmount(); // off to another page…
      // …where nothing is reported about the job.
      patch("job-1", {
        status: "failed",
        finishedAt: minutesAgo(1),
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
      expect(loadWatchedJobs("p1")).toEqual([]);

      second.unmount();
      const reads = m.getJob!.mock.calls.length;
      open();
      await ready();
      await waitFor(() => expect(screen.getByTestId("spec-kit-run-button")).not.toBeDisabled());
      await new Promise((resolve) => setTimeout(resolve, 30));
      // Nothing is left to pick up: the job is not read again, nor announced again.
      expect(m.getJob!.mock.calls.length).toBe(reads);
      expect(screen.queryByTestId("spec-kit-error")).not.toBeInTheDocument();
      expect(toastError).toHaveBeenCalledTimes(1);
    });

    // #1088 — a command that finishes while the user is on another page still
    // lands when they come back: the result, the toast, the fresh caches.
    it("applies a result that arrived a short while ago, as if the page had stayed open", async () => {
      const first = open();
      await run("/speckit.specify A new feature");
      await waitFor(() => expect(progress()).toBeInTheDocument());
      first.unmount();
      const created = { id: "f1", slug: "004-a-new-feature", title: "A new feature" };
      patch("job-1", {
        status: "succeeded",
        finishedAt: minutesAgo(3),
        result: { message: "Generated spec.md (v1) for 004-a-new-feature.", feature: created },
      });
      const filesReadBefore = m.listFiles!.mock.calls.length;

      open();

      await waitFor(() =>
        expect(screen.getByTestId("spec-kit-result")).toHaveTextContent(
          "Generated spec.md (v1) for 004-a-new-feature.",
        ),
      );
      expect(toastSuccess).toHaveBeenCalledWith("Generated spec.md (v1) for 004-a-new-feature.");
      // The new feature is opened, and the lists are read again.
      await waitFor(() =>
        expect(routerReplace).toHaveBeenCalledWith(
          "/projects/p1/spec-kit?feature=004-a-new-feature",
          { scroll: false },
        ),
      );
      await waitFor(() =>
        expect(m.listFiles!.mock.calls.length).toBeGreaterThan(filesReadBefore + 1),
      );
      expect(loadWatchedJobs("p1")).toEqual([]);
    });

    // Review L10 — the same tab, reopened the next morning.
    describe("a result that is not news any more", () => {
      const HANDOFF = { context: ["spec.md", "plan.md"], feature: "002-current-work" };
      const created = { id: "f1", slug: "004-a-new-feature", title: "A new feature" };
      const expectNothingMoved = async (): Promise<void> => {
        await ready();
        await waitFor(() => expect(screen.getByTestId("spec-kit-job-notices")).toBeInTheDocument());
        // Not applied as fresh: no toast, no result card, no feature switch…
        expect(toastSuccess).not.toHaveBeenCalled();
        expect(screen.queryByTestId("spec-kit-result")).not.toBeInTheDocument();
        expect(routerReplace).not.toHaveBeenCalled();
        expect(m.listFeatureArtifacts).not.toHaveBeenCalled();
        // …and the handoff saved since is still there.
        expect(loadHandoff("p1")).toEqual(HANDOFF);
        // It is not looked for again on the next visit.
        expect(loadWatchedJobs("p1")).toEqual([]);
      };

      it("shows a day-old specify as something that happened earlier, and moves nothing", async () => {
        plant({
          id: "yesterday",
          command: "speckit.specify",
          featureSlug: "004-a-new-feature",
          status: "succeeded",
          finishedAt: minutesAgo(18 * 60),
          result: { message: "Generated spec.md (v1) for 004-a-new-feature.", feature: created },
        });
        // This tab started it, from the project-level files.
        rememberWatchedJob("p1", {
          jobId: "yesterday",
          command: "speckit.specify",
          featureSlug: "004-a-new-feature",
          origin: { scope: null },
        });
        saveHandoff("p1", HANDOFF);

        open();

        await expectNothingMoved();
        const notice = screen.getByTestId("spec-kit-job-notice-yesterday");
        expect(notice).toHaveTextContent(
          /^Earlier at .*\/speckit\.specify on 004-a-new-feature finished/,
        );
        // The viewer can still go and look, by choice.
        fireEvent.click(screen.getByTestId("spec-kit-job-notice-open-yesterday"));
        expect(routerReplace).toHaveBeenCalledWith(
          "/projects/p1/spec-kit?feature=004-a-new-feature",
          { scroll: false },
        );
      });

      it("treats a recent result of a job this tab only FOUND running the same way", async () => {
        plant({
          id: "from-another-tab",
          command: "speckit.specify",
          featureSlug: "004-a-new-feature",
          status: "succeeded",
          finishedAt: minutesAgo(1),
          result: { message: "Generated spec.md (v1) for 004-a-new-feature.", feature: created },
        });
        // Watched, but with no origin: this tab did not start it.
        rememberWatchedJob("p1", {
          jobId: "from-another-tab",
          command: "speckit.specify",
          featureSlug: "004-a-new-feature",
        });
        saveHandoff("p1", HANDOFF);

        open();

        await expectNothingMoved();
      });

      it("says why an old failure failed, without the error card, and can be dismissed", async () => {
        plant({
          id: "old-failure",
          command: "speckit.plan",
          featureSlug: "001-mark-read",
          status: "failed",
          finishedAt: minutesAgo(45),
          error: {
            status: 502,
            code: "SPEC_KIT_EMPTY_OUTPUT",
            message: "The model returned an empty reply.",
          },
        });
        rememberWatchedJob("p1", {
          jobId: "old-failure",
          command: "speckit.plan",
          featureSlug: "001-mark-read",
          origin: { scope: "001-mark-read" },
        });
        open();
        await ready();

        const notice = await screen.findByTestId("spec-kit-job-notice-old-failure");
        expect(notice).toHaveTextContent(
          "/speckit.plan on 001-mark-read failed: The model returned an empty reply.",
        );
        expect(screen.queryByTestId("spec-kit-error")).not.toBeInTheDocument();
        expect(toastError).not.toHaveBeenCalled();

        fireEvent.click(screen.getByTestId("spec-kit-job-notice-dismiss-old-failure"));
        expect(screen.queryByTestId("spec-kit-job-notices")).not.toBeInTheDocument();
      });
    });
  });

  // Panel (over-blocking) and review L9: a running job is shown, and holds up
  // only the feature it runs on — whoever started it.
  describe("a job running somewhere else does not block this page", () => {
    it("shows the viewer's job on another feature without moving to it or disabling Run", async () => {
      plant({
        id: "from-another-tab",
        command: "speckit.plan",
        featureSlug: "001-mark-read",
        phase: "Generating research.md (2 of 5)",
      });
      open();
      await ready();

      const row = await screen.findByTestId("spec-kit-other-job-from-another-tab");
      expect(row).toHaveTextContent(
        "/speckit.plan on 001-mark-read: Generating research.md (2 of 5)… (started by you)",
      );
      // The page stays where it was…
      expect(routerReplace).not.toHaveBeenCalled();
      expect(m.listFeatureArtifacts).not.toHaveBeenCalled();
      expect(screen.queryByTestId("spec-kit-progress")).not.toBeInTheDocument();
      // …and is usable: the box and Run are enabled for the project files.
      expect(screen.getByTestId("spec-kit-command-input")).not.toBeDisabled();
      expect(screen.getByTestId("spec-kit-run-button")).not.toBeDisabled();
      expect(screen.queryByTestId("spec-kit-run-blocked")).not.toBeInTheDocument();
      expect(m.startCommandJob).not.toHaveBeenCalled();

      // A command here starts while the other one is still running.
      await run("/speckit.tasks");
      await waitFor(() =>
        expect(m.startCommandJob).toHaveBeenCalledWith("p1", "speckit.tasks", {
          input: "",
        }),
      );
      await waitFor(() => expect(progress()).toHaveTextContent("/speckit.tasks: starting…"));
      expect(screen.getByTestId("spec-kit-other-job-from-another-tab")).toBeInTheDocument();
    });

    it("offers to open the job's feature, and there Run is held until it ends", async () => {
      plant({ id: "from-another-tab", command: "speckit.plan", featureSlug: "001-mark-read" });
      open();
      await ready();

      fireEvent.click(await screen.findByTestId("spec-kit-other-job-open-from-another-tab"));

      expect(routerReplace).toHaveBeenCalledWith("/projects/p1/spec-kit?feature=001-mark-read", {
        scroll: false,
      });
      await waitFor(() =>
        expect(progress()).toHaveTextContent("/speckit.plan on 001-mark-read: starting…"),
      );
      expect(screen.getByTestId("spec-kit-run-button")).toBeDisabled();
      expect(screen.getByTestId("spec-kit-run-blocked")).toHaveTextContent(
        "/speckit.plan is running on 001-mark-read (started by you).",
      );
      // The box is never disabled: the next command can be typed meanwhile.
      expect(screen.getByTestId("spec-kit-command-input")).not.toBeDisabled();
      expect(screen.queryByTestId("spec-kit-other-jobs")).not.toBeInTheDocument();
    });

    it("announces that job's result without moving the page or clearing the command box", async () => {
      plant({ id: "from-another-tab", command: "speckit.plan", featureSlug: "001-mark-read" });
      open();
      await ready();
      await screen.findByTestId("spec-kit-other-job-from-another-tab");
      fireEvent.change(screen.getByTestId("spec-kit-command-input"), {
        target: { value: "/speckit.specify something I am still typing" },
      });

      patch("from-another-tab", {
        status: "succeeded",
        finishedAt: minutesAgo(0),
        result: { message: "Generated 5 plan artifacts.", artifacts: [{ key: "plan.md" }] },
      });

      await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Generated 5 plan artifacts."));
      const notice = await screen.findByTestId("spec-kit-job-notice-from-another-tab");
      expect(notice).toHaveTextContent("Generated 5 plan artifacts.");
      expect(screen.getByTestId("spec-kit-job-notice-open-from-another-tab")).toHaveTextContent(
        "Open 001-mark-read",
      );
      // Nothing of the page moved.
      expect(routerReplace).not.toHaveBeenCalled();
      expect(screen.queryByTestId("spec-kit-result")).not.toBeInTheDocument();
      expect(screen.getByTestId("spec-kit-command-input")).toHaveValue(
        "/speckit.specify something I am still typing",
      );
      await waitFor(() =>
        expect(screen.queryByTestId("spec-kit-other-jobs")).not.toBeInTheDocument(),
      );
    });

    it("shows ANOTHER member's job on this feature as busy, before anyone is refused", async () => {
      plant({
        id: "theirs",
        command: "speckit.plan",
        startedById: "someone-else",
        phase: "Generating plan.md (1 of 5)",
      });
      open();
      await ready();

      await waitFor(() =>
        expect(progress()).toHaveTextContent("/speckit.plan: Generating plan.md (1 of 5)…"),
      );
      expect(screen.getByTestId("spec-kit-job-note")).toHaveTextContent(
        "Started by another member",
      );
      expect(screen.getByTestId("spec-kit-run-button")).toBeDisabled();
      expect(screen.getByTestId("spec-kit-run-blocked")).toHaveTextContent(
        "/speckit.plan is running on the project files (started by another member).",
      );
      // It is theirs: not watched (its result is never read), and not this viewer's to cancel here.
      expect(m.getJob).not.toHaveBeenCalled();
      expect(screen.queryByTestId("spec-kit-job-cancel")).not.toBeInTheDocument();
      expect(m.startCommandJob).not.toHaveBeenCalled();

      // The Enter key does not get past the disabled button either: it says why.
      fireEvent.change(screen.getByTestId("spec-kit-command-input"), {
        target: { value: "/speckit.tasks" },
      });
      fireEvent.keyDown(screen.getByTestId("spec-kit-command-input"), { key: "Enter" });
      await waitFor(() =>
        expect(screen.getByTestId("spec-kit-error")).toHaveTextContent(
          "/speckit.plan is running on the project files (started by another member).",
        ),
      );
      expect(m.startCommandJob).not.toHaveBeenCalled();
    });

    it("keeps a result where it was asked for when the page has moved to another feature", async () => {
      // The viewer's other job, on another feature, gives the page somewhere to go.
      plant({ id: "elsewhere", command: "speckit.plan", featureSlug: "001-mark-read" });
      open();
      // Started HERE, on the project files…
      await run("/speckit.tasks");
      await waitFor(() => expect(progress()).toHaveTextContent("/speckit.tasks: starting…"));
      // …and the viewer then opens the other feature.
      fireEvent.click(await screen.findByTestId("spec-kit-other-job-open-elsewhere"));
      await waitFor(() =>
        expect(progress()).toHaveTextContent("/speckit.plan on 001-mark-read: starting…"),
      );
      expect(routerReplace).toHaveBeenCalledTimes(1);
      fireEvent.change(screen.getByTestId("spec-kit-command-input"), {
        target: { value: "/speckit.clarify what I am typing now" },
      });

      patch("job-2", {
        status: "succeeded",
        finishedAt: minutesAgo(0),
        result: { command: "tasks", artifactName: "tasks.md", message: "Generated tasks.md (v1)." },
      });

      // Announced, with a way back to it…
      await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Generated tasks.md (v1)."));
      expect(await screen.findByTestId("spec-kit-job-notice-job-2")).toHaveTextContent(
        "Generated tasks.md (v1).",
      );
      expect(screen.getByTestId("spec-kit-job-notice-open-job-2")).toHaveTextContent(
        "Open project files",
      );
      // …but the feature the viewer is looking at is left exactly as it was.
      expect(screen.queryByTestId("spec-kit-result")).not.toBeInTheDocument();
      expect(routerReplace).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("spec-kit-command-input")).toHaveValue(
        "/speckit.clarify what I am typing now",
      );
    });

    it("keeps a failure where it was asked for too: a toast, not this feature's error card", async () => {
      plant({ id: "elsewhere", command: "speckit.plan", featureSlug: "001-mark-read" });
      open();
      await run("/speckit.tasks");
      await waitFor(() => expect(progress()).toHaveTextContent("/speckit.tasks: starting…"));
      fireEvent.click(await screen.findByTestId("spec-kit-other-job-open-elsewhere"));
      await waitFor(() =>
        expect(progress()).toHaveTextContent("/speckit.plan on 001-mark-read: starting…"),
      );

      patch("job-2", {
        status: "failed",
        finishedAt: minutesAgo(0),
        error: {
          status: 502,
          code: "SPEC_KIT_EMPTY_OUTPUT",
          message: "The model returned an empty reply.",
        },
      });

      await waitFor(() =>
        expect(toastError).toHaveBeenCalledWith("The model returned an empty reply."),
      );
      expect(screen.queryByTestId("spec-kit-error")).not.toBeInTheDocument();
    });

    it("lets a new feature be created while a job holds the project files", async () => {
      plant({ id: "theirs", command: "speckit.plan", startedById: "someone-else" });
      open();
      await ready();
      await waitFor(() => expect(screen.getByTestId("spec-kit-run-button")).toBeDisabled());

      // `/speckit.specify` here creates a feature of its own: nothing holds it up.
      fireEvent.change(screen.getByTestId("spec-kit-command-input"), {
        target: { value: "/speckit.specify Star an entry" },
      });
      expect(screen.getByTestId("spec-kit-run-button")).not.toBeDisabled();
      expect(screen.queryByTestId("spec-kit-run-blocked")).not.toBeInTheDocument();

      fireEvent.click(screen.getByTestId("spec-kit-run-button"));
      await waitFor(() =>
        expect(m.startCommandJob).toHaveBeenCalledWith("p1", "speckit.specify", {
          input: "Star an entry",
        }),
      );
    });

    it("leaves another member's job on another feature in the list, and Run alone", async () => {
      plant({ id: "theirs", startedById: "someone-else", featureSlug: "007-theirs" });
      open();
      await ready();

      const row = await screen.findByTestId("spec-kit-other-job-theirs");
      expect(row).toHaveTextContent("(started by another member)");
      expect(screen.queryByTestId("spec-kit-progress")).not.toBeInTheDocument();
      expect(screen.getByTestId("spec-kit-run-button")).not.toBeDisabled();
      expect(m.getJob).not.toHaveBeenCalled();
    });

    it("frees Run when the other member's job leaves the list", async () => {
      plant({ id: "theirs", command: "speckit.plan", startedById: "someone-else" });
      open();
      await ready();
      await waitFor(() => expect(screen.getByTestId("spec-kit-run-button")).toBeDisabled());

      patch("theirs", { status: "succeeded" });
      // A refused or settled request re-reads the list; so does its own interval.
      await run("/speckit.specify Star an entry");
      await waitFor(() => expect(m.startCommandJob).toHaveBeenCalled());
      patch("job-2", { status: "succeeded", result: { message: "Generated spec.md (v1)." } });
      await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
      await waitFor(() =>
        expect(screen.queryByTestId("spec-kit-run-blocked")).not.toBeInTheDocument(),
      );
      expect(screen.getByTestId("spec-kit-run-button")).not.toBeDisabled();
    });
  });

  describe("saving", () => {
    it("says the job is saving and no longer offers to cancel it", async () => {
      open();
      await run("/speckit.tasks");
      await waitFor(() => expect(screen.getByTestId("spec-kit-job-cancel")).toBeInTheDocument());

      patch("job-1", { status: "saving", phase: "Saving tasks.md" });

      await waitFor(() =>
        expect(progress()).toHaveTextContent("/speckit.tasks: saving the result…"),
      );
      expect(screen.getByTestId("spec-kit-job-cancel")).toBeDisabled();
      expect(screen.getByTestId("spec-kit-job-cancel")).toHaveTextContent("Saving…");
      expect(screen.getByTestId("spec-kit-run-button")).toBeDisabled();
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
      expect(loadWatchedJobs("p1")).toEqual([]);
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
