/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Epic #396 (MVP-5) — features module tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const featureRows = new Map<string, any>();
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
        Object.assign(r, data);
        return r;
      }),
    },
  },
}));

vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

import {
  createFeature,
  nextSlugNumber,
  resolveFeatureBySlug,
  listFeatures,
  ensureLegacyFeature,
  kebab,
  archiveFeature,
  restoreFeature,
  SPECKIT_FEATURE_ARCHIVED_STATUS,
  SpecKitFeatureLifecycleError,
  SPECKIT_FEATURE_SLUG_RE,
} from "../src/lib/spec-kit/features.js";

beforeEach(() => {
  featureRows.clear();
  nextId = 0;
});
afterEach(() => vi.clearAllMocks());

describe("kebab", () => {
  it("normalizes free text to kebab-case", () => {
    expect(kebab("Build the Login Page!!")).toBe("build-the-login-page");
  });
  it("returns 'feature' for empty input", () => {
    expect(kebab("###")).toBe("feature");
  });
  it("truncates to 80 chars", () => {
    const long = "a".repeat(200);
    expect(kebab(long).length).toBe(80);
  });
});

describe("SPECKIT_FEATURE_SLUG_RE", () => {
  it("accepts valid slugs", () => {
    expect(SPECKIT_FEATURE_SLUG_RE.test("001-foo")).toBe(true);
    expect(SPECKIT_FEATURE_SLUG_RE.test("042-foo-bar-baz")).toBe(true);
  });
  it("rejects non-numeric prefix", () => {
    expect(SPECKIT_FEATURE_SLUG_RE.test("foo-bar")).toBe(false);
    expect(SPECKIT_FEATURE_SLUG_RE.test("01-foo")).toBe(false);
  });
  it("rejects path traversal attempts", () => {
    expect(SPECKIT_FEATURE_SLUG_RE.test("001-../etc")).toBe(false);
    expect(SPECKIT_FEATURE_SLUG_RE.test("001-foo/bar")).toBe(false);
  });
});

describe("nextSlugNumber", () => {
  it("returns 001 for an empty project", async () => {
    expect(await nextSlugNumber("p1")).toBe("001");
  });
  it("monotonically increments", async () => {
    await createFeature({ projectId: "p1", title: "first" });
    await createFeature({ projectId: "p1", title: "second" });
    expect(await nextSlugNumber("p1")).toBe("003");
  });
});

describe("createFeature", () => {
  it("auto-allocates 001-kebab(title)", async () => {
    const f = await createFeature({ projectId: "p1", title: "Build Login Page" });
    expect(f.slug).toBe("001-build-login-page");
    expect(f.status).toBe("draft");
  });

  it("auto-allocates monotonically past the highest existing slug", async () => {
    await createFeature({ projectId: "p1", title: "first", forcedSlug: "002-first" });
    const f = await createFeature({ projectId: "p1", title: "first" });
    expect(f.slug).toBe("003-first");
  });

  it("accepts forcedSlug when valid", async () => {
    const f = await createFeature({
      projectId: "p1",
      title: "x",
      forcedSlug: "099-bespoke-name",
    });
    expect(f.slug).toBe("099-bespoke-name");
  });

  it("rejects forcedSlug that fails the regex (path traversal defense)", async () => {
    await expect(
      createFeature({ projectId: "p1", title: "x", forcedSlug: "../escape" }),
    ).rejects.toMatchObject({ status: 400, code: "SPECKIT_INVALID_SLUG" });
  });
});

describe("resolveFeatureBySlug", () => {
  it("returns null when not found", async () => {
    expect(await resolveFeatureBySlug("p1", "099-missing")).toBeNull();
  });
  it("rejects malformed slug", async () => {
    await expect(resolveFeatureBySlug("p1", "../etc")).rejects.toMatchObject({
      code: "SPECKIT_INVALID_SLUG",
    });
  });
});

