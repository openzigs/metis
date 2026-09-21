/**
 * Import service orchestration — preview, source CRUD, runs, ongoing sync, and
 * failure auto-disable. All collaborators are injected (no DB / network).
 */
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  ImportService,
  getImportService,
  __resetImportService,
  intervalToCron,
  type ImportServiceDeps,
} from "../src/lib/importers/import-service.js";

function res(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

interface Row {
  id: string;
  [k: string]: unknown;
}

/** Minimal in-memory Prisma double for the tables the service touches. */
function makePrisma() {
  const importSource = new Map<string, Row>();
  const importRun = new Map<string, Row>();
  const analysis = new Map<string, Row>();
  const requirement = new Map<string, Row>();
  let seq = 0;
  const id = (p: string) => `${p}_${(seq += 1)}`;

  const matches = (row: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === "object" && !(v instanceof Date)) return true; // skip nested filters
      return (row as Record<string, unknown>)[k] === v;
    });

  function table(store: Map<string, Row>, prefix: string, defaults: () => Row) {
    return {
      findMany: vi.fn(async ({ where = {} }: { where?: Record<string, unknown> } = {}) =>
        [...store.values()].filter((r) => matches(r, where)),
      ),
      findFirst: vi.fn(async ({ where = {} }: { where?: Record<string, unknown> } = {}) => {
        const hits = [...store.values()].filter((r) => matches(r, where));
        return hits[hits.length - 1] ?? null;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { ...defaults(), ...data, id: id(prefix) } as Row;
        store.set(row.id, row);
        return row;
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = { ...(store.get(where.id) as Row), ...data };
          store.set(where.id, row);
          return row;
        },
      ),
    };
  }

  const prisma = {
    importSource: table(importSource, "src", () => ({
      id: "",
      consecutiveFailures: 0,
      syncEnabled: false,
      syncIntervalMinutes: 15,
      scheduledJobId: null,
      secretId: null,
      baseUrl: null,
      jiraConnectionId: null,
      disabledReason: null,
      lastRunAt: null,
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
    importRun: table(importRun, "run", () => ({
      id: "",
      taskId: null,
      createdCount: 0,
      updatedCount: 0,
      skippedCount: 0,
      totalFetched: 0,
      errorMessage: null,
      startedAt: null,
      completedAt: null,
      createdAt: new Date(),
    })),
    analysis: table(analysis, "an", () => ({ id: "" })),
    requirement: table(requirement, "req", () => ({ id: "", deletedAt: null })),
  };
  return { prisma, stores: { importSource, importRun, analysis, requirement } };
}

function githubFetch(issues: unknown[]) {
  return vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("/graphql"))
      return res(200, { data: { search: { issueCount: issues.length } } });
    return res(200, issues);
  });
}

function ghIssue(n: number) {
  return {
    number: n,
    title: `Issue ${n}`,
    body: "b",
    html_url: `u${n}`,
    state: "open",
    labels: [],
  };
}

