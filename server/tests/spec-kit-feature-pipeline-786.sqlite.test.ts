/**
 * #786 — the per-feature Spec Kit pipeline completes with Spec Kit's own
 * commands, on a REAL SQLite database built from the migration chain and driven
 * through the REAL router (real auth, real gates, real artifact stores). Only
 * the model is a stub.
 *
 * Walkthrough shape (#706 run 2, Phase 14): a feature with spec.md and plan.md,
 * and a project that already has its own `.specify/tasks.md` (v1).
 *   - `speckit.tasks {featureSlug}` used to regenerate the PROJECT tasks.md
 *     (v1 → v2) and leave the feature without one, so `tasksGate` and
 *     `speckit.taskstoissues` could never be satisfied.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX = "100000";
  process.env.AI_OFFLINE = "1";
  return { db: null as unknown, replies: [] as string[] };
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
  audit: vi.fn(),
  getAuditService: vi.fn(() => ({ record: vi.fn() })),
}));
vi.mock("../src/lib/ai/project-provider.js", () => ({
  resolveProjectProvider: vi.fn(async () => ({
    key: "offline-stub",
    model: "stub",
    offline: false,
    async chat() {
      return {
        content: state.replies.shift() ?? "- **Q:** stub?",
        provider: "offline-stub",
        model: "stub",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "stop",
      };
    },
  })),
}));

const { specKitRouter } = await import("../src/routes/spec-kit.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { setSpecKitEnabled, writeArtifact, getArtifact } =
  await import("../src/lib/spec-kit/artifacts.js");
const { createFeature } = await import("../src/lib/spec-kit/features.js");
const { writeFeatureArtifact, getFeatureArtifact } =
  await import("../src/lib/spec-kit/feature-artifacts.js");

const PROJ = "proj-786";
const SLUG = "001-mark-all-entries-as-read-older-than-n-days";
const SPEC =
  "# Spec\nMark all entries as read older than N days.\n\n## Acceptance criteria\n- **AC-1**: older entries become read";
const PLAN = "# Plan\nExtend `internal/storage/entry.go` (`MarkAllAsReadBeforeDate`).";
const TASKS =
  "## Tasks\n\n- [ ] T01 — Expose MarkAllAsReadBeforeDate on the REST API with unit tests (satisfies: AC-1) depends-on: none";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#786 — speckit.* commands with a featureSlug use that feature's artifacts (real router, real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let token = "";
    let featureId = "";

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/projects/:projectId/spec-kit", specKitRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const command = (cmd: string, body: Record<string, unknown>, force = false) => {
      const req = request(app())
        .post(`/api/projects/${PROJ}/spec-kit/commands/${cmd}`)
        .set("Authorization", `Bearer ${token}`);
      return (force ? req.set("x-speckit-force", "1") : req).send(body);
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("786-speckit-feature");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: "u-786", username: "u-786", displayName: "U", email: "u786@example.test" },
      });
      await db.project.create({
        data: { id: PROJ, name: "Miniflux", slug: PROJ, description: "", createdById: "u-786" },
      });
      await setSpecKitEnabled(PROJ, true, "u-786");
      // The project's own `.specify/` set, which a feature command must not touch.
      await writeArtifact({ projectId: PROJ, name: "spec.md", content: "# Project spec" });
      await writeArtifact({ projectId: PROJ, name: "plan.md", content: "# Project plan" });
      await writeArtifact({
        projectId: PROJ,
        name: "tasks.md",
        content: "## Tasks\n- [ ] T01 — x",
      });
      const feature = await createFeature({ projectId: PROJ, title: "x", forcedSlug: SLUG });
      featureId = feature.id;
      await writeFeatureArtifact({ featureId, key: "spec.md", content: SPEC });
      token = issueTokens({
        userId: "u-786",
        username: "u-786",
        role: "admin",
        permissions: [],
        workspaces: [],
      }).accessToken;
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("speckit.tasks for a feature without plan.md is held by the plan gate", async () => {
      const res = await command("speckit.tasks", { featureSlug: SLUG });
      expect(res.status).toBe(412);
      expect(res.body.error.code).toBe("SPECKIT_GATE_UNMET");
      expect(res.body.error.message).toContain("/speckit.plan");
    });

    it("speckit.tasks writes the feature's tasks.md and leaves the project's alone", async () => {
      await writeFeatureArtifact({ featureId, key: "plan.md", content: PLAN });
      state.replies.push(TASKS);
      const res = await command("speckit.tasks", { featureSlug: SLUG });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ command: "tasks", featureSlug: SLUG });
      expect(res.body.data.message).toContain(`for ${SLUG}`);

      expect((await getFeatureArtifact(featureId, "tasks.md"))?.content).toBe(TASKS);
      expect(await getArtifact(PROJ, "tasks.md")).toMatchObject({ version: 1 });

      const status = await request(app())
        .get(`/api/projects/${PROJ}/spec-kit/features/${SLUG}/status`)
        .set("Authorization", `Bearer ${token}`);
      expect(status.body.data).toMatchObject({ tasksGate: true, implementGate: true });
    });

    it("speckit.taskstoissues can now plan the export (dry run)", async () => {
      const res = await command("speckit.taskstoissues", {
        featureSlug: SLUG,
        dryRun: true,
        repo: { owner: "acme", name: "tracker" },
      });
      expect(res.status).toBe(200);
      expect(res.body.data.count).toBe(1);
    });

    it("speckit.clarify, analyze and implement use the feature's set", async () => {
      state.replies.push("- **Q:** How many days by default?");
      const clarify = await command("speckit.clarify", { featureSlug: SLUG, input: "" });
      expect(clarify.status).toBe(200);
      expect((await getFeatureArtifact(featureId, "clarify.md"))?.content).toContain(
        "How many days by default?",
      );
      expect(await getArtifact(PROJ, "clarify.md")).toBeNull();

      state.replies.push("## Summary\nVerdict: OK");
      const analyze = await command("speckit.analyze", { featureSlug: SLUG });
      expect(analyze.status).toBe(200);
      expect((await getFeatureArtifact(featureId, "analysis.md"))?.content).toContain("Verdict");
      expect(await getArtifact(PROJ, "analysis.md")).toBeNull();

      const implement = await command("speckit.implement", { featureSlug: SLUG });
      expect(implement.status).toBe(200);
      expect(implement.body.data.artifact.context).toEqual([
        `specs/${SLUG}/spec.md`,
        `specs/${SLUG}/plan.md`,
        `specs/${SLUG}/tasks.md`,
      ]);
    });

    it("an unknown slug is a 404, and no slug keeps the project-level behaviour", async () => {
      const missing = await command("speckit.tasks", { featureSlug: "099-nope" });
      expect(missing.status).toBe(404);

      state.replies.push("## Tasks\n\n- [ ] T01 — project task (satisfies: AC-1) depends-on: none");
      const project = await command("speckit.tasks", {});
      expect(project.status).toBe(200);
      expect(await getArtifact(PROJ, "tasks.md")).toMatchObject({ version: 2 });
    });

    it("a forced taskstoissues with no tasks.md names the command that writes it", async () => {
      const other = await createFeature({ projectId: PROJ, title: "y", forcedSlug: "002-other" });
      await writeFeatureArtifact({ featureId: other.id, key: "spec.md", content: SPEC });
      const res = await command(
        "speckit.taskstoissues",
        { featureSlug: "002-other", dryRun: true, repo: { owner: "acme", name: "tracker" } },
        true,
      );
      expect(res.status).toBe(412);
      expect(res.body.error.message).toContain("/speckit.tasks with featureSlug 002-other");
    });
  },
);
