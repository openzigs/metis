/**
 * Import page live-progress behaviour — Issue #424 (Epic #406).
 *
 * The page (`src/app/.../import/page.tsx`) is coverage-EXCLUDED, but the AC
 * requires a behavioural test that the page renders LIVE progress for an active
 * run (not just an enqueue toast + silent poll) and that the pre-existing import
 * affordances are NOT regressed. The testable mapping logic itself is covered by
 * `use-import-progress.test.tsx`; here we assert the page WIRES it:
 *   - kicking off an import sets the active run and the `<JobProgress>` bar shows;
 *   - the bar disappears once the run is done (terminal handled by the hook);
 *   - the existing import-history affordances (Run now, ongoing-sync) survive.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeWrapper } from "./test-utils";

const useParamsMock = vi.fn(() => ({ id: "proj-1" }) as { id: string } | null);
vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof import("next/navigation")>("next/navigation");
  return {
    ...actual,
    useParams: () => useParamsMock(),
    usePathname: () => "/projects/proj-1/import",
    useRouter: () => ({
      push: vi.fn(),
      replace: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      prefetch: vi.fn(),
      refresh: vi.fn(),
    }),
    useSearchParams: () => new URLSearchParams(),
  };
});

vi.mock("@/lib/import-api", () => ({
  importApi: {
    listSources: vi.fn(),
    preview: vi.fn(),
    createSource: vi.fn(),
    runSource: vi.fn(),
    setSync: vi.fn(),
    deleteSource: vi.fn(),
  },
}));

// Drive the live-progress view the page renders, keyed by the active run id.
const progressFor = vi.fn();
vi.mock("@/hooks/use-import-progress", () => ({
  useImportProgress: (runId: string | null) => progressFor(runId),
}));

import { importApi } from "@/lib/import-api";
import ImportPage from "@/app/(authed)/projects/[id]/import/page";

const listSources = importApi.listSources as unknown as ReturnType<typeof vi.fn>;
const createSource = importApi.createSource as unknown as ReturnType<typeof vi.fn>;
const runSource = importApi.runSource as unknown as ReturnType<typeof vi.fn>;

function sourceView(overrides: Record<string, unknown> = {}) {
  return {
    id: "src-1",
    projectId: "proj-1",
    analysisId: "an-1",
    source: "github",
    label: "GitHub import",
    filter: { owner: "octo", repo: "hello", state: "open" },
    baseUrl: null,
    jiraConnectionId: null,
    hasToken: true,
    syncEnabled: false,
    syncIntervalMinutes: 60,
    consecutiveFailures: 0,
    disabledReason: null,
    lastRunAt: null,
    createdById: "u-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastRun: null,
    ...overrides,
  };
}

function runView(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    importSourceId: "src-1",
    projectId: "proj-1",
    trigger: "manual",
    status: "pending",
    taskId: "task-1",
    createdCount: 0,
    updatedCount: 0,
    skippedCount: 0,
    totalFetched: 0,
    errorMessage: null,
    startedAt: null,
    completedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function renderPage() {
  const Wrapper = makeWrapper({ withAuth: false });
  return render(
    <Wrapper>
      <ImportPage />
    </Wrapper>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useParamsMock.mockReturnValue({ id: "proj-1" });
  listSources.mockResolvedValue([sourceView()]);
  // No active run by default → no bar.
  progressFor.mockReturnValue(null);
});

describe("ImportPage live progress (#424)", () => {
  it("renders a live progress bar for an active run after Import is clicked", async () => {
    createSource.mockResolvedValue({ source: sourceView(), run: runView() });
    // Once a run is active, the hook reports an in-flight progress view.
    progressFor.mockImplementation((runId: string | null) =>
      runId
        ? { progress: 30, message: "Fetched 3/10 issues", indeterminate: false, done: false }
        : null,
    );

    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => expect(createSource).toHaveBeenCalled());
    // The page passed the kicked-off run id to the progress hook…
    await waitFor(() => expect(progressFor).toHaveBeenCalledWith("run-1"));
    // …and rendered the live bar (role=progressbar from <JobProgress>).
    expect(await screen.findByTestId("import-active-progress")).toBeInTheDocument();
    expect(screen.getByText("Fetched 3/10 issues")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Import progress" })).toBeInTheDocument();
  });

  it("hides the bar once the run is done (terminal handled by the hook/toast)", async () => {
    createSource.mockResolvedValue({ source: sourceView(), run: runView() });
    progressFor.mockImplementation((runId: string | null) =>
      runId ? { progress: 100, message: "Imported 5 new", indeterminate: false, done: true } : null,
    );

    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(createSource).toHaveBeenCalled());

    // done:true → the page suppresses the bar (the toast communicates the result).
    await waitFor(() => expect(progressFor).toHaveBeenCalledWith("run-1"));
    expect(screen.queryByTestId("import-active-progress")).not.toBeInTheDocument();
  });

  it("starts progress for a manual 'Run now' and preserves import-history affordances", async () => {
    runSource.mockResolvedValue(runView({ id: "run-2" }));
    progressFor.mockImplementation((runId: string | null) =>
      runId === "run-2"
        ? { progress: null, message: "Importing…", indeterminate: true, done: false }
        : null,
    );

    renderPage();
    // The pre-existing import-history affordances are still present (not regressed).
    expect(await screen.findByText("GitHub import")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Ongoing sync/ })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Run now" }));
    await waitFor(() => expect(runSource).toHaveBeenCalledWith("proj-1", "src-1"));
    await waitFor(() => expect(progressFor).toHaveBeenCalledWith("run-2"));
    expect(await screen.findByTestId("import-active-progress")).toBeInTheDocument();
  });
});