function makeDeps(over: Partial<ImportServiceDeps> = {}): {
  deps: ImportServiceDeps;
  prisma: ReturnType<typeof makePrisma>;
  vault: {
    create: ReturnType<typeof vi.fn>;
    read: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  enqueueTask: ReturnType<typeof vi.fn>;
  createScheduledJob: ReturnType<typeof vi.fn>;
  deleteScheduledJob: ReturnType<typeof vi.fn>;
} {
  const p = makePrisma();
  const vault = {
    create: vi.fn(async () => ({ id: "secret_1" })),
    read: vi.fn(async () => ({ summary: { id: "secret_1" }, plaintext: "tok" })),
    delete: vi.fn(async () => undefined),
  };
  const enqueueTask = vi.fn(async () => ({ id: "task_1" }));
  const createScheduledJob = vi.fn(async () => ({ id: "job_1" }));
  const deleteScheduledJob = vi.fn(async () => undefined);
  const deps: ImportServiceDeps = {
    prisma: p.prisma as unknown as PrismaClient,
    vault,
    enqueueTask,
    createScheduledJob,
    deleteScheduledJob,
    resolveJira: vi.fn(async () => ({
      client: { searchIssues: async () => ({ startAt: 0, maxResults: 0, total: 0, issues: [] }) },
      baseUrl: "https://jira.example.com",
    })),
    importerDeps: {
      fetchFn: githubFetch([ghIssue(1), ghIssue(2)]),
      assertHostAllowed: () => undefined,
      backoff: { sleep: async () => undefined, now: () => 0, random: () => 0 },
    },
    now: () => new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
  return { deps, prisma: p, vault, enqueueTask, createScheduledJob, deleteScheduledJob };
}

const ghFilter = {
  source: "github" as const,
  label: "GH",
  filter: { owner: "o", repo: "r", state: "open" as const },
  syncEnabled: false,
  syncIntervalMinutes: 15,
};

describe("intervalToCron", () => {
  it("collapses whole hours and daily intervals", () => {
    expect(intervalToCron(15)).toBe("*/15 * * * *");
    expect(intervalToCron(120)).toBe("0 */2 * * *");
    expect(intervalToCron(1440)).toBe("0 0 * * *");
  });
});

describe("ImportService.preview", () => {
  it("returns a count and a mapped sample", async () => {
    const { deps } = makeDeps();
    const svc = new ImportService(deps);
    const preview = await svc.preview("p1", {
      source: "github",
      filter: { owner: "o", repo: "r", state: "open" },
      token: "t",
    });
    expect(preview.count).toBe(2);
    expect(preview.sample).toHaveLength(2);
    expect(preview.sample[0].title).toBe("Issue 1");
  });

  it("honours the sample-size cap", async () => {
    const { deps } = makeDeps({
      importerDeps: {
        fetchFn: githubFetch([ghIssue(1), ghIssue(2), ghIssue(3)]),
        assertHostAllowed: () => undefined,
      },
      sampleSize: 1,
    });
    const svc = new ImportService(deps);
    const preview = await svc.preview("p1", {
      source: "github",
      filter: { owner: "o", repo: "r", state: "open" },
      token: "t",
    });
    expect(preview.sample).toHaveLength(1);
  });
});

describe("ImportService.createSource", () => {
  it("creates an anchor analysis, stores the token, and enqueues the first run", async () => {
    const ctx = makeDeps();
    const svc = new ImportService(ctx.deps);
    const { source, run } = await svc.createSource(
      "p1",
      { ...ghFilter, token: "ghp_xxx" },
      "user_1",
    );
    expect(ctx.prisma.stores.analysis.size).toBe(1);
    expect(ctx.vault.create).toHaveBeenCalled();
    expect(ctx.enqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({ type: "import.run", trigger: "manual" }),
    );
    expect(source.hasToken).toBe(true);
    expect(run.taskId).toBe("task_1");
  });

  it("rejects a token-based source with no token", async () => {
    const svc = new ImportService(makeDeps().deps);
    await expect(svc.createSource("p1", ghFilter, "user_1")).rejects.toThrow(/token/i);
  });

  it("validates the Jira connection up-front and stores no token", async () => {
    const ctx = makeDeps();
    const svc = new ImportService(ctx.deps);
    const { source } = await svc.createSource(
      "p1",
      {
        source: "jira",
        label: "J",
        filter: { connectionId: "conn_1", jql: "project=X" },
        syncEnabled: false,
        syncIntervalMinutes: 15,
      },
      "user_1",
    );
    expect(ctx.deps.resolveJira).toHaveBeenCalledWith("conn_1", "p1");
    expect(source.hasToken).toBe(false);
    expect(ctx.vault.create).not.toHaveBeenCalled();
  });

  it("creates a scheduled job when sync is enabled on creation", async () => {
    const ctx = makeDeps();
    const svc = new ImportService(ctx.deps);
    const { source } = await svc.createSource(
      "p1",
      { ...ghFilter, token: "t", syncEnabled: true },
      "user_1",
    );
    expect(ctx.createScheduledJob).toHaveBeenCalled();
    expect(source.syncEnabled).toBe(true);
  });
});

describe("ImportService.runSource", () => {
  it("imports requirements and records a completed run", async () => {
    const ctx = makeDeps();
    const svc = new ImportService(ctx.deps);
    ctx.prisma.stores.importSource.set("src_1", {
      id: "src_1",
      projectId: "p1",
      analysisId: "an_1",
      source: "github",
      label: "GH",
      filter: JSON.stringify({ owner: "o", repo: "r", state: "open" }),
      baseUrl: null,
      jiraConnectionId: null,
      secretId: "secret_1",
      syncEnabled: false,
      scheduledJobId: null,
      consecutiveFailures: 0,
      createdById: "user_1",
      deletedAt: null,
    });
    const run = await svc.runSource("src_1", { trigger: "manual" });
    expect(run.status).toBe("completed");
    expect(run.createdCount).toBe(2);
    expect(ctx.prisma.stores.requirement.size).toBe(2);
  });

  it("auto-disables sync after the failure threshold", async () => {
    const ctx = makeDeps({
      importerDeps: {
        fetchFn: githubFetch([]),
        assertHostAllowed: () => undefined,
        backoff: { sleep: async () => undefined, now: () => 0, random: () => 0 },
      },
    });
    // Force the REST page to 404 → ImporterHttpError inside runImport.
    (ctx.deps.importerDeps!.fetchFn as ReturnType<typeof vi.fn>).mockImplementation(
      async (url: string) =>
        String(url).includes("/graphql")
          ? res(200, { data: { search: { issueCount: 0 } } })
          : res(404, "gone"),
    );
    const svc = new ImportService(ctx.deps);
    ctx.prisma.stores.importSource.set("src_1", {
      id: "src_1",
      projectId: "p1",
      analysisId: "an_1",
      source: "github",
      label: "GH",
      filter: JSON.stringify({ owner: "o", repo: "r", state: "open" }),
      baseUrl: null,
      jiraConnectionId: null,
      secretId: "secret_1",
      syncEnabled: true,
      scheduledJobId: "job_1",
      consecutiveFailures: 2,
      createdById: "user_1",
      deletedAt: null,
    });
    const run = await svc.runSource("src_1", { trigger: "scheduled" });
    expect(run.status).toBe("failed");
    expect(ctx.deleteScheduledJob).toHaveBeenCalledWith("job_1", "user_1");
    const updated = ctx.prisma.stores.importSource.get("src_1")!;
    expect(updated.syncEnabled).toBe(false);
    expect(updated.disabledReason).toMatch(/auto-disabled/);
  });

  it("calls notifySyncDisabled when sync is auto-disabled on threshold failure", async () => {
    const notifySyncDisabled = vi.fn();
    const ctx = makeDeps({
      notifySyncDisabled,
      importerDeps: {
        fetchFn: githubFetch([]),
        assertHostAllowed: () => undefined,
        backoff: { sleep: async () => undefined, now: () => 0, random: () => 0 },
      },
    });
    // Force the REST page to 404 → ImporterHttpError inside runImport.
    (ctx.deps.importerDeps!.fetchFn as ReturnType<typeof vi.fn>).mockImplementation(
      async (url: string) =>
        String(url).includes("/graphql")
          ? res(200, { data: { search: { issueCount: 0 } } })
          : res(404, "gone"),
    );
    const svc = new ImportService(ctx.deps);
    ctx.prisma.stores.importSource.set("src_1", {
      id: "src_1",
      projectId: "p1",
      analysisId: "an_1",
      source: "github",
      label: "GH",
      filter: JSON.stringify({ owner: "o", repo: "r", state: "open" }),
      baseUrl: null,
      jiraConnectionId: null,
      secretId: "secret_1",
      syncEnabled: true,
      scheduledJobId: "job_1",
      consecutiveFailures: 2,
      createdById: "user_1",
      deletedAt: null,
    });
    const run = await svc.runSource("src_1", { trigger: "scheduled" });
    expect(run.status).toBe("failed");
    expect(notifySyncDisabled).toHaveBeenCalledOnce();
    expect(notifySyncDisabled).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "p1",
        importSourceId: "src_1",
        consecutiveFailures: 3,
      }),
    );
  });

  it("throws a 404 for a missing source", async () => {
    const svc = new ImportService(makeDeps().deps);
    await expect(svc.runSource("nope")).rejects.toThrow(/not found/i);
  });

  it("reuses an existing pending run and updates on re-import", async () => {
    const ctx = makeDeps();
    const svc = new ImportService(ctx.deps);
    ctx.prisma.stores.importSource.set("src_1", {
      id: "src_1",
      projectId: "p1",
      analysisId: "an_1",
      source: "github",
      label: "GH",
      filter: JSON.stringify({ owner: "o", repo: "r", state: "open" }),
      baseUrl: null,
      jiraConnectionId: null,
      secretId: "secret_1",
      syncEnabled: false,
      scheduledJobId: null,
      consecutiveFailures: 0,
      createdById: "user_1",
      deletedAt: null,
    });
    ctx.prisma.stores.importRun.set("run_seed", {
      id: "run_seed",
      importSourceId: "src_1",
      projectId: "p1",
      trigger: "manual",
      status: "pending",
      taskId: "task_1",
      createdCount: 0,
      updatedCount: 0,
      skippedCount: 0,
      totalFetched: 0,
      errorMessage: null,
      startedAt: null,
      completedAt: null,
      createdAt: new Date(),
    });
    const first = await svc.runSource("src_1", { runId: "run_seed" });
    expect(first.id).toBe("run_seed");
    expect(first.createdCount).toBe(2);
    // Re-run: the two requirements already exist → update path.
    const second = await svc.runSource("src_1", { trigger: "manual" });
    expect(second.updatedCount).toBe(2);
    expect(second.createdCount).toBe(0);
  });
});

