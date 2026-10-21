/**
 * #960 — object-level project scope (OWASP A01 / BOLA) on every Spec Kit route.
 *
 * `POST /commands/:cmd` checked only the `project.update` role, and #953 added
 * an object-level check for `speckit.taskstoissues` alone; most plain routes
 * had none either. The router itself would have let a `project.update` holder
 * in workspace A read and write workspace B's Spec Kit artifacts. In the
 * assembled app that was not reachable: `projectsRouter()`'s
 * `r.use("/:id/:sub", requireAuth, requireProjectAccess("id"))` is mounted
 * first and 404s the request upstream (`docs/SECURITY.md` §12.3). So this suite
 * mounts `specKitRouter()` ON ITS OWN, to prove the router is safe by itself
 * rather than because of the mount order.
 *
 * Driven through the REAL Spec Kit router, REAL auth (a signed token) and REAL
 * `requireProjectAccess` against a REAL SQLite database built by the migration
 * chain. Nothing is mocked but the Prisma singleton's binding to that database.
 * Every request a caller outside project B's workspace makes against B — every
 * route, every command in both its `speckit.*` and legacy spelling, synchronous
 * and as a job — must answer the seam's own 404 `NOT_FOUND`, disclose none of
 * B's content, and leave every Spec Kit table (and B's project row) exactly as
 * it was. The same caller on their OWN project is the positive control: the
 * request gets past the guard to the handler.
 *
 * No model is called. `AI_OFFLINE=1`; the refused requests stop at the guard,
 * and the member control sends commands a body the handler rejects (400)
 * before anything is dispatched.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { SPECKIT_COMMANDS, SPECKIT_LEGACY_ALIAS } from "@metis/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX = "100000";
  process.env.SPECKIT_EXPORT_LIVE_LIMIT_MAX = "100000";
  process.env.SPECKIT_JOB_PREAUTH_LIMIT_MAX = "100000";
  process.env.SPECKIT_JOB_LIMIT_MAX = "100000";
  process.env.SPECKIT_JOB_USER_WRITE_LIMIT_MAX = "100000";
  process.env.AI_OFFLINE = "1";
  return { db: null as unknown };
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

const { specKitRouter } = await import("../src/routes/spec-kit.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

const USER_ID = "u960-coord";
const WS_OWN = "ws-960-own";
const WS_OTHER = "ws-960-other";
/** The caller's own project — the positive control. */
const OWN = "p960-own";
/** Another workspace's project — every request against it must be refused. */
const FOREIGN = "p960-foreign";
const SLUG = "001-foo";
const ARCHIVED_SLUG = "002-archived";
const SECRET = "FOREIGN-SECRET-960";
const JOB_ID = "11111111-2222-4333-8444-555555555555";

/** Every spelling `POST /commands/:cmd` accepts: namespaced and legacy. */
const COMMANDS: string[] = [
  ...SPECKIT_COMMANDS,
  ...SPECKIT_COMMANDS.map((c) => SPECKIT_LEGACY_ALIAS[c]).filter(
    (c): c is NonNullable<typeof c> => c !== null,
  ),
];

type Method = "get" | "put" | "post" | "delete";
interface Call {
  name: string;
  method: Method;
  path: string;
  /** What a would-be attacker sends: a body the handler would act on. */
  body?: Record<string, unknown>;
  /** What the member control sends; defaults to `body`. */
  memberBody?: Record<string, unknown>;
  /** The status the member gets once past the guard. */
  memberStatus: number;
}

