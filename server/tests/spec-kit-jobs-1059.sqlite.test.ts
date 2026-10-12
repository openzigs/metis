/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are read as untyped JSON */
/**
 * #1059 — Spec Kit commands as background jobs, on a REAL SQLite database built
 * from the migration chain and driven through the REAL router: real auth, real
 * workspace scope, real gates, real artifact stores, the real `spec_kit_jobs`
 * table with its unique index. Only the model is a stub, and it answers when
 * the test tells it to — which is what "a command that takes minutes" needs.
 *
 * No assertion here bounds how FAST something happened. Every wait is on a
 * state the test polls for, with a ceiling far above anything a loaded CI
 * runner needs.
 *
 * What is where: this file is the commands end to end. The job runner's rules
 * race by race are `helpers/spec-kit-job-rules.ts`, run on this same real store
 * (`spec-kit-job-rules-1059.sqlite.test.ts`); the store's statements one by one
 * are `helpers/spec-kit-job-store-contract.ts`, run on SQLite and on Postgres.
 */
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

interface PendingCall {
  prompt: string;
  signal: AbortSignal | undefined;
  resolve: (reply: StubReply) => void;
}
interface StubReply {
  content: string;
  finishReason?: string;
  tokens?: number;
  /** The provider call rejects with this instead of answering. */
  throws?: unknown;
}

const state = vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX = "100000";
  process.env.AI_OFFLINE = "1";
  return {
    db: null as unknown,
    /** Model calls waiting for the test to answer them, oldest first. */
    pending: [] as PendingCall[],
    /** Replies given at once, without waiting (used before `pending`). */
    auto: [] as StubReply[],
    /** When true the stub provider does not notice an abort: it answers late. */
    ignoreAbort: false,
    /** Every commit point a job reached: "ok", or the error it was refused with. */
    commits: [] as unknown[],
    /** Every model call a stopped job tried to make and was refused. */
    refusedCalls: [] as unknown[],
    /** Every audit event recorded. */
    audits: [] as Array<Record<string, any>>,
  };
});
vi.mock("../src/lib/prisma.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return {
    get prisma() {
      return state.db;
    },
    Prisma,
  };
});
vi.mock("../src/lib/audit/audit-service.js", () => ({
  audit: vi.fn((event: Record<string, any>) => {
    state.audits.push(event);
  }),
  getAuditService: vi.fn(() => ({ record: vi.fn() })),
}));
// Retrieval is not what this suite is about, and the production wiring reaches
// for the vector store: every command here runs ungrounded.
vi.mock("../src/lib/spec-kit/rag-context.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  buildSpecKitRagContext: vi.fn(async () => ({
    context: "",
    usedChunks: 0,
    usedSymbols: 0,
    files: [],
    dropped: [],
  })),
}));
// Observe (never change) the point at which a job starts saving.
vi.mock("../src/lib/spec-kit/job-scope.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/spec-kit/job-scope.js")>();
  return {
    ...real,
    specKitJobCommitPoint: async () => {
      if (!real.currentSpecKitJob()) return real.specKitJobCommitPoint();
      try {
        await real.specKitJobCommitPoint();
        state.commits.push("ok");
      } catch (err) {
        state.commits.push(err);
        throw err;
      }
    },
    // …and every model call a stopped job was refused before it was sent.
    throwIfSpecKitJobStopped: () => {
      try {
        real.throwIfSpecKitJobStopped();
      } catch (err) {
        state.refusedCalls.push(err);
        throw err;
      }
    },
  };
});
vi.mock("../src/lib/ai/project-provider.js", () => ({
  resolveProjectProvider: vi.fn(async () => ({
    key: "offline-stub",
    model: "stub",
    offline: false,
    chat(messages: Array<{ content: unknown }>, opts?: { signal?: AbortSignal }) {
      const respond = (reply: StubReply) => {
        const tokens = reply.tokens ?? 2;
        return {
          content: reply.content,
          provider: "offline-stub",
          model: "stub",
          usage: { promptTokens: tokens - 1, completionTokens: 1, totalTokens: tokens },
          finishReason: reply.finishReason ?? "stop",
        };
      };
      const auto = state.auto.shift();
      if (auto?.throws) return Promise.reject(auto.throws);
      if (auto) return Promise.resolve(respond(auto));
      return new Promise((resolve, reject) => {
        const signal = opts?.signal;
        if (signal && !state.ignoreAbort) {
          const abort = (): void =>
            reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
          if (signal.aborted) return abort();
          signal.addEventListener("abort", abort, { once: true });
        }
        state.pending.push({
          prompt: String(messages[0]?.content ?? ""),
          signal,
          resolve: (reply) => resolve(respond(reply)),
        });
      });
    },
  })),
}));