describe("ImportService ongoing sync + delete", () => {
  function seedSource(ctx: ReturnType<typeof makeDeps>, over: Record<string, unknown> = {}) {
    ctx.prisma.stores.importSource.set("src_1", {
      id: "src_1",
      projectId: "p1",
      analysisId: "an_1",
      source: "github",
      label: "GH",
      filter: JSON.stringify({ owner: "o", repo: "r", state: "open" }),
      baseUrl: null,
      jiraConnectionId: null,
      secretId: "secret_1",
      syncEnabled: false,
      syncIntervalMinutes: 15,
      scheduledJobId: null,
      consecutiveFailures: 0,
      disabledReason: null,
      lastRunAt: null,
      createdById: "user_1",
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
      ...over,
    });
  }

  it("enables sync by creating a scheduled job", async () => {
    const ctx = makeDeps();
    seedSource(ctx);
    const svc = new ImportService(ctx.deps);
    const view = await svc.setSync(
      "p1",
      "src_1",
      { syncEnabled: true, syncIntervalMinutes: 30 },
      "user_1",
    );
    expect(ctx.createScheduledJob).toHaveBeenCalledWith(
      expect.objectContaining({ cron: "*/30 * * * *", taskType: "import.run" }),
    );
    expect(view.syncEnabled).toBe(true);
  });

  it("disables sync by deleting the scheduled job", async () => {
    const ctx = makeDeps();
    seedSource(ctx, { syncEnabled: true, scheduledJobId: "job_1" });
    const svc = new ImportService(ctx.deps);
    const view = await svc.setSync("p1", "src_1", { syncEnabled: false }, "user_1");
    expect(ctx.deleteScheduledJob).toHaveBeenCalledWith("job_1", "user_1");
    expect(view.syncEnabled).toBe(false);
  });

  it("soft-deletes a source and cleans up its job + secret", async () => {
    const ctx = makeDeps();
    seedSource(ctx, { scheduledJobId: "job_1" });
    const svc = new ImportService(ctx.deps);
    await svc.deleteSource("p1", "src_1", "user_1");
    expect(ctx.deleteScheduledJob).toHaveBeenCalledWith("job_1", "user_1");
    expect(ctx.vault.delete).toHaveBeenCalledWith("secret_1");
    expect(ctx.prisma.stores.importSource.get("src_1")!.deletedAt).not.toBeNull();
  });

  it("lists runs and throws 404 for a missing source", async () => {
    const ctx = makeDeps();
    const svc = new ImportService(ctx.deps);
    await expect(svc.getSource("p1", "missing")).rejects.toThrow(/not found/i);
    expect(await svc.listRuns("p1")).toEqual([]);
  });

  it("lists sources with their most recent run", async () => {
    const ctx = makeDeps();
    seedSource(ctx);
    ctx.prisma.stores.importRun.set("run_a", {
      id: "run_a",
      importSourceId: "src_1",
      projectId: "p1",
      trigger: "manual",
      status: "completed",
      taskId: "task_1",
      createdCount: 5,
      updatedCount: 0,
      skippedCount: 0,
      totalFetched: 5,
      errorMessage: null,
      startedAt: new Date(),
      completedAt: new Date(),
      createdAt: new Date(),
    });
    const views = await new ImportService(ctx.deps).listSources("p1");
    expect(views).toHaveLength(1);
    expect(views[0].lastRun?.createdCount).toBe(5);
    expect(views[0].hasToken).toBe(true);
  });

  it("previews a Jira source by resolving the connection", async () => {
    const ctx = makeDeps({
      resolveJira: vi.fn(async () => ({
        client: { searchIssues: async () => ({ startAt: 0, maxResults: 0, total: 0, issues: [] }) },
        baseUrl: "https://jira.example.com",
      })),
    });
    const preview = await new ImportService(ctx.deps).preview("p1", {
      source: "jira",
      filter: { connectionId: "conn_1", jql: "project=X" },
    });
    expect(preview.count).toBe(0);
    expect(ctx.deps.resolveJira).toHaveBeenCalledWith("conn_1", "p1");
  });
});