/** Every route the router registers, each with a body that would act. */
const ROUTES: Call[] = [
  { name: "GET /enabled", method: "get", path: "/enabled", memberStatus: 200 },
  {
    name: "PUT /enabled",
    method: "put",
    path: "/enabled",
    body: { enabled: false },
    memberBody: { enabled: true },
    memberStatus: 200,
  },
  { name: "GET /files", method: "get", path: "/files", memberStatus: 200 },
  { name: "GET /files/:name", method: "get", path: "/files/spec.md", memberStatus: 200 },
  {
    name: "PUT /files/:name",
    method: "put",
    path: "/files/spec.md",
    body: { content: "overwritten" },
    memberBody: { content: 42 },
    memberStatus: 400,
  },
  {
    name: "DELETE /files/:name",
    method: "delete",
    path: "/files/spec.md",
    memberStatus: 204,
  },
  {
    name: "POST /constitution",
    method: "post",
    path: "/constitution",
    body: { projectOverrides: "overwritten" },
    memberBody: { projectOverrides: 42 },
    memberStatus: 400,
  },
  { name: "GET /jobs", method: "get", path: "/jobs", memberStatus: 200 },
  { name: "GET /jobs/:jobId", method: "get", path: `/jobs/${JOB_ID}`, memberStatus: 404 },
  {
    name: "POST /jobs/:jobId/cancel",
    method: "post",
    path: `/jobs/${JOB_ID}/cancel`,
    memberStatus: 404,
  },
  { name: "GET /features", method: "get", path: "/features", memberStatus: 200 },
  {
    name: "GET /features/:slug/artifacts",
    method: "get",
    path: `/features/${SLUG}/artifacts`,
    memberStatus: 200,
  },
  {
    name: "GET /features/:slug/artifacts/*key",
    method: "get",
    path: `/features/${SLUG}/artifacts/spec.md`,
    memberStatus: 200,
  },
  {
    name: "PUT /features/:slug/artifacts/*key",
    method: "put",
    path: `/features/${SLUG}/artifacts/spec.md`,
    body: { content: "overwritten" },
    memberBody: { content: 42 },
    memberStatus: 400,
  },
  {
    name: "DELETE /features/:slug/artifacts/*key",
    method: "delete",
    path: `/features/${SLUG}/artifacts/spec.md`,
    memberStatus: 204,
  },
  {
    name: "GET /features/:slug/status",
    method: "get",
    path: `/features/${SLUG}/status`,
    memberStatus: 200,
  },
  {
    name: "POST /features/:slug/archive",
    method: "post",
    path: `/features/${SLUG}/archive`,
    memberStatus: 200,
  },
  {
    name: "POST /features/:slug/restore",
    method: "post",
    path: `/features/${ARCHIVED_SLUG}/restore`,
    body: {},
    memberBody: { restoreTo: 42 },
    memberStatus: 400,
  },
  {
    name: "POST /install",
    method: "post",
    path: "/install",
    body: { workspaceRoot: "/tmp/x" },
    memberStatus: 501,
  },
];

