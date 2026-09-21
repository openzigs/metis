/**
 * Import-service job-lifecycle emits — Issue #424 (Epic #406).
 *
 * `ImportService.runSource()` is the active-run seam: it now streams
 * `started` → `progress` → `completed` (or `failed`) on the unified
 * `job:lifecycle` bus under the `import-sync` {@link JobKind}, keyed by the
 * {@link ImportRun} id (= the jobId). These tests verify, with a spy emitter +
 * fake importer + fake prisma:
 *   - progress-during-run: started fires first, then determinate progress as
 *     items stream, then a completed transition (drives the live `<JobProgress>`
 *     bar + success toast on the page);
 *   - terminal-failure: a thrown importer error emits a `failed` transition with
 *     the GENERIC, user-safe message (#254 / OWASP) — the raw error never leaves
 *     the server over the socket;
 *   - indeterminate degrade: when `count()` is unavailable the progress emits use
 *     pct 0 (no misleading percentage) but still announce the streamed count.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Inject a fake importer so the run does not touch the network. The factory is
// hoisted (vi.mock), so the controllable importer lives on a module-level ref.
const importerRef: {
  count: ReturnType<typeof vi.fn>;
  fetchAll: () => AsyncGenerator<unknown>;
  map: ReturnType<typeof vi.fn>;
} = {
  count: vi.fn(),
  fetchAll: async function* () {},
  map: vi.fn(),
};

vi.mock("./registry.js", () => ({
  createImporter: () => importerRef,
  sourceUsesToken: (source: string) => source !== "jira",
}));

import { ImportService, type ImportServiceDeps } from "./import-service.js";
import type { JobEventEmitter } from "../socket/job-events.js";
import { genericFailureMessage } from "../socket/job-events.js";

/** A spy job emitter capturing every lifecycle call. */
function spyEmitter(): JobEventEmitter {
  return {
    lifecycle: vi.fn(),
    started: vi.fn(),
    progress: vi.fn(),
    completed: vi.fn(),
    failed: vi.fn(),
    docSection: vi.fn(),
  };
}

const SOURCE_ROW = {
  id: "src-1",
  projectId: "proj-1",
  analysisId: "an-1",
  source: "github",
  label: "GitHub import",
  filter: JSON.stringify({ owner: "octo", repo: "hello", state: "open" }),
  baseUrl: null,
  jiraConnectionId: null,
  secretId: "secret-1",
  syncEnabled: false,
  syncIntervalMinutes: 60,
  scheduledJobId: null,
  consecutiveFailures: 0,
  disabledReason: null,
  lastRunAt: null,
  createdById: "user-1",
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

const RUN_ROW = {
  id: "run-1",
  importSourceId: "src-1",
  projectId: "proj-1",
  trigger: "manual",
  status: "running",
  taskId: null,
  createdCount: 0,
  updatedCount: 0,
  skippedCount: 0,
  totalFetched: 0,
  errorMessage: null,
  startedAt: new Date("2026-01-01"),
  completedAt: null,
  createdAt: new Date("2026-01-01"),
};

/** Minimal prisma double covering the rows runSource touches. */
function fakePrisma() {
  return {
    importSource: {
      findFirst: vi.fn().mockResolvedValue(SOURCE_ROW),
      update: vi.fn().mockResolvedValue(SOURCE_ROW),
    },
    importRun: {
      update: vi
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ ...RUN_ROW, ...data }),
        ),
      create: vi.fn().mockResolvedValue(RUN_ROW),
      findFirst: vi.fn().mockResolvedValue(RUN_ROW),
    },
    requirement: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(() => Promise.resolve({ id: "req-1" })),
      update: vi.fn().mockResolvedValue({ id: "req-1" }),
    },
  };
}

function buildService(prisma: ReturnType<typeof fakePrisma>, jobEvents: JobEventEmitter) {
  const deps: ImportServiceDeps = {
    prisma: prisma as never,
    vault: {
      create: vi.fn(),
      read: vi.fn().mockResolvedValue({ plaintext: "ghp_test_token" }),
      delete: vi.fn(),
    } as never,
    enqueueTask: vi.fn(),
    createScheduledJob: vi.fn(),
    deleteScheduledJob: vi.fn(),
    resolveJira: vi.fn(),
    jobEvents,
  };
  return new ImportService(deps);
}