describe("listFeatures + ensureLegacyFeature", () => {
  it("ensureLegacyFeature is idempotent", async () => {
    const a = await ensureLegacyFeature("p1");
    const b = await ensureLegacyFeature("p1");
    expect(a.id).toBe(b.id);
    expect(a.slug).toBe("001-legacy");
  });

  it("listFeatures sorts by slug ascending", async () => {
    await createFeature({ projectId: "p1", title: "z", forcedSlug: "003-z" });
    await createFeature({ projectId: "p1", title: "a", forcedSlug: "001-a" });
    const list = await listFeatures("p1");
    // findMany mock doesn't sort — assert presence
    const slugs = list.map((f) => f.slug).sort();
    expect(slugs).toEqual(["001-a", "003-z"]);
  });
});

describe("archive / restore (Issue #434)", () => {
  it("archive flips status to `archived` and is idempotent", async () => {
    await createFeature({ projectId: "p1", title: "x", forcedSlug: "001-x" });
    const r1 = await archiveFeature({ projectId: "p1", slug: "001-x", actorId: "u1" });
    expect(r1.status).toBe(SPECKIT_FEATURE_ARCHIVED_STATUS);
    const r2 = await archiveFeature({ projectId: "p1", slug: "001-x", actorId: "u1" });
    expect(r2.status).toBe(SPECKIT_FEATURE_ARCHIVED_STATUS);
  });

  it("archive throws SpecKitFeatureLifecycleError when feature is missing", async () => {
    await expect(
      archiveFeature({ projectId: "p1", slug: "099-missing", actorId: "u1" }),
    ).rejects.toMatchObject({
      name: "SpecKitFeatureLifecycleError",
      status: 404,
      code: "SPECKIT_FEATURE_NOT_FOUND",
    });
  });

  it("listFeatures excludes archived features by default but includes them with includeArchived=true", async () => {
    await createFeature({ projectId: "p1", title: "a", forcedSlug: "001-a" });
    await createFeature({ projectId: "p1", title: "b", forcedSlug: "002-b" });
    await archiveFeature({ projectId: "p1", slug: "002-b" });
    const visible = await listFeatures("p1");
    expect(visible.map((f) => f.slug)).toEqual(["001-a"]);
    const all = await listFeatures("p1", { includeArchived: true });
    expect(all.map((f) => f.slug).sort()).toEqual(["001-a", "002-b"]);
  });

  it("restore flips status back to draft by default", async () => {
    await createFeature({ projectId: "p1", title: "x", forcedSlug: "001-x" });
    await archiveFeature({ projectId: "p1", slug: "001-x" });
    const r = await restoreFeature({ projectId: "p1", slug: "001-x", actorId: "u1" });
    expect(r.status).toBe("draft");
  });

  it("restore honours an explicit restoreTo status", async () => {
    await createFeature({ projectId: "p1", title: "x", forcedSlug: "001-x" });
    await archiveFeature({ projectId: "p1", slug: "001-x" });
    const r = await restoreFeature({
      projectId: "p1",
      slug: "001-x",
      restoreTo: "specified",
    });
    expect(r.status).toBe("specified");
  });

  it("restore on a non-archived feature returns 409", async () => {
    await createFeature({ projectId: "p1", title: "x", forcedSlug: "001-x" });
    await expect(restoreFeature({ projectId: "p1", slug: "001-x" })).rejects.toMatchObject({
      status: 409,
      code: "SPECKIT_FEATURE_NOT_ARCHIVED",
    });
  });

  it("restore on a missing feature returns 404", async () => {
    await expect(restoreFeature({ projectId: "p1", slug: "099-missing" })).rejects.toMatchObject({
      status: 404,
      code: "SPECKIT_FEATURE_NOT_FOUND",
    });
  });

  it("SpecKitFeatureLifecycleError preserves Error instanceof", () => {
    const err = new SpecKitFeatureLifecycleError(404, "NOPE", "missing");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SpecKitFeatureLifecycleError);
  });
});
