/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Issue #435 — full-chain integration coverage for the v1.3 spec-kit
 * surface. Exercises the seam between the new helpers landing in this
 * PR (archive/restore + issue-sync) using a single shared in-memory
 * Prisma stub so that we observe behaviour end-to-end without mocking
 * each helper in isolation.
 *
 * Flow:
 *   1. Create a feature.
 *   2. Write a tasks.md artifact under the feature.
 *   3. Export a task → SpecKitTaskExport row mapped to a fake GH issue.
 *   4. Fire `closed` and `edited` issue events through syncIssueEvent
 *      and assert the artifact mutates idempotently.
 *   5. Archive the feature, confirm `listFeatures` hides it by default
 *      and surfaces it with `includeArchived=true`.
 *   6. Restore and confirm the feature returns to `draft`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const featureRows = new Map<string, any>();
const featureArtifactRows = new Map<string, any>();
const taskExportRows = new Map<string, any>();
let nextId = 0;

class P2002 extends Error {
  code = "P2002";
}

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    auditLog: { create: vi.fn(async () => ({})) },
    specKitFeature: {
      findMany: vi.fn(async ({ where, select }: any) => {
        let all = [...featureRows.values()].filter((r) => r.projectId === where.projectId);
        if (where.status?.not !== undefined) {
          all = all.filter((r) => r.status !== where.status.not);
        }
        if (select) return all.map((r) => ({ slug: r.slug }));
        return all;
      }),
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.id) return featureRows.get(where.id) ?? null;
        if (where.projectId_slug) {
          for (const r of featureRows.values()) {
            if (
              r.projectId === where.projectId_slug.projectId &&
              r.slug === where.projectId_slug.slug
            )
              return r;
          }
        }
        return null;
      }),
      create: vi.fn(async ({ data }: any) => {
        const dup = [...featureRows.values()].find(
          (r) => r.projectId === data.projectId && r.slug === data.slug,
        );
        if (dup) throw new P2002("unique violation");
        nextId++;
        const row = {
          id: `f_${nextId}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          status: data.status ?? "draft",
          branchName: data.branchName ?? null,
          createdById: data.createdById ?? null,
          ...data,
        };
        featureRows.set(row.id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const r = featureRows.get(where.id);
        Object.assign(r, data, { updatedAt: new Date() });
        return r;
      }),
    },
    specKitFeatureArtifact: {
      findUnique: vi.fn(async ({ where }: any) => {
        for (const r of featureArtifactRows.values()) {
          if (r.featureId === where.featureId_key.featureId && r.key === where.featureId_key.key) {
            return r;
          }
        }
        return null;
      }),
      create: vi.fn(async ({ data }: any) => {
        nextId++;
        const row = {
          id: `fa_${nextId}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          version: data.version ?? 1,
          ...data,
        };
        featureArtifactRows.set(row.id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const r = featureArtifactRows.get(where.id);
        Object.assign(r, data, { updatedAt: new Date() });
        return r;
      }),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        for (const r of featureArtifactRows.values()) {
          if (r.featureId === where.featureId_key.featureId && r.key === where.featureId_key.key) {
            Object.assign(r, update, { updatedAt: new Date() });
            return r;
          }
        }
        nextId++;
        const row = {
          id: `fa_${nextId}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          version: 1,
          ...create,
        };
        featureArtifactRows.set(row.id, row);
        return row;
      }),
    },
    specKitTaskExport: {
      create: vi.fn(async ({ data }: any) => {
        nextId++;
        const row = { id: `tx_${nextId}`, ...data };
        taskExportRows.set(row.id, row);
        return row;
      }),
      findFirst: vi.fn(async ({ where }: any) => {
        for (const r of taskExportRows.values()) {
          if (
            r.repoOwner === where.repoOwner &&
            r.repoName === where.repoName &&
            r.issueNumber === where.issueNumber
          )
            return r;
        }
        return null;
      }),
    },
  },
}));

vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

import {
  createFeature,
  archiveFeature,
  restoreFeature,
  listFeatures,
  SPECKIT_FEATURE_ARCHIVED_STATUS,
} from "../src/lib/spec-kit/features.js";
import { writeFeatureArtifact, getFeatureArtifact } from "../src/lib/spec-kit/feature-artifacts.js";
import { syncIssueEvent } from "../src/lib/spec-kit/issue-sync.js";
import { prisma } from "../src/lib/prisma.js";

beforeEach(() => {
  featureRows.clear();
  featureArtifactRows.clear();
  taskExportRows.clear();
  nextId = 0;
});
afterEach(() => vi.clearAllMocks());

describe("spec-kit full chain (Issue #435)", () => {
  it("end-to-end: create → tasks export → issue-sync → archive → restore", async () => {
    // 1) Create the feature.
    const feature = await createFeature({
      projectId: "p1",
      title: "Login",
      forcedSlug: "001-login",
    });
    expect(feature.slug).toBe("001-login");

    // 2) Write tasks.md (mix of bullet and table form to exercise both branches).
    const tasksMd = [
      "# Tasks",
      "",
      "- [ ] T01 Wire up login form",
      "",
      "| ID | Title | Status |",
      "| --- | --- | --- |",
      "| T02 | Build auth API | todo |",
      "",
    ].join("\n");
    await writeFeatureArtifact({
      featureId: feature.id,
      key: "tasks.md",
      content: tasksMd,
      actorId: null,
    });

    // 3) Stamp the task exports so the webhook sync can find them.
    await prisma.specKitTaskExport.create({
      data: {
        projectId: "p1",
        featureSlug: "001-login",
        taskId: "T01",
        title: "Wire up login form",
        issueNumber: 4321,
        repoOwner: "acme",
        repoName: "metis",
      },
    });
    await prisma.specKitTaskExport.create({
      data: {
        projectId: "p1",
        featureSlug: "001-login",
        taskId: "T02",
        title: "Build auth API",
        issueNumber: 4322,
        repoOwner: "acme",
        repoName: "metis",
      },
    });

    // 4a) Closing issue 4321 ticks the bullet form.
    const closed = await syncIssueEvent({
      action: "closed",
      issueNumber: 4321,
      repoOwner: "acme",
      repoName: "metis",
    });
    expect(closed).toMatchObject({ handled: true, change: "checkbox" });
    let updated = await getFeatureArtifact(feature.id, "tasks.md");
    expect(updated?.content).toContain("- [x] T01 Wire up login form");

    // 4b) Editing issue 4322 renames the table row, not the bullet row.
    const renamed = await syncIssueEvent({
      action: "edited",
      issueNumber: 4322,
      repoOwner: "acme",
      repoName: "metis",
      newTitle: "Build SAML auth API",
    });
    expect(renamed).toMatchObject({ handled: true, change: "title" });
    updated = await getFeatureArtifact(feature.id, "tasks.md");
    expect(updated?.content).toContain("| T02 | Build SAML auth API | todo |");
    // bullet row untouched
    expect(updated?.content).toContain("- [x] T01 Wire up login form");

    // 4c) Re-applying the same close event is a no-op.
    const replay = await syncIssueEvent({
      action: "closed",
      issueNumber: 4321,
      repoOwner: "acme",
      repoName: "metis",
    });
    expect(replay).toMatchObject({ handled: true, change: "noop" });

    // 5) Archive hides the feature from the default listing.
    const archived = await archiveFeature({
      projectId: "p1",
      slug: "001-login",
      actorId: "u1",
    });
    expect(archived.status).toBe(SPECKIT_FEATURE_ARCHIVED_STATUS);
    expect(await listFeatures("p1")).toEqual([]);
    const all = await listFeatures("p1", { includeArchived: true });
    expect(all.map((f) => f.slug)).toEqual(["001-login"]);

    // 6) Restore returns to draft.
    const restored = await restoreFeature({
      projectId: "p1",
      slug: "001-login",
      actorId: "u1",
    });
    expect(restored.status).toBe("draft");
    expect((await listFeatures("p1"))[0]?.slug).toBe("001-login");
  });

  it("issue events for unknown task exports return a not-handled outcome", async () => {
    const outcome = await syncIssueEvent({
      action: "closed",
      issueNumber: 9999,
      repoOwner: "acme",
      repoName: "metis",
    });
    expect(outcome).toMatchObject({ handled: false, reason: "NO_TASK_EXPORT" });
  });
});