function issue(n: number) {
  return {
    externalId: String(n),
    externalSource: "github" as const,
    url: `https://github.com/octo/hello/issues/${n}`,
    title: `Issue ${n}`,
    body: "",
    labels: [],
  };
}

beforeEach(() => {
  importerRef.count.mockReset();
  importerRef.map.mockReset();
  importerRef.map.mockImplementation((i: ReturnType<typeof issue>) => ({
    externalId: i.externalId,
    externalSource: i.externalSource,
    externalUrl: i.url,
    title: i.title,
    body: i.body,
    type: "feature",
    priority: "medium",
    labels: i.labels,
    parentExternalId: null,
  }));
});

describe("ImportService.runSource job-lifecycle emits (#424)", () => {
  it("emits started → determinate progress → completed for an active run", async () => {
    importerRef.count.mockResolvedValue(2);
    importerRef.fetchAll = async function* (
      _f: unknown,
      ctx?: { onProgress?: (i: { fetched: number }) => void },
    ) {
      ctx?.onProgress?.({ fetched: 1 });
      yield issue(1);
      ctx?.onProgress?.({ fetched: 2 });
      yield issue(2);
    };
    const prisma = fakePrisma();
    const jobs = spyEmitter();

    const result = await buildService(prisma, jobs).runSource("src-1", {
      runId: "run-1",
      reportProgress: vi.fn(),
    });

    expect(result.status).toBe("completed");
    // started fires first, keyed by the run id, scoped to the project.
    expect(jobs.started).toHaveBeenCalledWith(
      "import-sync",
      "run-1",
      "proj-1",
      expect.stringContaining("Importing"),
    );
    // determinate progress reached 100% on the final streamed item.
    expect(jobs.progress).toHaveBeenCalledWith(
      "import-sync",
      "run-1",
      "proj-1",
      100,
      expect.stringContaining("2/2"),
    );
    // terminal success transition (drives the success toast).
    expect(jobs.completed).toHaveBeenCalledWith(
      "import-sync",
      "run-1",
      "proj-1",
      expect.stringContaining("Imported"),
    );
    expect(jobs.failed).not.toHaveBeenCalled();
  });

  it("emits a GENERIC failed message on importer error — no raw detail leaked", async () => {
    importerRef.count.mockResolvedValue(1);
    importerRef.fetchAll = async function* () {
      throw new Error("SECRET-TOKEN-abc123 leaked stack frame at /opt/app");
    };
    const prisma = fakePrisma();
    const jobs = spyEmitter();

    const result = await buildService(prisma, jobs).runSource("src-1", { runId: "run-1" });

    expect(result.status).toBe("failed");
    expect(jobs.completed).not.toHaveBeenCalled();
    expect(jobs.failed).toHaveBeenCalledWith(
      "import-sync",
      "run-1",
      "proj-1",
      genericFailureMessage("import-sync"),
    );
    // The user-safe message must NOT contain the raw error detail.
    const sentMessage = (jobs.failed as ReturnType<typeof vi.fn>).mock.calls[0][3] as string;
    expect(sentMessage).not.toContain("SECRET-TOKEN");
    expect(sentMessage).not.toContain("/opt/app");
  });

  it("degrades to indeterminate progress (pct 0) when count() is unavailable", async () => {
    importerRef.count.mockRejectedValue(new Error("count unsupported"));
    importerRef.fetchAll = async function* (
      _f: unknown,
      ctx?: { onProgress?: (i: { fetched: number }) => void },
    ) {
      ctx?.onProgress?.({ fetched: 1 });
      yield issue(1);
    };
    const prisma = fakePrisma();
    const jobs = spyEmitter();

    await buildService(prisma, jobs).runSource("src-1", { runId: "run-1" });

    // No misleading percentage: pct is 0 and the message omits a "/total".
    expect(jobs.progress).toHaveBeenCalledWith(
      "import-sync",
      "run-1",
      "proj-1",
      0,
      expect.stringMatching(/Fetched 1 issues$/),
    );
    expect(jobs.completed).toHaveBeenCalled();
  });
});