describe("getImportService singleton", () => {
  it("returns a stable instance and can be reset", () => {
    __resetImportService();
    const a = getImportService();
    const b = getImportService();
    expect(a).toBe(b);
    __resetImportService();
    expect(getImportService()).not.toBe(a);
    __resetImportService();
  });
});

describe("ImportService.enqueueRun", () => {
  it("creates a pending run row, enqueues a task, and returns the run view", async () => {
    const ctx = makeDeps();
    const svc = new ImportService(ctx.deps);
    ctx.prisma.stores.importSource.set("src_1", {
      id: "src_1",
      projectId: "p1",
      analysisId: "an_1",
      source: "github",
      label: "GH",
      filter: JSON.stringify({ owner: "o", repo: "r", state: "open" }),
      baseUrl: null,
      jiraConnectionId: null,
      secretId: null,
      syncEnabled: false,
      scheduledJobId: null,
      consecutiveFailures: 0,
      createdById: "user_1",
      deletedAt: null,
    });
    const run = await svc.enqueueRun("src_1", { trigger: "manual", userId: "user_1" });
    expect(run.status).toBe("pending");
    expect(run.taskId).toBe("task_1");
    expect(ctx.enqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "import.run",
        trigger: "manual",
        projectId: "p1",
        createdById: "user_1",
      }),
    );
  });

  it("throws a 404 for a missing or deleted source", async () => {
    const svc = new ImportService(makeDeps().deps);
    await expect(svc.enqueueRun("nonexistent", {})).rejects.toThrow(/not found/i);
  });
});