const { specKitRouter } = await import("../src/routes/spec-kit.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { setSpecKitEnabled, writeArtifact, getArtifact } =
  await import("../src/lib/spec-kit/artifacts.js");
const { createFeature, listFeatures } = await import("../src/lib/spec-kit/features.js");
const { writeFeatureArtifact, getFeatureArtifact, listFeatureArtifacts } =
  await import("../src/lib/spec-kit/feature-artifacts.js");
const { failInterruptedSpecKitJobs, startSpecKitJob, SPEC_KIT_JOB_STALE_MS } =
  await import("../src/lib/spec-kit/jobs.js");
const { SpecKitJobStopError } = await import("../src/lib/spec-kit/job-scope.js");
const { findJob, markJobCancelling } = await import("../src/lib/spec-kit/job-store.js");
const { runPlan } = await import("../src/lib/spec-kit/commands/plan.js");
const { resolveProjectProvider } = await import("../src/lib/ai/project-provider.js");
const { AIProviderError } = await import("../src/lib/ai/errors.js");
const { stopLiveSpecKitJobs } = await import("./helpers/spec-kit-jobs-reset.js");

const PA = "proj-1059-a";
const PB = "proj-1059-b";
const SPEC =
  "# Spec\nMark entries read.\n\n## Acceptance criteria\n- **AC-1**: older entries are read";
const PLAN =
  "# Plan\nExtend `internal/storage/entry.go`.\n\n## Components\nNo REST surface change.";
const TASKS = "## Tasks\n\n- [ ] T01 — Add the storage call (satisfies: AC-1) depends-on: none";
/** Far above what any step here needs, far below the test timeout. */
const WAIT = { timeout: 12_000, interval: 15 };

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1059 — Spec Kit commands as background jobs (real router, real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let owner = "";
    let reader = "";
    let outsider = "";
    /** Another member of the owner's project who may also start and cancel. */
    let member = "";
    /** A member no other test uses: their per-user budgets are untouched. */
    let fresh = "";
    let nextSlug = 0;

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/projects/:projectId/spec-kit", specKitRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const base = (project = PA): string => `/api/projects/${project}/spec-kit`;
    const post = (path: string, body: Record<string, unknown> = {}, token = owner) =>
      request(app()).post(path).set("Authorization", `Bearer ${token}`).send(body);
    const get = (path: string, token = owner) =>
      request(app()).get(path).set("Authorization", `Bearer ${token}`);
    const startJob = (cmd: string, body: Record<string, unknown> = {}, token = owner) =>
      post(`${base()}/commands/${cmd}/jobs`, body, token);
    const runSync = (cmd: string, body: Record<string, unknown> = {}, token = owner) =>
      post(`${base()}/commands/${cmd}`, body, token);

    /** The next model call a command makes, once it is waiting on the stub. */
    const nextCall = async (): Promise<PendingCall> => {
      await vi.waitFor(() => expect(state.pending.length).toBeGreaterThan(0), WAIT);
      return state.pending.shift()!;
    };
    /** Poll a job until it is terminal. */
    const finished = async (jobId: string, project = PA) => {
      let job: Record<string, any> = {};
      await vi.waitFor(async () => {
        job = (await get(`${base(project)}/jobs/${jobId}`)).body.data.job;
        expect(["succeeded", "failed", "cancelled"]).toContain(job.status);
      }, WAIT);
      return job;
    };
    /** A feature with spec.md and plan.md — everything `speckit.tasks` needs. */
    const planned = async (): Promise<{ slug: string; id: string }> => {
      nextSlug += 1;
      const slug = `${String(nextSlug).padStart(3, "0")}-feature`;
      const feature = await createFeature({ projectId: PA, title: slug, forcedSlug: slug });
      await writeFeatureArtifact({ featureId: feature.id, key: "spec.md", content: SPEC });
      await writeFeatureArtifact({ featureId: feature.id, key: "plan.md", content: PLAN });
      return { slug, id: feature.id };
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1059-speckit-jobs");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      for (const id of ["u-owner", "u-reader", "u-out", "u-member", "u-fresh"]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
      }
      await db.workspace.create({ data: { id: "ws-a", name: "A", slug: "ws-1059-a" } });
      await db.workspace.create({ data: { id: "ws-b", name: "B", slug: "ws-1059-b" } });
      for (const [workspaceId, userId] of [
        ["ws-a", "u-owner"],
        ["ws-a", "u-reader"],
        ["ws-a", "u-member"],
        ["ws-a", "u-fresh"],
        ["ws-b", "u-out"],
      ]) {
        await db.workspaceMember.create({ data: { workspaceId, userId, role: "member" } });
      }
      for (const [id, workspaceId, createdById] of [
        [PA, "ws-a", "u-owner"],
        [PB, "ws-b", "u-out"],
      ]) {
        await db.project.create({
          data: { id, name: id, slug: id, description: "", createdById, workspaceId },
        });
        await setSpecKitEnabled(id, true, createdById);
        await writeArtifact({ projectId: id, name: "constitution.md", content: "# Principles" });
      }
      const token = (userId: string, role: string, workspaces: string[]): string =>
        issueTokens({ userId, username: userId, role: role as never, permissions: [], workspaces })
          .accessToken;
      owner = token("u-owner", "coordinator", ["ws-a"]);
      reader = token("u-reader", "reader", ["ws-a"]);
      member = token("u-member", "coordinator", ["ws-a"]);
      fresh = token("u-fresh", "coordinator", ["ws-a"]);
      // The same role as the owner, in the other workspace: only the project differs.
      outsider = token("u-out", "coordinator", ["ws-b"]);
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(async () => {
      vi.useRealTimers();
      stopLiveSpecKitJobs();
      state.audits.length = 0;
      state.pending.length = 0;
      state.auto.length = 0;
      state.commits.length = 0;
      state.refusedCalls.length = 0;
      state.ignoreAbort = false;
      await db.specKitJob.deleteMany({});
      await db.tokenUsage.deleteMany({});
      await db.project.update({ where: { id: PA }, data: { monthlyTokenBudget: null } });
    });

    describe("start, progress, completion", () => {
      it("answers 202 while the model is still working, then stores the synchronous route's payload", async () => {
        const f = await planned();

        const started = await startJob("speckit.tasks", { featureSlug: f.slug });

        // The response is here; the model has not answered and nothing is saved.
        expect(started.status).toBe(202);
        const jobId: string = started.body.data.jobId;
        expect(started.headers.location).toBe(`${base()}/jobs/${jobId}`);
        expect(started.body.data.job).toMatchObject({
          id: jobId,
          projectId: PA,
          command: "speckit.tasks",
          featureSlug: f.slug,
          status: "running",
          startedById: "u-owner",
        });
        const call = await nextCall();
        expect(call.prompt).toContain("Produce tasks.md");
        expect(await getFeatureArtifact(f.id, "tasks.md")).toBeNull();
        const running = (await get(`${base()}/jobs/${jobId}`)).body.data.job;
        expect(running.status).toBe("running");
        expect(running.phase).toBe("Waiting for the model (/tasks)");
        expect(running).not.toHaveProperty("result");
        expect((await get(`${base()}/jobs`)).body.data.jobs.map((j: any) => j.id)).toEqual([jobId]);

        call.resolve({ content: TASKS });
        const job = await finished(jobId);

        expect(job.status).toBe("succeeded");
        expect(job.result).toMatchObject({
          command: "tasks",
          artifactName: "tasks.md",
          featureSlug: f.slug,
          tokensUsed: 2,
        });
        expect(job.result.artifact).toMatchObject({ key: "tasks.md", version: 1, content: TASKS });
        expect((await getFeatureArtifact(f.id, "tasks.md"))?.content).toBe(TASKS);
        expect((await get(`${base()}/jobs`)).body.data.jobs).toEqual([]);

        // The same command on the synchronous route returns the same payload.
        state.auto.push({ content: TASKS });
        const sync = await runSync("speckit.tasks", { featureSlug: f.slug });
        expect(sync.status).toBe(200);
        const { jobId: syncJobId, ...payload } = sync.body.data;
        expect(Object.keys(payload).sort()).toEqual(Object.keys(job.result).sort());
        expect(payload).toMatchObject({ command: "tasks", artifactName: "tasks.md" });
        // …and it ran as a job too: a caller that lost the response can still read it.
        expect((await finished(syncJobId)).result.artifact.version).toBe(2);
      });

      it("records each model call in token_usages against the project, the step and the user", async () => {
        const f = await planned();
        state.auto.push({ content: TASKS, tokens: 40 });
        const started = await startJob("speckit.tasks", { featureSlug: f.slug });
        await finished(started.body.data.jobId);

        await vi.waitFor(async () => {
          const rows = await db.tokenUsage.findMany({ where: { projectId: PA } });
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({
            agentStep: "spec-kit.tasks",
            userId: "u-owner",
            totalTokens: 40,
            provider: "offline-stub",
          });
        }, WAIT);
      });

      it("walks the plan's five artifacts as phases, and saves the set only at the end", async () => {
        const f = await planned();
        const started = await startJob("speckit.plan", { featureSlug: f.slug });
        const jobId: string = started.body.data.jobId;
        const phase = async (): Promise<string> =>
          (await get(`${base()}/jobs/${jobId}`)).body.data.job.phase;

        const order = [
          "plan.md",
          "research.md",
          "data-model.md",
          "contracts/api.openapi.yaml",
          "quickstart.md",
        ];
        for (const [i, key] of order.entries()) {
          const call = await nextCall();
          await vi.waitFor(
            async () => expect(await phase()).toBe(`Generating ${key} (${i + 1} of 5)`),
            WAIT,
          );
          // Generated so far, and still nothing saved over the old plan.
          expect((await getFeatureArtifact(f.id, "plan.md"))?.version).toBe(1);
          expect(state.commits).toEqual([]);
          call.resolve({
            content: key.endsWith(".yaml")
              ? "openapi: 3.1.0\ninfo:\n  title: t\n  version: 0.1.0\npaths: {}\n"
              : `# ${key}\n\n## Resolved Unknowns: none\n`,
          });
        }
        const job = await finished(jobId);

        expect(job.status).toBe("succeeded");
        expect(job.phase).toBe("Saving the plan artifacts");
        expect(job.result.artifacts.map((a: any) => a.key).sort()).toEqual(
          [
            "contracts/api.openapi.yaml",
            "data-model.md",
            "plan.md",
            "quickstart.md",
            "research.md",
          ].sort(),
        );
        expect((await getFeatureArtifact(f.id, "plan.md"))?.version).toBe(2);
      });
    });

    describe("the client going away does not stop the command", () => {
      let server: Server;
      let port = 0;
      beforeAll(async () => {
        server = createServer(app());
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        port = (server.address() as AddressInfo).port;
      });
      afterAll(async () => {
        await new Promise((resolve) => server.close(resolve));
      });

      it("finishes and saves after the synchronous caller's connection is destroyed", async () => {
        const f = await planned();
        const body = JSON.stringify({ featureSlug: f.slug });
        const closed = new Promise<void>((resolve) => {
          const req = httpRequest(
            {
              host: "127.0.0.1",
              port,
              method: "POST",
              path: `${base()}/commands/speckit.tasks`,
              headers: {
                authorization: `Bearer ${owner}`,
                "content-type": "application/json",
                "content-length": Buffer.byteLength(body),
              },
            },
            () => undefined,
          );
          req.on("error", () => resolve());
          req.on("close", () => resolve());
          req.end(body);
          // Hang up once the command is waiting on the model.
          void nextCall().then((call) => {
            state.pending.unshift(call);
            req.destroy();
          });
        });
        await closed;

        // The caller is gone and never saw a job id; the job is still there.
        const jobs = (await get(`${base()}/jobs`)).body.data.jobs;
        expect(jobs).toHaveLength(1);
        expect(jobs[0]).toMatchObject({ command: "speckit.tasks", status: "running" });
        expect(await getFeatureArtifact(f.id, "tasks.md")).toBeNull();

        (await nextCall()).resolve({ content: TASKS });
        const job = await finished(jobs[0].id);
        expect(job.status).toBe("succeeded");
        expect((await getFeatureArtifact(f.id, "tasks.md"))?.content).toBe(TASKS);
      });
    });

    describe("duplicate start", () => {
      it("gives one of two simultaneous starts the feature and refuses the other, by the unique index", async () => {
        const f = await planned();

        const [a, b] = await Promise.all([
          startJob("speckit.tasks", { featureSlug: f.slug }),
          startJob("speckit.tasks", { featureSlug: f.slug }),
        ]);

        const statuses = [a.status, b.status].sort();
        expect(statuses).toEqual([202, 409]);
        const won = a.status === 202 ? a : b;
        const lost = a.status === 202 ? b : a;
        expect(lost.body.error).toMatchObject({
          code: "SPEC_KIT_JOB_RUNNING",
          details: {
            jobId: won.body.data.jobId,
            command: "speckit.tasks",
            featureSlug: f.slug,
          },
        });
        expect(await db.specKitJob.count()).toBe(1);

        // Exactly one command reached the model.
        (await nextCall()).resolve({ content: TASKS });
        await finished(won.body.data.jobId);
        expect(state.pending).toHaveLength(0);
        expect((await getFeatureArtifact(f.id, "tasks.md"))?.version).toBe(1);
      });

      it("refuses a different command on the same feature, and the synchronous route too", async () => {
        const f = await planned();
        const first = await startJob("speckit.plan", { featureSlug: f.slug });
        await nextCall().then((call) => state.pending.unshift(call));

        for (const res of [
          await startJob("speckit.tasks", { featureSlug: f.slug }),
          await runSync("speckit.analyze", { featureSlug: f.slug }),
        ]) {
          expect(res.status).toBe(409);
          expect(res.body.error.code).toBe("SPEC_KIT_JOB_RUNNING");
          expect(res.body.error.details.jobId).toBe(first.body.data.jobId);
          expect(res.body.error.message).toContain("/speckit.plan is already running");
        }
        expect(state.pending).toHaveLength(1);

        // Another feature is not held up.
        const other = await planned();
        state.auto.push({ content: TASKS });
        const elsewhere = await startJob("speckit.tasks", { featureSlug: other.slug });
        expect(elsewhere.status).toBe(202);
        await finished(elsewhere.body.data.jobId);

        await post(`${base()}/jobs/${first.body.data.jobId}/cancel`);
        await finished(first.body.data.jobId);
        // …and the feature is free again once the job has ended.
        state.auto.push({ content: TASKS });
        const again = await startJob("speckit.tasks", { featureSlug: f.slug });
        expect(again.status).toBe(202);
        await finished(again.body.data.jobId);
      });
    });

    describe("cancel", () => {
      it("stops a plan mid-flight: no artifact is written and the previous version is kept", async () => {
        const f = await planned();
        const before = await listFeatureArtifacts(f.id);
        const started = await startJob("speckit.plan", { featureSlug: f.slug });
        const jobId: string = started.body.data.jobId;
        (await nextCall()).resolve({
          content: "# Plan v2\n\n## Components\nNo REST surface change.",
          tokens: 30,
        });
        const second = await nextCall(); // research.md, in flight

        const cancel = await post(`${base()}/jobs/${jobId}/cancel`);

        expect(cancel.status).toBe(200);
        expect(["cancelling", "cancelled"]).toContain(cancel.body.data.job.status);
        expect(second.signal?.aborted).toBe(true);
        const job = await finished(jobId);
        expect(job.status).toBe("cancelled");
        expect(job).not.toHaveProperty("result");
        // Byte for byte what was there before: plan.md v1, and no research.md.
        expect(await listFeatureArtifacts(f.id)).toEqual(before);
        expect(state.commits).toEqual([]);
        // The call that finished is billed as usual; the aborted one as an estimate.
        await vi.waitFor(async () => {
          const steps = (await db.tokenUsage.findMany({ where: { projectId: PA } }))
            .map((r) => r.agentStep)
            .sort();
          expect(steps).toEqual(["spec-kit.plan", "spec-kit.plan.aborted"]);
        }, WAIT);
        // Cancelling again changes nothing.
        const again = await post(`${base()}/jobs/${jobId}/cancel`);
        expect(again.body.data.job.status).toBe("cancelled");
      });

      it("writes nothing when the model answers after the cancel", async () => {
        state.ignoreAbort = true; // a provider that does not notice the abort
        const f = await planned();
        const before = await listFeatureArtifacts(f.id);
        const started = await startJob("speckit.tasks", { featureSlug: f.slug });
        const jobId: string = started.body.data.jobId;
        const call = await nextCall();

        await post(`${base()}/jobs/${jobId}/cancel`);
        // The job ends without waiting for the model…
        expect((await finished(jobId)).status).toBe("cancelled");

        // …which answers now. The command reaches its write and is refused there.
        call.resolve({ content: TASKS });
        await vi.waitFor(() => expect(state.commits).toHaveLength(1), WAIT);
        expect(state.commits[0]).toBeInstanceOf(SpecKitJobStopError);
        expect(await listFeatureArtifacts(f.id)).toEqual(before);
        expect((await get(`${base()}/jobs/${jobId}`)).body.data.job.status).toBe("cancelled");
      });

      it("sends no further model call when the model answers a cancelled plan late", async () => {
        state.ignoreAbort = true;
        const f = await planned();
        const before = await listFeatureArtifacts(f.id);
        const started = await startJob("speckit.plan", { featureSlug: f.slug });
        const jobId: string = started.body.data.jobId;
        (await nextCall()).resolve({ content: "# Plan v2\n\n## Components\nx" });
        const second = await nextCall(); // research.md

        await post(`${base()}/jobs/${jobId}/cancel`);
        expect((await finished(jobId)).status).toBe("cancelled");

        // research.md arrives after the cancel. The next step would be the
        // third model call (data-model.md): it is refused before it is sent.
        second.resolve({ content: "# Research\n\n## Resolved Unknowns: none\n" });
        await vi.waitFor(() => expect(state.refusedCalls).toHaveLength(1), WAIT);
        expect(state.refusedCalls[0]).toBeInstanceOf(SpecKitJobStopError);
        expect(state.pending).toHaveLength(0);
        expect(state.commits).toEqual([]);
        expect(await listFeatureArtifacts(f.id)).toEqual(before);
      });

      it("answers a waiting synchronous caller 409 SPEC_KIT_JOB_CANCELLED", async () => {
        const f = await planned();
        const waiting = runSync("speckit.tasks", { featureSlug: f.slug }).then((res) => res);
        await nextCall();
        const [job] = (await get(`${base()}/jobs`)).body.data.jobs;

        await post(`${base()}/jobs/${job.id}/cancel`);

        const res = await waiting;
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe("SPEC_KIT_JOB_CANCELLED");
        expect(await getFeatureArtifact(f.id, "tasks.md")).toBeNull();
      });

      it("cannot be aimed at another project's job, even at the store", async () => {
        const f = await planned();
        const started = await startJob("speckit.tasks", { featureSlug: f.slug });
        const jobId: string = started.body.data.jobId;
        const call = await nextCall();

        expect(await markJobCancelling(PB, jobId)).toBe(false);
        expect(await findJob(PB, jobId)).toBeNull();
        expect((await findJob(PA, jobId))?.status).toBe("running");

        call.resolve({ content: TASKS });
        expect((await finished(jobId)).status).toBe("succeeded");
      });

      it("answers 404 for a job that does not exist", async () => {
        const res = await post(`${base()}/jobs/00000000-0000-4000-8000-000000000000/cancel`);
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe("SPEC_KIT_JOB_NOT_FOUND");
      });
    });

    describe("failure codes are the synchronous route's", () => {
      /** Run one failing scenario on both routes and return [sync error+status, job error]. */
      const both = async (
        cmd: string,
        body: Record<string, unknown>,
        replies: () => StubReply[],
      ): Promise<{ sync: Record<string, any>; job: Record<string, any> }> => {
        state.auto.push(...replies());
        const sync = await runSync(cmd, body);
        state.auto.length = 0;
        state.auto.push(...replies());
        const started = await startJob(cmd, body);
        expect(started.status).toBe(202);
        const job = await finished(started.body.data.jobId);
        state.auto.length = 0;
        expect(job.status).toBe("failed");
        expect(job).not.toHaveProperty("result");
        return { sync: { status: sync.status, ...sync.body.error }, job: job.error };
      };

      it("502 SPEC_KIT_EMPTY_OUTPUT, with nothing saved", async () => {
        const f = await planned();
        const { sync, job } = await both("speckit.tasks", { featureSlug: f.slug }, () => [
          { content: "   " },
        ]);
        expect(sync).toMatchObject({ status: 502, code: "SPEC_KIT_EMPTY_OUTPUT" });
        expect(job).toEqual({ status: 502, code: sync.code, message: sync.message });
        expect(await getFeatureArtifact(f.id, "tasks.md")).toBeNull();
      });

      it("502 SPEC_KIT_OUTPUT_EXHAUSTED", async () => {
        const f = await planned();
        const { sync, job } = await both("speckit.tasks", { featureSlug: f.slug }, () => [
          { content: "", finishReason: "length" },
        ]);
        expect(sync).toMatchObject({ status: 502, code: "SPEC_KIT_OUTPUT_EXHAUSTED" });
        expect(job).toEqual({ status: 502, code: sync.code, message: sync.message });
      });

      it("the gate's 412 SPECKIT_GATE_UNMET, details included", async () => {
        nextSlug += 1;
        const slug = `${String(nextSlug).padStart(3, "0")}-no-plan`;
        const feature = await createFeature({ projectId: PA, title: slug, forcedSlug: slug });
        await writeFeatureArtifact({ featureId: feature.id, key: "spec.md", content: SPEC });

        const { sync, job } = await both("speckit.tasks", { featureSlug: slug }, () => []);

        expect(sync).toMatchObject({ status: 412, code: "SPECKIT_GATE_UNMET" });
        expect(sync.details.required).toBeTruthy();
        expect(job).toEqual({
          status: 412,
          code: "SPECKIT_GATE_UNMET",
          message: sync.message,
          details: sync.details,
        });
      });

      it("404 SPECKIT_FEATURE_NOT_FOUND and 400 SPECKIT_FEATURE_REQUIRED", async () => {
        const missing = await both("speckit.tasks", { featureSlug: "999-nope" }, () => []);
        expect(missing.sync).toMatchObject({ status: 404, code: "SPECKIT_FEATURE_NOT_FOUND" });
        expect(missing.job).toMatchObject({ status: 404, code: "SPECKIT_FEATURE_NOT_FOUND" });

        const required = await both("speckit.plan", {}, () => []);
        expect(required.sync).toMatchObject({ status: 400, code: "SPECKIT_FEATURE_REQUIRED" });
        expect(required.job).toMatchObject({ status: 400, code: "SPECKIT_FEATURE_REQUIRED" });
      });

      it("402 BUDGET_EXCEEDED part-way through a plan: the budget is still checked per call, and nothing is saved", async () => {
        const f = await planned();
        const before = await listFeatureArtifacts(f.id);
        await db.project.update({ where: { id: PA }, data: { monthlyTokenBudget: 150 } });
        const usage = async (): Promise<number> =>
          (await db.tokenUsage.findMany({ where: { projectId: PA } })).length;

        const started = await startJob("speckit.plan", { featureSlug: f.slug });
        for (const n of [1, 2]) {
          (await nextCall()).resolve({
            content: "# Plan\n\n## Components\nNo REST surface change.",
            tokens: 100,
          });
          await vi.waitFor(async () => expect(await usage()).toBe(n), WAIT);
        }
        const job = await finished(started.body.data.jobId);

        expect(job.status).toBe("failed");
        expect(job.error).toMatchObject({
          status: 402,
          code: "BUDGET_EXCEEDED",
          details: { usedTokens: 200, budget: 150 },
        });
        expect(state.pending).toHaveLength(0); // the third call was never sent
        expect(await listFeatureArtifacts(f.id)).toEqual(before);
      });

      it("refuses before starting what can be refused before starting", async () => {
        const f = await planned();
        const cases: Array<[string, Record<string, unknown>, number, string]> = [
          ["speckit.nope", {}, 400, "SPEC_KIT_UNKNOWN_COMMAND"],
          ["speckit.tasks", { featureSlug: "Not A Slug" }, 400, "SPECKIT_INVALID_SLUG"],
          ["speckit.tasks", { input: "x".repeat(8_001) }, 400, "BAD_REQUEST"],
          // These three never run as jobs: they answer on the synchronous route.
          ["speckit.implement", { featureSlug: f.slug }, 400, "SPEC_KIT_COMMAND_NOT_A_JOB"],
          ["speckit.taskstoissues", { featureSlug: f.slug }, 400, "SPEC_KIT_COMMAND_NOT_A_JOB"],
          ["speckit.constitution", { input: "# P" }, 400, "SPEC_KIT_COMMAND_NOT_A_JOB"],
        ];
        for (const [cmd, body, status, code] of cases) {
          const res = await startJob(cmd, body);
          expect([cmd, res.status, res.body.error?.code]).toEqual([cmd, status, code]);
        }
        await setSpecKitEnabled(PA, false, "u-owner");
        const disabled = await startJob("speckit.tasks", { featureSlug: f.slug });
        await setSpecKitEnabled(PA, true, "u-owner");
        expect(disabled.status).toBe(409);
        expect(disabled.body.error.code).toBe("SPEC_KIT_DISABLED");
        // None of them left a job behind or reached the model.
        expect(await db.specKitJob.count()).toBe(0);
        expect(state.pending).toHaveLength(0);
      });

      it("keeps the legacy alias working as a job, with its Deprecation header", async () => {
        await writeArtifact({ projectId: PA, name: "spec.md", content: SPEC });
        state.auto.push({ content: "# Project plan" });
        const started = await startJob("plan");
        expect(started.status).toBe(202);
        expect(started.headers.deprecation).toBe("true");
        expect(started.body.data.job).toMatchObject({ command: "speckit.plan", featureSlug: null });
        const job = await finished(started.body.data.jobId);
        expect(job.result).toMatchObject({ command: "plan", artifactName: "plan.md" });
      });
    });

    describe("restart recovery", () => {
      const dead = (id: string, slug: string, status = "running") =>
        db.specKitJob.create({
          data: {
            id,
            projectId: PA,
            command: "speckit.plan",
            featureSlug: slug,
            activeKey: `${PA}:${slug}`,
            status,
            phase: "Generating research.md (2 of 5)",
            startedById: "u-owner",
            // The process that ran it stopped heartbeating long ago.
            heartbeatAt: new Date(Date.now() - SPEC_KIT_JOB_STALE_MS * 10),
          },
        });

      it("reports a job whose server died as interrupted, never as running, and frees its feature", async () => {
        const f = await planned();
        await dead("job-dead", f.slug);

        const res = await get(`${base()}/jobs/job-dead`);

        expect(res.body.data.job).toMatchObject({
          status: "failed",
          phase: "Generating research.md (2 of 5)",
          error: { status: 503, code: "SPEC_KIT_JOB_INTERRUPTED" },
        });
        expect((await get(`${base()}/jobs`)).body.data.jobs).toEqual([]);
        state.auto.push({ content: TASKS });
        const again = await startJob("speckit.tasks", { featureSlug: f.slug });
        expect(again.status).toBe(202);
        await finished(again.body.data.jobId);
      });

      it("lets a new start take a dead job's feature without waiting for the sweeper", async () => {
        const f = await planned();
        await dead("job-dead-2", f.slug);
        state.auto.push({ content: TASKS });

        const started = await startJob("speckit.tasks", { featureSlug: f.slug });

        expect(started.status).toBe(202);
        await finished(started.body.data.jobId);
        expect(await db.specKitJob.findUnique({ where: { id: "job-dead-2" } })).toMatchObject({
          status: "failed",
          activeKey: null,
        });
      });

      it("the sweeper fails dead jobs, cancels dead cancelling ones, and never touches a live one", async () => {
        const [a, b, c] = [await planned(), await planned(), await planned()];
        await dead("swept", a.slug);
        await dead("swept-cancelling", b.slug, "cancelling");
        const live = await startJob("speckit.tasks", { featureSlug: c.slug });
        const call = await nextCall();

        expect(await failInterruptedSpecKitJobs()).toBe(2);

        const rows = Object.fromEntries(
          (await db.specKitJob.findMany()).map((r) => [r.id, r] as const),
        );
        expect(rows.swept).toMatchObject({ status: "failed", activeKey: null });
        expect(JSON.parse(rows.swept!.error!)).toMatchObject({ code: "SPEC_KIT_JOB_INTERRUPTED" });
        expect(rows.swept!.finishedAt).not.toBeNull();
        expect(rows["swept-cancelling"]).toMatchObject({ status: "cancelled", activeKey: null });
        expect(rows[live.body.data.jobId]).toMatchObject({ status: "running" });

        call.resolve({ content: TASKS });
        expect((await finished(live.body.data.jobId)).status).toBe("succeeded");
      });

      it("prunes a job a day after it finished", async () => {
        await db.specKitJob.create({
          data: {
            id: "old",
            projectId: PA,
            command: "speckit.tasks",
            status: "succeeded",
            result: "{}",
            finishedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
          },
        });
        await db.specKitJob.create({
          data: {
            id: "recent",
            projectId: PA,
            command: "speckit.tasks",
            status: "succeeded",
            result: "{}",
            finishedAt: new Date(),
          },
        });
        await failInterruptedSpecKitJobs();
        expect((await db.specKitJob.findMany()).map((r) => r.id)).toEqual(["recent"]);
      });
    });

    describe("the heartbeat, on the real table", () => {
      it("keeps a running job's row fresh, and stops the job when another replica marks it cancelling", async () => {
        let release: (value: unknown) => void = () => undefined;
        const started = await startSpecKitJob({
          projectId: PA,
          command: "speckit.tasks",
          featureSlug: null,
          actorId: "u-owner",
          heartbeatMs: 10,
          run: () => new Promise((resolve) => (release = resolve)),
        });
        const row = () => db.specKitJob.findUniqueOrThrow({ where: { id: started.job.id } });
        const first = (await row()).heartbeatAt.getTime();
        await vi.waitFor(
          async () => expect((await row()).heartbeatAt.getTime()).toBeGreaterThan(first),
          WAIT,
        );

        // A cancel handled by a replica that does not run the job: only the row changes.
        await db.specKitJob.update({
          where: { id: started.job.id },
          data: { status: "cancelling" },
        });

        expect((await started.done).status).toBe("cancelled");
        expect(await row()).toMatchObject({ status: "cancelled", activeKey: null });
        release({});
      });
    });

    // ---- Review of PR #1105 ---------------------------------------------------

    describe("a job that lost its row writes nothing (review M1)", () => {
      const SWEPT = { status: 503, code: "SPEC_KIT_JOB_INTERRUPTED", message: "swept elsewhere" };
      /** Exactly the update another replica's sweep (or finish) makes to a running row. */
      const failFromAnotherReplica = (jobId: string) =>
        db.specKitJob.updateMany({
          where: { id: jobId, status: "running" },
          data: {
            status: "failed",
            activeKey: null,
            finishedAt: new Date(),
            error: JSON.stringify(SWEPT),
          },
        });

      it("a row failed by another replica: the owner saves nothing, and only the second job writes the feature", async () => {
        const f = await planned();
        const a = await startJob("speckit.tasks", { featureSlug: f.slug });
        const jobA: string = a.body.data.jobId;
        const callA = await nextCall();

        expect((await failFromAnotherReplica(jobA)).count).toBe(1);
        // The key is free, so a second job on the same feature is accepted.
        const b = await startJob("speckit.tasks", { featureSlug: f.slug });
        expect(b.status).toBe(202);
        const callB = await nextCall();

        // The first job's model call answers. Nothing told its process the row is gone.
        callA.resolve({ content: `${TASKS} FROM-A` });
        await vi.waitFor(() => expect(state.commits).toHaveLength(1), WAIT);

        expect(state.commits[0]).toBeInstanceOf(SpecKitJobStopError);
        expect((state.commits[0] as InstanceType<typeof SpecKitJobStopError>).reason).toBe(
          "superseded",
        );
        expect(await getFeatureArtifact(f.id, "tasks.md")).toBeNull();
        // The row it no longer owns is as the other replica left it.
        expect((await get(`${base()}/jobs/${jobA}`)).body.data.job).toMatchObject({
          status: "failed",
          error: SWEPT,
        });

        callB.resolve({ content: `${TASKS} FROM-B` });
        expect((await finished(b.body.data.jobId)).status).toBe("succeeded");
        const artifact = await getFeatureArtifact(f.id, "tasks.md");
        // One write, by the job that holds the feature — not v1 by A and v2 by B.
        expect(artifact).toMatchObject({ version: 1, content: `${TASKS} FROM-B` });
        expect(state.commits).toHaveLength(2);
        expect(state.commits[1]).toBe("ok");
      });

      it("a five-artifact plan whose row was failed elsewhere writes none of the five", async () => {
        const f = await planned();
        const before = await listFeatureArtifacts(f.id);
        const started = await startJob("speckit.plan", { featureSlug: f.slug });
        const jobId: string = started.body.data.jobId;
        const first = await nextCall();

        await failFromAnotherReplica(jobId);
        // The model answers all five calls; the job still believes it is running.
        first.resolve({ content: "# Plan v2\n\n## Components\nNo REST surface change." });
        for (const content of [
          "# Research\n\n## Resolved Unknowns: none\n",
          "# Data model\n\nNo change.",
          "openapi: 3.0.0\ninfo:\n  title: x\n  version: '1'\npaths: {}\n",
          "# Quickstart\n\nRun it.",
        ]) {
          (await nextCall()).resolve({ content });
        }
        await vi.waitFor(() => expect(state.commits.length).toBeGreaterThan(0), WAIT);

        expect(state.commits).toHaveLength(1);
        expect(state.commits[0]).toBeInstanceOf(SpecKitJobStopError);
        expect(await listFeatureArtifacts(f.id)).toEqual(before);
        expect((await get(`${base()}/jobs/${jobId}`)).body.data.job.error).toEqual(SWEPT);
      });

      it("marks a job saving once it writes, and answers a cancel from then on with 409", async () => {
        // A job that another replica runs and that has passed its commit point:
        // all this replica can see is the row.
        const f = await planned();
        await db.specKitJob.create({
          data: {
            id: "saving-elsewhere",
            projectId: PA,
            command: "speckit.plan",
            featureSlug: f.slug,
            activeKey: `${PA}:${f.slug}`,
            status: "saving",
            startedById: "u-owner",
          },
        });

        const cancel = await post(`${base()}/jobs/saving-elsewhere/cancel`);

        expect(cancel.status).toBe(409);
        expect(cancel.body.error.code).toBe("SPEC_KIT_JOB_SAVING");
        // Not `cancelling` followed by a success, and no audit row saying so.
        expect((await findJob(PA, "saving-elsewhere"))?.status).toBe("saving");
        expect(state.audits.filter((e) => e.action === "spec_kit.job.cancelled")).toEqual([]);
        // It is live: listed, and it holds its feature.
        expect((await get(`${base()}/jobs`)).body.data.jobs).toMatchObject([
          { id: "saving-elsewhere", status: "saving" },
        ]);
        const refused = await startJob("speckit.tasks", { featureSlug: f.slug });
        expect(refused.status).toBe(409);
        expect(refused.body.error.code).toBe("SPEC_KIT_JOB_RUNNING");
      });

      it("stores the job as saving while its artifacts are being written", async () => {
        const f = await planned();
        state.auto.push({ content: TASKS });
        const started = await startJob("speckit.tasks", { featureSlug: f.slug });
        await finished(started.body.data.jobId);
        // The commit point ran inside the job, against the real row.
        expect(state.commits).toEqual(["ok"]);
        expect(
          await db.specKitJob.findUnique({ where: { id: started.body.data.jobId } }),
        ).toMatchObject({ status: "succeeded", activeKey: null });
      });
    });

    describe("the project-level commit point (legacy aliases write through writeArtifact)", () => {
      const projectFiles = async () => ({
        spec: await getArtifact(PA, "spec.md"),
        plan: await getArtifact(PA, "plan.md"),
      });

      it("a cancelled legacy /plan writes nothing when the model answers late", async () => {
        await writeArtifact({ projectId: PA, name: "spec.md", content: SPEC });
        state.ignoreAbort = true; // the provider does not notice the abort
        const before = await projectFiles();
        const started = await startJob("plan");
        expect(started.body.data.job).toMatchObject({ command: "speckit.plan", featureSlug: null });
        const jobId: string = started.body.data.jobId;
        const call = await nextCall();

        await post(`${base()}/jobs/${jobId}/cancel`);
        expect((await finished(jobId)).status).toBe("cancelled");

        // The model answers now: the command reaches writeArtifact and is refused there.
        call.resolve({ content: "# A late project plan" });
        await vi.waitFor(() => expect(state.commits).toHaveLength(1), WAIT);
        expect(state.commits[0]).toBeInstanceOf(SpecKitJobStopError);
        expect(await projectFiles()).toEqual(before);
      });

      it("a cancelled legacy /specify writes nothing when the model answers late", async () => {
        await writeArtifact({ projectId: PA, name: "spec.md", content: SPEC });
        state.ignoreAbort = true;
        const before = await projectFiles();
        const started = await startJob("specify", { input: "Mark every entry read" });
        const jobId: string = started.body.data.jobId;
        const call = await nextCall();

        await post(`${base()}/jobs/${jobId}/cancel`);
        expect((await finished(jobId)).status).toBe("cancelled");

        call.resolve({ content: "# A late spec\n\n## Acceptance criteria\n- **AC-1**: x" });
        await vi.waitFor(() => expect(state.commits).toHaveLength(1), WAIT);
        expect(state.commits[0]).toBeInstanceOf(SpecKitJobStopError);
        expect(await projectFiles()).toEqual(before);
      });

      it("a legacy /plan stopped by its time limit writes nothing when the model answers late", async () => {
        await writeArtifact({ projectId: PA, name: "spec.md", content: SPEC });
        state.ignoreAbort = true;
        const before = await projectFiles();
        const provider = await resolveProjectProvider(PA);
        const started = await startSpecKitJob({
          projectId: PA,
          command: "speckit.plan",
          featureSlug: null,
          actorId: "u-owner",
          // Nothing can reach the commit point until the test answers the call.
          timeoutMs: 20,
          run: () => runPlan({ projectId: PA, actorId: "u-owner", deps: { provider } }),
        });
        const call = await nextCall();

        const done = await started.done;
        expect(done).toMatchObject({ status: "failed", error: { code: "SPEC_KIT_JOB_TIMEOUT" } });

        call.resolve({ content: "# A late project plan" });
        await vi.waitFor(() => expect(state.commits).toHaveLength(1), WAIT);
        expect(state.commits[0]).toBeInstanceOf(SpecKitJobStopError);
        expect((state.commits[0] as InstanceType<typeof SpecKitJobStopError>).reason).toBe(
          "timeout",
        );
        expect(await projectFiles()).toEqual(before);
      });

      it("a legacy /plan whose row was failed by another replica writes nothing", async () => {
        await writeArtifact({ projectId: PA, name: "spec.md", content: SPEC });
        const before = await projectFiles();
        const started = await startJob("plan");
        const call = await nextCall();
        await db.specKitJob.updateMany({
          where: { id: started.body.data.jobId },
          data: { status: "failed", activeKey: null, finishedAt: new Date(), error: "{}" },
        });

        call.resolve({ content: "# A project plan from a job that lost its row" });
        await vi.waitFor(() => expect(state.commits).toHaveLength(1), WAIT);
        expect(state.commits[0]).toBeInstanceOf(SpecKitJobStopError);
        expect(await projectFiles()).toEqual(before);
      });
    });

    describe("staleness is judged on the database's clock (review M2)", () => {
      it("a replica whose clock is 100 s ahead does not fail a live job on a member's GET", async () => {
        const f = await planned();
        const started = await startJob("speckit.tasks", { featureSlug: f.slug });
        const jobId: string = started.body.data.jobId;
        const call = await nextCall();

        // This process becomes the replica with the fast clock.
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date(Date.now() + 100_000));
        const read = await get(`${base()}/jobs/${jobId}`, reader);
        const list = await get(`${base()}/jobs`, reader);
        const swept = await failInterruptedSpecKitJobs();
        const second = await startJob("speckit.tasks", { featureSlug: f.slug });
        vi.useRealTimers();

        expect(read.body.data.job.status).toBe("running");
        expect(list.body.data.jobs.map((j: any) => j.id)).toEqual([jobId]);
        expect(swept).toBe(0);
        // The live job still holds its feature.
        expect(second.status).toBe(409);
        expect(call.signal?.aborted).toBe(false);

        call.resolve({ content: TASKS });
        expect((await finished(jobId)).status).toBe("succeeded");
      });
    });

    describe("the lock is as wide as what a command writes (review L1)", () => {
      const specOf = (n: number) =>
        `# Spec ${n}\n\n## Acceptance criteria\n- **AC-1**: feature ${n} works`;

      it("lets two members each create a new feature at the same time", async () => {
        const before = (await listFeatures(PA)).length;
        const a = await startJob("speckit.specify", { input: "Mark every entry read" });
        const b = await startJob(
          "speckit.specify",
          { input: "Export the feed list as OPML" },
          member,
        );

        expect([a.status, b.status]).toEqual([202, 202]);
        const [slugA, slugB] = [a.body.data.job.featureSlug, b.body.data.job.featureSlug];
        // Each job is locked under the feature it creates, not under the project.
        expect(slugA).toMatch(/^\d{3}-mark-every-entry-read$/);
        expect(slugB).toMatch(/^\d{3}-export-the-feed-list-as-opml$/);
        expect(slugA.slice(0, 3)).not.toBe(slugB.slice(0, 3));
        const keys = (await db.specKitJob.findMany({ orderBy: { startedAt: "asc" } })).map(
          (r) => r.activeKey,
        );
        expect(keys.sort()).toEqual([`${PA}:${slugA}`, `${PA}:${slugB}`].sort());

        (await nextCall()).resolve({ content: specOf(1) });
        (await nextCall()).resolve({ content: specOf(2) });
        const [jobA, jobB] = [await finished(a.body.data.jobId), await finished(b.body.data.jobId)];
        expect(jobA.result.feature.slug).toBe(slugA);
        expect(jobB.result.feature.slug).toBe(slugB);
        // Two features, each with its own spec.md v1: neither wrote the other's.
        expect((await listFeatures(PA)).length).toBe(before + 2);
        expect(jobA.result.artifact.version).toBe(1);
        expect(jobB.result.artifact.version).toBe(1);
        expect(jobA.result.artifact.content).not.toBe(jobB.result.artifact.content);
      });

      it("does not let a project-level command block a new feature, or the reverse", async () => {
        await writeArtifact({ projectId: PA, name: "spec.md", content: SPEC });
        const projectLevel = await startJob("plan"); // legacy: the project-level set
        expect(projectLevel.status).toBe(202);
        const planCall = await nextCall();

        const creating = await startJob("speckit.specify", { input: "Star an entry" });
        expect(creating.status).toBe(202);
        const specCall = await nextCall();
        // …and with a feature being created, the project-level set is still free
        // to be refused only by its OWN holder.
        const second = await startJob("speckit.tasks"); // project-level tasks
        expect(second.status).toBe(409);
        expect(second.body.error.details.jobId).toBe(projectLevel.body.data.jobId);

        planCall.resolve({ content: "# Project plan" });
        specCall.resolve({ content: specOf(3) });
        expect((await finished(projectLevel.body.data.jobId)).status).toBe("succeeded");
        expect((await finished(creating.body.data.jobId)).status).toBe("succeeded");
      });

      it("still refuses a second job on the feature a specify is creating", async () => {
        const creating = await startJob("speckit.specify", { input: "Archive old entries" });
        const slug: string = creating.body.data.job.featureSlug;
        const call = await nextCall();

        for (const res of [
          await startJob("speckit.specify", { input: "something else", featureSlug: slug }),
          await startJob("speckit.plan", { featureSlug: slug }),
        ]) {
          expect(res.status).toBe(409);
          expect(res.body.error).toMatchObject({
            code: "SPEC_KIT_JOB_RUNNING",
            details: { jobId: creating.body.data.jobId, featureSlug: slug },
          });
        }
        call.resolve({ content: specOf(4) });
        await finished(creating.body.data.jobId);
      });

      it("keeps the project-level key for the commands that write the project-level set", async () => {
        await writeArtifact({ projectId: PA, name: "spec.md", content: SPEC });
        const first = await startJob("plan");
        expect(first.status).toBe(202);
        expect(first.body.data.job.featureSlug).toBeNull();
        const call = await nextCall();
        for (const cmd of ["specify", "speckit.tasks", "speckit.clarify", "speckit.analyze"]) {
          const res = await startJob(cmd, { input: "x" });
          expect([cmd, res.status, res.body.error?.code]).toEqual([
            cmd,
            409,
            "SPEC_KIT_JOB_RUNNING",
          ]);
        }
        await post(`${base()}/jobs/${first.body.data.jobId}/cancel`);
        await finished(first.body.data.jobId);
        expect(call.signal?.aborted).toBe(true);
      });

      it("refuses an empty brief before it creates a feature for it", async () => {
        const before = (await listFeatures(PA, { includeArchived: true })).length;
        for (const res of [
          await startJob("speckit.specify", { input: "   " }),
          await runSync("speckit.specify", {}),
        ]) {
          expect(res.status).toBe(400);
          expect(res.body.error.code).toBe("SPECKIT_EMPTY_INPUT");
        }
        expect((await listFeatures(PA, { includeArchived: true })).length).toBe(before);
        expect(await db.specKitJob.count()).toBe(0);
      });

      it("creates the feature the same way on the synchronous route", async () => {
        state.auto.push({ content: specOf(5) });
        const res = await runSync("speckit.specify", { input: "Mute a feed" });
        expect(res.status).toBe(200);
        expect(res.body.data.feature.slug).toMatch(/^\d{3}-mute-a-feed$/);
        expect(res.body.data.feature.title).toBe("Mute a feed");
        const row = await db.specKitJob.findUnique({ where: { id: res.body.data.jobId } });
        expect(row).toMatchObject({ featureSlug: res.body.data.feature.slug, status: "succeeded" });
      });
    });

    describe("a provider failure is stored without the provider's own words (review L3)", () => {
      const UPSTREAM = "upstream said: request id req_011CS-secret, org acme-internal";
      const providerFailure = () =>
        new AIProviderError(`anthropic chat failed (APIError): ${UPSTREAM}`, 529, {
          provider: "anthropic",
          operation: "chat",
          errorName: "APIError",
        });

      it("keeps the status and code, names the operation and class, and drops the upstream text", async () => {
        const f = await planned();
        state.auto.push({ content: "", throws: providerFailure() });
        const started = await startJob("speckit.tasks", { featureSlug: f.slug });
        const job = await finished(started.body.data.jobId);

        expect(job.error).toEqual({
          status: 502,
          code: "AI_PROVIDER_KEY_UNAVAILABLE",
          message:
            "The AI provider call failed: anthropic chat (APIError, HTTP 529). The provider's own message is in the server log.",
        });
        // Not in what another member reads, and not in the row kept for a day.
        const seenByReader = await get(`${base()}/jobs/${started.body.data.jobId}`, reader);
        expect(JSON.stringify(seenByReader.body)).not.toContain("req_011CS");
        const row = await db.specKitJob.findUnique({ where: { id: started.body.data.jobId } });
        expect(JSON.stringify(row)).not.toContain("req_011CS");
        expect(JSON.stringify(row)).not.toContain("acme-internal");
      });

      it("answers the synchronous caller with the same bounded message", async () => {
        const f = await planned();
        state.auto.push({ content: "", throws: providerFailure() });
        const res = await runSync("speckit.tasks", { featureSlug: f.slug });
        expect(res.status).toBe(502);
        expect(res.body.error.code).toBe("AI_PROVIDER_KEY_UNAVAILABLE");
        expect(res.body.error.message).toContain("anthropic chat (APIError, HTTP 529)");
        expect(JSON.stringify(res.body)).not.toContain("req_011CS");
      });
    });

    describe("who may cancel, and what is audited (review L6)", () => {
      const cancels = () => state.audits.filter((e) => e.action === "spec_kit.job.cancelled");

      it("lets another member with project.update cancel a job, and records who cancelled whose", async () => {
        const f = await planned();
        const started = await startJob("speckit.tasks", { featureSlug: f.slug });
        const jobId: string = started.body.data.jobId;
        await nextCall();

        const cancel = await post(`${base()}/jobs/${jobId}/cancel`, {}, member);

        expect(cancel.status).toBe(200);
        expect((await finished(jobId)).status).toBe("cancelled");
        expect(cancels()).toHaveLength(1);
        expect(cancels()[0]).toMatchObject({
          actor: { id: "u-member" },
          target: { type: "project", id: PA },
          metadata: {
            jobId,
            command: "speckit.tasks",
            featureSlug: f.slug,
            startedById: "u-owner",
          },
        });
      });

      it("records no cancel for a job that had already finished, or that does not exist", async () => {
        const f = await planned();
        state.auto.push({ content: TASKS });
        const started = await startJob("speckit.tasks", { featureSlug: f.slug });
        await finished(started.body.data.jobId);

        const again = await post(`${base()}/jobs/${started.body.data.jobId}/cancel`, {}, member);
        await post(`${base()}/jobs/00000000-0000-4000-8000-000000000000/cancel`, {}, member);

        expect(again.status).toBe(200);
        expect(again.body.data.job.status).toBe("succeeded");
        expect(cancels()).toEqual([]);
      });

      it("records one cancel for a job cancelled twice", async () => {
        state.ignoreAbort = true;
        const f = await planned();
        const started = await startJob("speckit.tasks", { featureSlug: f.slug });
        const jobId: string = started.body.data.jobId;
        await nextCall();
        await post(`${base()}/jobs/${jobId}/cancel`);
        await post(`${base()}/jobs/${jobId}/cancel`, {}, member);
        await finished(jobId);
        expect(cancels()).toHaveLength(1);
      });
    });

    describe("polling cannot spend the budget for starting and cancelling (review L5)", () => {
      const restore = (): void => {
        delete process.env.SPECKIT_JOB_LIMIT_MAX;
        delete process.env.SPECKIT_JOB_USER_WRITE_LIMIT_MAX;
      };

      it("still accepts a cancel and a start when the read budget is spent", async () => {
        const f = await planned();
        try {
          // Every request of this file comes from one address: its read budget is long spent.
          process.env.SPECKIT_JOB_LIMIT_MAX = "1";
          const poll = await get(`${base()}/jobs`);
          expect(poll.status).toBe(429);
          expect(poll.body.error.code).toBe("SPECKIT_JOB_RATE_LIMITED");

          const started = await startJob("speckit.tasks", { featureSlug: f.slug });
          expect(started.status).toBe(202);
          await nextCall();
          const cancel = await post(`${base()}/jobs/${started.body.data.jobId}/cancel`);
          expect(cancel.status).toBe(200);
        } finally {
          restore();
        }
      });

      it("limits starts per authenticated user, not per address", async () => {
        const f = await planned();
        try {
          // The owner has started dozens of jobs in this file; `fresh` has started none.
          process.env.SPECKIT_JOB_USER_WRITE_LIMIT_MAX = "2";
          const spent = await startJob("speckit.tasks", { featureSlug: f.slug });
          expect(spent.status).toBe(429);
          expect(spent.body.error.code).toBe("SPECKIT_JOB_RATE_LIMITED");

          state.auto.push({ content: TASKS });
          const allowed = await startJob("speckit.tasks", { featureSlug: f.slug }, fresh);
          expect(allowed.status).toBe(202);
          restore();
          await finished(allowed.body.data.jobId);
        } finally {
          restore();
        }
      });
    });

    describe("authorization — on every job endpoint, not only on start", () => {
      const SECRET = "the secret plan nobody outside the project may read";

      it("hides a job, its result and its existence from a user of another project", async () => {
        const f = await planned();
        state.auto.push({ content: `## Tasks\n\n- [ ] T01 — ${SECRET}` });
        const done = await startJob("speckit.tasks", { featureSlug: f.slug });
        const doneId: string = done.body.data.jobId;
        await finished(doneId);
        const other = await planned();
        const running = await startJob("speckit.tasks", { featureSlug: other.slug });
        const runningId: string = running.body.data.jobId;
        const call = await nextCall();

        const attempts = [
          await get(`${base()}/jobs`, outsider),
          await get(`${base()}/jobs/${doneId}`, outsider),
          await get(`${base()}/jobs/${runningId}`, outsider),
          await post(`${base()}/jobs/${runningId}/cancel`, {}, outsider),
          await startJob("speckit.tasks", { featureSlug: f.slug }, outsider),
          // The outsider's OWN project, with the other project's job id.
          await get(`${base(PB)}/jobs/${doneId}`, outsider),
          await get(`${base(PB)}/jobs/${runningId}`, outsider),
          await post(`${base(PB)}/jobs/${runningId}/cancel`, {}, outsider),
        ];

        for (const res of attempts) {
          expect(res.status).toBe(404);
          expect(JSON.stringify(res.body)).not.toContain(SECRET);
          expect(JSON.stringify(res.body)).not.toContain(f.slug);
        }
        // Their own project shows them no job of this one.
        const own = await get(`${base(PB)}/jobs`, outsider);
        expect(own.status).toBe(200);
        expect(own.body.data.jobs).toEqual([]);
        // The cancel attempts did nothing: the job is still running, for its owner.
        expect((await get(`${base()}/jobs/${runningId}`)).body.data.job.status).toBe("running");
        expect(call.signal?.aborted).toBe(false);
        expect(JSON.stringify((await get(`${base()}/jobs/${doneId}`)).body)).toContain(SECRET);

        call.resolve({ content: TASKS });
        await finished(runningId);
      });

      it("lets a reader of the project watch a job but neither start nor cancel one", async () => {
        const f = await planned();
        const started = await startJob("speckit.tasks", { featureSlug: f.slug });
        const jobId: string = started.body.data.jobId;
        const call = await nextCall();

        expect((await get(`${base()}/jobs/${jobId}`, reader)).body.data.job.status).toBe("running");
        expect((await get(`${base()}/jobs`, reader)).body.data.jobs).toHaveLength(1);
        for (const res of [
          await post(`${base()}/jobs/${jobId}/cancel`, {}, reader),
          await startJob("speckit.tasks", { featureSlug: f.slug }, reader),
        ]) {
          expect(res.status).toBe(403);
          expect(res.body.error.code).toBe("FORBIDDEN");
        }
        expect(call.signal?.aborted).toBe(false);

        call.resolve({ content: TASKS });
        await finished(jobId);
      });

      it("requires authentication everywhere", async () => {
        for (const res of [
          await request(app()).get(`${base()}/jobs`),
          await request(app()).get(`${base()}/jobs/x`),
          await request(app()).post(`${base()}/jobs/x/cancel`).send({}),
          await request(app()).post(`${base()}/commands/speckit.tasks/jobs`).send({}),
        ]) {
          expect(res.status).toBe(401);
        }
      });
    });
  },
);