/** Each command, synchronous and as a job, in both spellings. */
const COMMAND_CALLS: Call[] = COMMANDS.flatMap((cmd) =>
  (["", "/jobs"] as const).map((suffix) => ({
    name: `POST /commands/${cmd}${suffix}`,
    method: "post" as const,
    path: `/commands/${cmd}${suffix}`,
    body: { input: "do it", featureSlug: SLUG, dryRun: true },
    // Rejected by the handler's own body validation: past the guard, before
    // any dispatch or model call.
    memberBody: { input: 42 },
    memberStatus: 400,
  })),
);

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#960 — every Spec Kit route refuses a caller outside the project's workspace (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let TOKEN = "";

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/projects/:projectId/spec-kit", specKitRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };

    const send = (projectId: string, call: Call, body: Record<string, unknown> | undefined) => {
      const req = request(app())
        [call.method](`/api/projects/${projectId}/spec-kit${call.path}`)
        .set("Authorization", `Bearer ${TOKEN}`);
      return body === undefined ? req : req.send(body);
    };

    /** Every Spec Kit row, and the project rows, ordered: a write changes it. */
    async function snapshot(): Promise<string> {
      const by = { orderBy: { id: "asc" as const } };
      return JSON.stringify({
        projects: await db.project.findMany(by),
        artifacts: await db.specKitArtifact.findMany(by),
        features: await db.specKitFeature.findMany(by),
        featureArtifacts: await db.specKitFeatureArtifact.findMany(by),
        constitutions: await db.specKitConstitution.findMany(by),
        configs: await db.specKitConfig.findMany(by),
        jobs: await db.specKitJob.findMany(by),
        exports: await db.specKitTaskExport.findMany(by),
        jobScopes: await db.jobScopeRecord.findMany({ orderBy: { jobId: "asc" } }),
      });
    }

    beforeAll(async () => {
      sqlite = createMigratedSqlite("960-speckit-project-access");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;

      await db.user.create({
        data: { id: USER_ID, username: USER_ID, displayName: USER_ID, email: "c960@x.test" },
      });
      for (const ws of [WS_OWN, WS_OTHER]) {
        await db.workspace.create({ data: { id: ws, name: ws, slug: ws } });
      }
      await db.workspaceMember.create({
        data: { workspaceId: WS_OWN, userId: USER_ID, role: "member" },
      });
      for (const [id, workspaceId] of [
        [OWN, WS_OWN],
        [FOREIGN, WS_OTHER],
      ] as const) {
        await db.project.create({
          data: { id, name: id, slug: id, createdById: USER_ID, workspaceId, specKitEnabled: true },
        });
        await db.specKitArtifact.create({
          data: { projectId: id, name: "spec.md", content: `${SECRET} ${id}` },
        });
        const f = await db.specKitFeature.create({
          data: { projectId: id, slug: SLUG, title: "Foo", status: "specified" },
        });
        await db.specKitFeature.create({
          data: { projectId: id, slug: ARCHIVED_SLUG, title: "Old", status: "archived" },
        });
        for (const key of ["spec.md", "plan.md", "tasks.md"]) {
          await db.specKitFeatureArtifact.create({
            data: { featureId: f.id, key, content: `${SECRET} ${id} ${key}` },
          });
        }
      }
      // A finished job in the foreign project, addressed by its real id.
      await db.specKitJob.create({
        data: {
          id: JOB_ID,
          projectId: FOREIGN,
          command: "speckit.plan",
          featureSlug: SLUG,
          status: "succeeded",
          result: JSON.stringify({ message: SECRET }),
          startedById: "someone-else",
          finishedAt: new Date(),
        },
      });

      TOKEN = issueTokens({
        userId: USER_ID,
        username: USER_ID,
        role: "coordinator",
        permissions: [],
        workspaces: [WS_OWN],
      }).accessToken;
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("covers every route the router registers", () => {
      const registered = (
        specKitRouter().stack as Array<{
          route?: { path: string; methods: Record<string, boolean> };
        }>
      )
        .filter((l) => l.route)
        .map((l) => `${Object.keys(l.route!.methods)[0]!.toUpperCase()} ${l.route!.path}`);
      const tested = [
        ...ROUTES.map((c) => c.name),
        "POST /commands/:cmd",
        "POST /commands/:cmd/jobs",
      ];
      expect(new Set(registered)).toEqual(new Set(tested));
    });

    it("puts requireProjectAccess after requireAuth and before the handler on every route", () => {
      const routes = (
        specKitRouter().stack as Array<{
          route?: { path: string; stack: Array<{ name: string }> };
        }>
      ).filter((l) => l.route);
      for (const { route } of routes) {
        const names = route!.stack.map((s) => s.name);
        const auth = names.indexOf("requireAuth");
        const guard = names.indexOf("requireProjectAccessMiddleware");
        expect(auth, `${route!.path} has no requireAuth`).toBeGreaterThan(-1);
        expect(guard, `${route!.path}: no guard, or guard before requireAuth`).toBeGreaterThan(
          auth,
        );
        expect(guard, `${route!.path}: guard is the handler`).toBeLessThan(names.length - 1);
      }
    });

    describe.each([...ROUTES, ...COMMAND_CALLS])("$name", (call) => {
      it("404s a caller from another workspace and writes nothing", async () => {
        const before = await snapshot();
        const res = await send(FOREIGN, call, call.body);
        expect(res.status, JSON.stringify(res.body)).toBe(404);
        expect(res.body.error.code).toBe("NOT_FOUND");
        expect(JSON.stringify(res.body)).not.toContain(SECRET);
        expect(res.headers.deprecation).toBeUndefined();
        expect(await snapshot()).toBe(before);
      });

      it("lets a member of the project's workspace past the guard", async () => {
        const res = await send(OWN, call, call.memberBody ?? call.body);
        expect(res.body?.error?.code, JSON.stringify(res.body)).not.toBe("NOT_FOUND");
        expect(res.status, JSON.stringify(res.body)).toBe(call.memberStatus);
      });
    });
  },
);
