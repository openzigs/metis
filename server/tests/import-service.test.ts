/**
 * Import service orchestration — preview, source CRUD, runs, ongoing sync, and
 * failure auto-disable. All collaborators are injected (no DB / network).
 */
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { SecretSummary } from "../src/lib/vault/vault-service.js";
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
  const summary: SecretSummary = {
    id: "secret_1",
    label: "import-token",
    description: "",
    scope: "project",
    keyVersion: 1,
    algorithm: "aes-256-gcm",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
  const vault = {
    create: vi.fn(async () => summary),
    read: vi.fn(async () => ({ summary, plaintext: "tok" })),
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

  it("a second source with the same label (the first deleted) stores its OWN token (#258)", async () => {
    // Like the real vault: `Secret.name` is UNIQUE, soft-deleted rows included.
    const names: string[] = [];
    const ctx = makeDeps();
    ctx.vault.create.mockImplementation(async (label: string, _t: string, scope: string) => {
      const name = `${scope}:${label}`;
      if (names.includes(name)) {
        throw Object.assign(new Error("Unique constraint failed on the fields: (`name`)"), {
          code: "P2002",
        });
      }
      names.push(name);
      return { id: `secret_${names.length}` };
    });
    const svc = new ImportService(ctx.deps);
    const first = await svc.createSource("p1", { ...ghFilter, token: "ghp_one" }, "user_1");
    await svc.deleteSource("p1", first.source.id, "user_1");

    const second = await svc.createSource("p1", { ...ghFilter, token: "ghp_two" }, "user_1");

    const stored = [...ctx.prisma.stores.importSource.values()] as Array<{
      id: string;
      secretId: string | null;
    }>;
    expect(stored.find((r) => r.id === second.source.id)?.secretId).toBe("secret_2");
    expect(ctx.vault.create.mock.calls[1][1]).toBe("ghp_two");
    expect(names[0]).toMatch(/^project:import-github-p1-GH-[0-9A-Z]{26}$/);
  });

  it("rejects a token-only source (Linear) with no token or vault secret", async () => {
    const svc = new ImportService(makeDeps().deps);
    await expect(
      svc.createSource(
        "p1",
        {
          source: "linear",
          label: "L",
          filter: { teamId: "t", includeArchived: false },
          syncEnabled: false,
          syncIntervalMinutes: 15,
        },
        "user_1",
      ),
    ).rejects.toMatchObject({ code: "IMPORT_TOKEN_REQUIRED" });
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

/** Headers a recorded fetch call sent, lower-cased. */
function sentHeaders(fetchFn: ReturnType<typeof vi.fn>, i: number): Record<string, string> {
  const init = (fetchFn.mock.calls[i]?.[1] ?? {}) as { headers?: Record<string, string> };
  return Object.fromEntries(
    Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]),
  );
}

describe("#763 — vault secret and unauthenticated GitHub import", () => {
  it("preview with a bound vault secret reads it BY ID and sends it, vaulting nothing", async () => {
    const fetchFn = githubFetch([ghIssue(1)]);
    const ctx = makeDeps({
      importerDeps: { fetchFn, assertHostAllowed: () => undefined },
    });
    ctx.vault.read.mockResolvedValue({ summary: {}, plaintext: "ghp_from_vault" });
    const svc = new ImportService(ctx.deps);
    const preview = await svc.preview(
      "p1",
      { source: "github", filter: { owner: "o", repo: "r", state: "open" } },
      { secretId: "sec_vaulted" },
    );
    expect(preview.count).toBe(1);
    expect(ctx.vault.read).toHaveBeenCalledWith("sec_vaulted");
    expect(ctx.vault.create).not.toHaveBeenCalled();
    expect(sentHeaders(fetchFn, 0).authorization).toBe("Bearer ghp_from_vault");
    expect(preview.warnings ?? []).toEqual([]);
  });

  it("preview of a public GitHub repo with no credential is anonymous and warns about rate limits", async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/graphql")) return res(401, { message: "auth required" });
      if (u.includes("/search/issues")) return res(200, { total_count: 3 });
      return res(200, [ghIssue(1), ghIssue(2), ghIssue(3)]);
    });
    const ctx = makeDeps({ importerDeps: { fetchFn, assertHostAllowed: () => undefined } });
    const svc = new ImportService(ctx.deps);
    const preview = await svc.preview("p1", {
      source: "github",
      filter: { owner: "miniflux", repo: "v2", state: "open" },
    });
    expect(preview.count).toBe(3);
    expect(preview.sample).toHaveLength(3);
    for (let i = 0; i < fetchFn.mock.calls.length; i++) {
      expect(sentHeaders(fetchFn, i)).not.toHaveProperty("authorization");
      expect(String(fetchFn.mock.calls[i][0])).not.toContain("/graphql");
    }
    expect(preview.warnings?.[0]).toMatch(/rate limit/i);
    expect(ctx.vault.read).not.toHaveBeenCalled();
  });

  it("still requires a credential for Azure DevOps preview", async () => {
    const svc = new ImportService(makeDeps().deps);
    await expect(
      svc.preview("p1", {
        source: "azure-devops",
        filter: { organization: "o", project: "p" },
      }),
    ).rejects.toMatchObject({ code: "IMPORT_TOKEN_REQUIRED" });
  });

  it("createSource with a bound vault secret stores that id and creates no new secret", async () => {
    const ctx = makeDeps();
    const svc = new ImportService(ctx.deps);
    const { source } = await svc.createSource("p1", ghFilter, "user_1", {
      secretId: "sec_vaulted",
    });
    expect(ctx.vault.create).not.toHaveBeenCalled();
    const row = ctx.prisma.stores.importSource.get(source.id) as Row;
    expect(row.secretId).toBe("sec_vaulted");
    expect(row.secretBound).toBe(true);
    expect(source.hasToken).toBe(true);
    expect(source.usesVaultSecret).toBe(true);
  });

  it("a pasted token is still vaulted per source and is NOT marked as a bound secret", async () => {
    const ctx = makeDeps();
    const svc = new ImportService(ctx.deps);
    const { source } = await svc.createSource("p1", { ...ghFilter, token: "ghp_x" }, "user_1");
    const row = ctx.prisma.stores.importSource.get(source.id) as Row;
    expect(row.secretBound).toBe(false);
    expect(source.usesVaultSecret).toBe(false);
  });

  it("refuses a request carrying both a pasted token and a bound vault secret", async () => {
    const ctx = makeDeps();
    const svc = new ImportService(ctx.deps);
    await expect(
      svc.createSource("p1", { ...ghFilter, token: "ghp_x" }, "user_1", { secretId: "s" }),
    ).rejects.toMatchObject({ code: "IMPORT_CREDENTIAL_CONFLICT" });
    await expect(
      svc.preview(
        "p1",
        { source: "github", filter: { owner: "o", repo: "r", state: "open" }, token: "t" },
        { secretId: "s" },
      ),
    ).rejects.toMatchObject({ code: "IMPORT_CREDENTIAL_CONFLICT" });
    expect(ctx.vault.create).not.toHaveBeenCalled();
  });

  it("a public GitHub source can be created with no credential at all", async () => {
    const ctx = makeDeps();
    const svc = new ImportService(ctx.deps);
    const { source } = await svc.createSource("p1", ghFilter, "user_1");
    expect(source.hasToken).toBe(false);
    expect(ctx.vault.create).not.toHaveBeenCalled();
  });

  it("deleting a source never deletes a vault secret it only referred to", async () => {
    const ctx = makeDeps();
    const svc = new ImportService(ctx.deps);
    const { source } = await svc.createSource("p1", ghFilter, "user_1", {
      secretId: "sec_vaulted",
    });
    await svc.deleteSource("p1", source.id, "user_1");
    expect(ctx.vault.delete).not.toHaveBeenCalled();
  });

  it("deleting a source still deletes the secret it vaulted for itself", async () => {
    const ctx = makeDeps();
    const svc = new ImportService(ctx.deps);
    const { source } = await svc.createSource("p1", { ...ghFilter, token: "ghp_x" }, "user_1");
    await svc.deleteSource("p1", source.id, "user_1");
    expect(ctx.vault.delete).toHaveBeenCalledWith("secret_1");
  });
});
