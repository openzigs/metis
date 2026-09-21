/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Epic #396 — coverage-boost tests for the runner-driven MVP commands
 * (specify-feature, plan-expanded, checklist, taskstoissues) plus residual
 * branch coverage in features.ts, installer/path-guard.ts, installer/skeleton.ts.
 *
 * Mocks Prisma + governance hooks so the runners are exercised in isolation
 * (mirrors the `spec-kit-commands.test.ts` pattern).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import type { AIProvider, ChatMessage, ChatResponse } from "../src/lib/ai/types.js";

const featureRows = new Map<string, any>();
const featureArtifactRows = new Map<string, any>();
const artifactRows = new Map<string, any>();
const constitutionRows = new Map<string, any>();
const configRows = new Map<string, any>();
const taskExportRows = new Map<string, any>();
const repoConnRows = new Map<string, any>();
const projects = new Map<string, any>();
const auditCalls: any[] = [];
let nextId = 0;

class P2002 extends Error {
  code = "P2002";
}

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    auditLog: { create: vi.fn(async () => ({})) },
    project: {
      findUnique: vi.fn(async ({ where }: any) => projects.get(where.id) ?? null),
    },
    specKitFeature: {
      findMany: vi.fn(async ({ where, select }: any) => {
        const all = [...featureRows.values()].filter((r) => r.projectId === where.projectId);
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
      findMany: vi.fn(async ({ where }: any) =>
        [...featureArtifactRows.values()].filter((r) => r.featureId === where.featureId),
      ),
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.featureId_key) {
          for (const r of featureArtifactRows.values()) {
            if (r.featureId === where.featureId_key.featureId && r.key === where.featureId_key.key)
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
          version: 1,
          updatedById: data.updatedById ?? null,
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
    },
    specKitArtifact: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.projectId_name) {
          for (const r of artifactRows.values()) {
            if (
              r.projectId === where.projectId_name.projectId &&
              r.name === where.projectId_name.name
            )
              return r;
          }
        }
        return null;
      }),
    },
    specKitConstitution: {
      findUnique: vi.fn(async ({ where }: any) => constitutionRows.get(where.projectId) ?? null),
    },
    specKitConfig: {
      findUnique: vi.fn(async ({ where }: any) => configRows.get(where.projectId) ?? null),
    },
    specKitTaskExport: {
      findUnique: vi.fn(async ({ where }: any) => {
        const k = where.projectId_featureSlug_taskId;
        if (!k) return null;
        const id = `${k.projectId}|${k.featureSlug}|${k.taskId}`;
        return taskExportRows.get(id) ?? null;
      }),
      create: vi.fn(async ({ data }: any) => {
        const id = `${data.projectId}|${data.featureSlug}|${data.taskId}`;
        const row = { id, createdAt: new Date(), ...data };
        taskExportRows.set(id, row);
        return row;
      }),
    },
    repoConnection: {
      findFirst: vi.fn(async ({ where }: any) => {
        for (const r of repoConnRows.values()) {
          if (r.projectId === where.projectId && r.deletedAt === null) return r;
        }
        return null;
      }),
    },
  },
}));

vi.mock("../src/lib/audit/audit-service.js", () => ({
  audit: vi.fn((entry: any) => {
    auditCalls.push(entry);
  }),
  getAuditService: vi.fn(() => ({ record: vi.fn() })),
}));

vi.mock("../src/lib/finops/index.js", () => ({
  assertWithinBudget: vi.fn(async () => undefined),
  BudgetExceededError: class extends Error {},
  recordUsage: vi.fn(() => ({ totalTokens: 0, costCents: 0 })),
}));

vi.mock("../src/lib/safety/index.js", () => ({
  applySafety: vi.fn(async (text: string) => ({ text, redacted: false })),
  SafetyDeniedError: class extends Error {},
}));

import {
  createFeature,
  updateFeatureStatus,
  ensureLegacyFeature,
} from "../src/lib/spec-kit/features.js";
import { runChecklist } from "../src/lib/spec-kit/commands/checklist.js";
import { runPlanExpanded } from "../src/lib/spec-kit/commands/plan-expanded.js";
import { runSpecifyFeature } from "../src/lib/spec-kit/commands/specify-feature.js";
import { runTasksToIssues } from "../src/lib/spec-kit/commands/taskstoissues.js";
import {
  resolveAttached,
  passthroughWorkspaceLookup,
} from "../src/lib/spec-kit/installer/path-guard.js";
import {
  constitutionFile,
  statusFile,
  isStatusFileForArtifact,
  emitFeatureFiles,
  SPECIFY_SKELETON,
} from "../src/lib/spec-kit/installer/skeleton.js";
import { SpecKitArtifactError } from "../src/lib/spec-kit/artifacts.js";

class FakeProvider implements AIProvider {
  readonly key: any = "offline-stub";
  constructor(private readonly text: string) {}
  async chat(_m: ChatMessage[], _o: unknown): Promise<ChatResponse> {
    return {
      content: this.text,
      provider: this.key,
      model: "fake-model",
      usage: { promptTokens: 5, completionTokens: 7, totalTokens: 12 },
      finishReason: "stop",
    } as unknown as ChatResponse;
  }
}

function seedFeature(projectId: string, slug: string, id?: string): string {
  const fid = id ?? `f_${slug}`;
  featureRows.set(fid, {
    id: fid,
    projectId,
    slug,
    title: slug,
    status: "draft",
    branchName: null,
    createdById: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return fid;
}

function seedFeatureArtifact(featureId: string, key: string, content: string): void {
  const id = `fa_${featureId}_${key}`;
  featureArtifactRows.set(id, {
    id,
    featureId,
    key,
    content,
    version: 1,
    updatedById: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

beforeEach(() => {
  featureRows.clear();
  featureArtifactRows.clear();
  artifactRows.clear();
  constitutionRows.clear();
  configRows.clear();
  taskExportRows.clear();
  repoConnRows.clear();
  projects.clear();
  auditCalls.length = 0;
  nextId = 0;
  projects.set("p1", {
    id: "p1",
    name: "Demo",
    description: "Demo project",
    safetyMode: "standard",
    aiProviderId: null,
  });
  // Seed both the structured metadata + the v1.2 artifact body so the
  // loadAsPreamble path returns non-null (plan-expanded preamble gate).
  constitutionRows.set("p1", {
    id: "c_1",
    projectId: "p1",
    version: "1.0.0",
    ratifiedAt: new Date("2026-01-01"),
    lastAmendedAt: new Date("2026-01-01"),
  });
  artifactRows.set("ska_const_p1", {
    id: "ska_const_p1",
    projectId: "p1",
    name: "constitution.md",
    content: "# Project Constitution\n\nVersion: 1.0.0\n",
    version: 1,
    updatedById: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
});

afterEach(() => vi.clearAllMocks());

// ─────────────────────────────────────────────────────────────────────────────
// features.ts — residual branches
// ─────────────────────────────────────────────────────────────────────────────
describe("features.ts residual branches", () => {
  it("createFeature retries past P2002 collisions and lands a unique slug", async () => {
    seedFeature("p1", "001-collide");
    const f = await createFeature({ projectId: "p1", title: "collide" });
    // Slug "001-collide" already taken — should land on the next NNN.
    expect(f.slug).not.toBe("001-collide");
    expect(/^\d{3}-collide$/.test(f.slug)).toBe(true);
  });

  it("createFeature defaults blank title to 'untitled'", async () => {
    const f = await createFeature({ projectId: "p1", title: "  " });
    expect(f.title).toBe("untitled");
  });

  it("updateFeatureStatus mutates row and audits with actor", async () => {
    const fid = seedFeature("p1", "010-x");
    await updateFeatureStatus(fid, "planned", "u1");
    expect(featureRows.get(fid)!.status).toBe("planned");
    expect(auditCalls.some((c) => c.action === "speckit.feature.status_updated")).toBe(true);
  });

  it("updateFeatureStatus allows null actor", async () => {
    const fid = seedFeature("p1", "011-x");
    await updateFeatureStatus(fid, "implemented");
    expect(featureRows.get(fid)!.status).toBe("implemented");
  });

  it("ensureLegacyFeature creates 001-legacy when missing", async () => {
    const f = await ensureLegacyFeature("p1");
    expect(f.slug).toBe("001-legacy");
  });

  it("throws SPECKIT_INVALID_SLUG when generated slug overflows the 3-digit cap", async () => {
    // Pre-seed 999-x so nextSlugNumber returns "1000" → "1000-x" fails the regex.
    seedFeature("p1", "999-x");
    await expect(createFeature({ projectId: "p1", title: "x" })).rejects.toMatchObject({
      code: "SPECKIT_INVALID_SLUG",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// installer/path-guard.ts — residual branches
// ─────────────────────────────────────────────────────────────────────────────
describe("installer/path-guard residual", () => {
  it("rejects internal-but-traversal-segment paths (defence-in-depth)", async () => {
    // The raw input contains `..` so the defence-in-depth guard fires
    // even though a lexical normalisation would land back inside.
    await expect(
      resolveAttached({ workspaceRoot: "/tmp/ws", target: "foo/../bar" }),
    ).rejects.toBeInstanceOf(SpecKitArtifactError);
  });

  it("passthroughWorkspaceLookup returns null", async () => {
    expect(await passthroughWorkspaceLookup.resolveWorkspaceRoot("p1")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// installer/skeleton.ts — residual coverage
// ─────────────────────────────────────────────────────────────────────────────
describe("installer/skeleton residual", () => {
  it("constitutionFile emits the canonical .specify path", () => {
    const f = constitutionFile("# C\n");
    expect(f.relPath).toBe(".specify/memory/constitution.md");
    expect(f.content).toBe("# C\n");
  });

  it("statusFile emits specs/<slug>/status.json", () => {
    const f = statusFile("001-foo", {
      specGate: true,
      planGate: false,
      tasksGate: false,
      implementGate: false,
      lastUpdated: "2026-04-30T00:00:00.000Z",
    });
    expect(f.relPath).toBe("specs/001-foo/status.json");
    const parsed = JSON.parse(f.content);
    expect(parsed.specGate).toBe(true);
  });

  it("isStatusFileForArtifact always returns true (status.json regenerated on every mutation)", () => {
    expect(
      isStatusFileForArtifact({
        id: "fa_1",
        featureId: "f_1",
        key: "spec.md",
        content: "x",
        version: 1,
        updatedById: null,
        createdAt: "2026-04-30T00:00:00.000Z",
        updatedAt: "2026-04-30T00:00:00.000Z",
      }),
    ).toBe(true);
  });

  it("SPECIFY_SKELETON includes the four .specify directories", () => {
    const paths = SPECIFY_SKELETON.map((s) => s.relPath);
    expect(paths).toContain(".specify/memory/_checklist.md");
    expect(paths).toContain(".specify/scripts/bash/.gitkeep");
    expect(paths).toContain(".specify/scripts/powershell/.gitkeep");
    expect(paths).toContain(".specify/templates/.gitkeep");
  });

  it("emitFeatureFiles bundles every artifact + status.json", async () => {
    const fid = seedFeature("p1", "001-build");
    seedFeatureArtifact(fid, "spec.md", "Spec body");
    seedFeatureArtifact(fid, "plan.md", "Plan body");
    const { files, status } = await emitFeatureFiles({
      id: fid,
      projectId: "p1",
      slug: "001-build",
      title: "Build",
      status: "draft",
      branchName: null,
      createdById: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(files.find((f) => f.relPath === "specs/001-build/spec.md")).toBeTruthy();
    expect(files.find((f) => f.relPath === "specs/001-build/status.json")).toBeTruthy();
    expect(status.specGate).toBe(true);
    expect(status.planGate).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runSpecifyFeature
// ─────────────────────────────────────────────────────────────────────────────
describe("runSpecifyFeature", () => {
  it("rejects empty prompt", async () => {
    await expect(runSpecifyFeature({ projectId: "p1", prompt: "  " })).rejects.toMatchObject({
      code: "SPECKIT_EMPTY_INPUT",
    });
  });

  it("creates a new feature + writes spec.md", async () => {
    const r = await runSpecifyFeature({
      projectId: "p1",
      prompt: "Build the billing dashboard.",
      actorId: "u1",
      deps: { provider: new FakeProvider("# Spec\n\nbody") },
    });
    expect(r.feature.slug).toMatch(/^\d{3}-/);
    expect(r.artifact.key).toBe("spec.md");
    expect(r.artifact.content).toContain("# Spec");
    expect(r.tokensUsed).toBe(12);
    expect(r.message).toContain("spec.md");
  });

  it("re-uses existing feature when featureSlugOverride matches", async () => {
    seedFeature("p1", "042-existing");
    const r = await runSpecifyFeature({
      projectId: "p1",
      prompt: "Updated spec",
      featureSlugOverride: "042-existing",
      deps: { provider: new FakeProvider("# Spec v2") },
    });
    expect(r.feature.slug).toBe("042-existing");
    // Existing row re-used — no new feature created.
    expect([...featureRows.values()].filter((f) => f.slug === "042-existing").length).toBe(1);
  });

  it("creates a new feature with forcedSlug when override does not exist yet", async () => {
    const r = await runSpecifyFeature({
      projectId: "p1",
      prompt: "Brand new override",
      featureSlugOverride: "099-bespoke",
      deps: { provider: new FakeProvider("# Spec") },
    });
    expect(r.feature.slug).toBe("099-bespoke");
  });

  it("invokes branchClient when SPECKIT_AUTOBRANCH=true (best-effort, swallows errors)", async () => {
    const prev = process.env.SPECKIT_AUTOBRANCH;
    process.env.SPECKIT_AUTOBRANCH = "true";
    const branchClient = {
      createBranch: vi.fn(async () => {
        throw new Error("git failed");
      }),
    };
    try {
      await runSpecifyFeature({
        projectId: "p1",
        prompt: "Branch me",
        branchClient,
        deps: { provider: new FakeProvider("# Spec") },
      });
      expect(branchClient.createBranch).toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.SPECKIT_AUTOBRANCH;
      else process.env.SPECKIT_AUTOBRANCH = prev;
    }
  });

  it("ignores process.env.SPECIFY_FEATURE — slug is request-scoped only (AC #427)", async () => {
    const prev = process.env.SPECIFY_FEATURE;
    process.env.SPECIFY_FEATURE = "999-tenant-leak";
    try {
      const r = await runSpecifyFeature({
        projectId: "p1",
        prompt: "No tenant cross-talk allowed",
        deps: { provider: new FakeProvider("# Spec") },
      });
      // Auto-allocated NNN — never the env value.
      expect(r.feature.slug).not.toBe("999-tenant-leak");
      expect(r.feature.slug).toMatch(/^\d{3}-/);
    } finally {
      if (prev === undefined) delete process.env.SPECIFY_FEATURE;
      else process.env.SPECIFY_FEATURE = prev;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runPlanExpanded
// ─────────────────────────────────────────────────────────────────────────────
describe("runPlanExpanded", () => {
  it("returns 404 when feature missing", async () => {
    await expect(
      runPlanExpanded({ projectId: "p1", featureSlug: "099-nope" }),
    ).rejects.toMatchObject({ code: "SPECKIT_FEATURE_NOT_FOUND" });
  });

  it("requires constitution preamble (412 GateUnmet)", async () => {
    constitutionRows.clear();
    seedFeature("p1", "001-foo");
    await expect(
      runPlanExpanded({ projectId: "p1", featureSlug: "001-foo" }),
    ).rejects.toMatchObject({ code: "SPECKIT_GATE_UNMET" });
  });

  it("requires spec.md (412 GateUnmet)", async () => {
    seedFeature("p1", "001-foo");
    await expect(
      runPlanExpanded({
        projectId: "p1",
        featureSlug: "001-foo",
        deps: { provider: new FakeProvider("ignored") },
      }),
    ).rejects.toMatchObject({ code: "SPECKIT_GATE_UNMET" });
  });

  it("emits 5 artifacts when prerequisites are met", async () => {
    const fid = seedFeature("p1", "001-foo");
    seedFeatureArtifact(fid, "spec.md", "# Spec\nbody");
    const r = await runPlanExpanded({
      projectId: "p1",
      featureSlug: "001-foo",
      deps: {
        provider: new FakeProvider(
          "openapi: 3.1.0\ninfo:\n  title: x\n  version: 1.0.0\npaths: {}",
        ),
      },
    });
    expect(r.artifacts.length).toBe(5);
    const keys = r.artifacts.map((a) => a.key).sort();
    expect(keys).toContain("plan.md");
    expect(keys).toContain("research.md");
    expect(keys).toContain("data-model.md");
    expect(keys).toContain("contracts/api.openapi.yaml");
    expect(keys).toContain("quickstart.md");
    // Plan content auto-augmented with Constitution Compliance Check section.
    const plan = r.artifacts.find((a) => a.key === "plan.md")!;
    expect(plan.content).toMatch(/Constitution Compliance Check/);
    // Research auto-augmented with "Resolved Unknowns: none" when spec has no markers.
    const research = r.artifacts.find((a) => a.key === "research.md")!;
    expect(research.content).toMatch(/Resolved Unknowns: none/);
    // Feature status promoted to 'planned'.
    expect(featureRows.get(fid)!.status).toBe("planned");
  });

  it("does not append 'Resolved Unknowns: none' when spec has [NEEDS CLARIFICATION] markers", async () => {
    const fid = seedFeature("p1", "002-foo");
    seedFeatureArtifact(fid, "spec.md", "# Spec\nfoo [NEEDS CLARIFICATION] bar");
    const r = await runPlanExpanded({
      projectId: "p1",
      featureSlug: "002-foo",
      deps: { provider: new FakeProvider("## Resolved Unknowns\n- bar resolved") },
    });
    const research = r.artifacts.find((a) => a.key === "research.md")!;
    // Unchanged — model output already covers Resolved Unknowns.
    expect(research.content).not.toMatch(/Resolved Unknowns: none/);
    void fid;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runChecklist
// ─────────────────────────────────────────────────────────────────────────────
describe("runChecklist", () => {
  it("returns 404 when feature missing", async () => {
    await expect(runChecklist({ projectId: "p1", featureSlug: "099-nope" })).rejects.toMatchObject({
      code: "SPECKIT_FEATURE_NOT_FOUND",
    });
  });

  it("412 when planGate unmet (no spec/plan)", async () => {
    seedFeature("p1", "001-foo");
    await expect(runChecklist({ projectId: "p1", featureSlug: "001-foo" })).rejects.toMatchObject({
      code: "SPECKIT_GATE_UNMET",
    });
  });

  it("emits one artifact per default domain when planGate met", async () => {
    const fid = seedFeature("p1", "001-foo");
    seedFeatureArtifact(fid, "spec.md", "spec body");
    seedFeatureArtifact(fid, "plan.md", "plan body");
    const r = await runChecklist({
      projectId: "p1",
      featureSlug: "001-foo",
      actorId: "u1",
    });
    expect(r.domains.length).toBe(5);
    expect(r.artifacts.length).toBe(5);
    expect(r.artifacts.every((a) => a.key.startsWith("checklist-"))).toBe(true);
  });

  it("honours explicit domain override", async () => {
    const fid = seedFeature("p1", "001-foo");
    seedFeatureArtifact(fid, "spec.md", "spec body");
    seedFeatureArtifact(fid, "plan.md", "plan body");
    const r = await runChecklist({
      projectId: "p1",
      featureSlug: "001-foo",
      domains: ["security"],
    });
    expect(r.domains).toEqual(["security"]);
    expect(r.artifacts.length).toBe(1);
    expect(r.artifacts[0]!.key).toBe("checklist-security.md");
  });

  it("merge mode preserves checked state on second run", async () => {
    const fid = seedFeature("p1", "001-foo");
    seedFeatureArtifact(fid, "spec.md", "spec body");
    seedFeatureArtifact(fid, "plan.md", "plan body");
    // First run.
    await runChecklist({ projectId: "p1", featureSlug: "001-foo", domains: ["security"] });
    // Manually check the first item.
    const fa = [...featureArtifactRows.values()].find((r) => r.key === "checklist-security.md")!;
    fa.content = fa.content.replace(/^- \[ \]/m, "- [x]");
    // Second run — merge.
    await runChecklist({
      projectId: "p1",
      featureSlug: "001-foo",
      domains: ["security"],
      mode: "merge",
    });
    const fa2 = [...featureArtifactRows.values()].find((r) => r.key === "checklist-security.md")!;
    expect(fa2.content).toContain("- [x]");
  });

  it("reads custom domains from SpecKitConfig.checklistDomains JSON", async () => {
    configRows.set("p1", {
      projectId: "p1",
      checklistDomains: JSON.stringify(["custom-domain-a", "custom-domain-b"]),
    });
    const fid = seedFeature("p1", "001-foo");
    seedFeatureArtifact(fid, "spec.md", "x");
    seedFeatureArtifact(fid, "plan.md", "x");
    const r = await runChecklist({ projectId: "p1", featureSlug: "001-foo" });
    expect(r.domains).toEqual(["custom-domain-a", "custom-domain-b"]);
  });

  it("falls back to defaults when SpecKitConfig.checklistDomains is malformed JSON", async () => {
    configRows.set("p1", { projectId: "p1", checklistDomains: "not-json" });
    const fid = seedFeature("p1", "001-foo");
    seedFeatureArtifact(fid, "spec.md", "x");
    seedFeatureArtifact(fid, "plan.md", "x");
    const r = await runChecklist({ projectId: "p1", featureSlug: "001-foo" });
    expect(r.domains.length).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runTasksToIssues
// ─────────────────────────────────────────────────────────────────────────────
describe("runTasksToIssues", () => {
  function seedReadyFeature(slug = "001-foo"): string {
    const fid = seedFeature("p1", slug);
    seedFeatureArtifact(fid, "spec.md", "x");
    seedFeatureArtifact(fid, "plan.md", "x");
    seedFeatureArtifact(
      fid,
      "tasks.md",
      [
        "| ID | Title | SP | Deps | Notes |",
        "| --- | --- | --- | --- | --- |",
        "| T01 | Build A | 3 |  | files: src/a.ts |",
        "| T02 | Build B | 2 | T01 | files: src/b.ts |",
      ].join("\n"),
    );
    return fid;
  }

  it("returns 404 when feature missing", async () => {
    await expect(
      runTasksToIssues({
        projectId: "p1",
        featureSlug: "099-nope",
        repo: { owner: "o", name: "r" },
      }),
    ).rejects.toMatchObject({ code: "SPECKIT_FEATURE_NOT_FOUND" });
  });

  it("412 when tasksGate unmet", async () => {
    seedFeature("p1", "001-foo");
    await expect(
      runTasksToIssues({
        projectId: "p1",
        featureSlug: "001-foo",
        repo: { owner: "o", name: "r" },
      }),
    ).rejects.toMatchObject({ code: "SPECKIT_GATE_UNMET" });
  });

  it("emits zero on empty tasks.md", async () => {
    const fid = seedFeature("p1", "001-foo");
    seedFeatureArtifact(fid, "spec.md", "x");
    seedFeatureArtifact(fid, "plan.md", "x");
    seedFeatureArtifact(fid, "tasks.md", "# Tasks\n\nno table\n");
    const r = await runTasksToIssues({
      projectId: "p1",
      featureSlug: "001-foo",
      repo: { owner: "o", name: "r" },
    });
    expect(r.count).toBe(0);
    expect(r.message).toMatch(/No tasks/);
  });

  it("creates issues via the supplied client and persists exports", async () => {
    seedReadyFeature();
    const create = vi.fn(async (_o: string, _n: string, req: any) => ({
      number: 42,
      url: `https://x/${req.title}`,
    }));
    const r = await runTasksToIssues({
      projectId: "p1",
      featureSlug: "001-foo",
      repo: { owner: "o", name: "r" },
      client: { create },
      actorId: "u1",
    });
    expect(r.count).toBe(2);
    expect(create).toHaveBeenCalledTimes(2);
    expect(taskExportRows.size).toBe(2);
    expect(auditCalls.some((c) => c.action === "speckit.tasks_exported")).toBe(true);
  });

  it("upserts on second run (does not re-create existing exports)", async () => {
    seedReadyFeature();
    const create = vi.fn(async () => ({ number: 7, url: "https://x" }));
    await runTasksToIssues({
      projectId: "p1",
      featureSlug: "001-foo",
      repo: { owner: "o", name: "r" },
      client: { create },
    });
    create.mockClear();
    const r2 = await runTasksToIssues({
      projectId: "p1",
      featureSlug: "001-foo",
      repo: { owner: "o", name: "r" },
      client: { create },
    });
    // Both already exported — no new create calls.
    expect(create).not.toHaveBeenCalled();
    expect(r2.created.every((c) => c.upserted)).toBe(true);
  });

  it("dryRun does not write exports or call addSubIssue", async () => {
    seedReadyFeature();
    const create = vi.fn(async () => ({ number: 5, url: "https://x" }));
    const addSubIssue = vi.fn(async () => undefined);
    const r = await runTasksToIssues({
      projectId: "p1",
      featureSlug: "001-foo",
      repo: { owner: "o", name: "r" },
      client: { create, addSubIssue },
      dryRun: true,
    });
    expect(r.count).toBe(2);
    expect(taskExportRows.size).toBe(0);
    expect(addSubIssue).not.toHaveBeenCalled();
  });

  it("links sub-issues to parent epic and dependency tasks (best-effort)", async () => {
    seedReadyFeature();
    let n = 100;
    const create = vi.fn(async () => ({ number: ++n, url: "https://x" }));
    const addSubIssue = vi.fn(async () => undefined);
    await runTasksToIssues({
      projectId: "p1",
      featureSlug: "001-foo",
      repo: { owner: "o", name: "r" },
      parentEpicNumber: 9,
      client: { create, addSubIssue },
    });
    // 2 parent links + 1 dep link (T02 depends on T01).
    expect(addSubIssue).toHaveBeenCalled();
  });

  it("resolves repo from SpecKitConfig.tasksToIssuesRepo when not explicit", async () => {
    seedReadyFeature();
    configRows.set("p1", {
      projectId: "p1",
      tasksToIssuesRepo: "owner-cfg/repo-cfg",
      tasksToIssuesParentEpic: 11,
    });
    const create = vi.fn(async () => ({ number: 1, url: "https://x" }));
    const r = await runTasksToIssues({
      projectId: "p1",
      featureSlug: "001-foo",
      client: { create },
    });
    expect(r.repo).toEqual({ owner: "owner-cfg", name: "repo-cfg" });
    expect(r.parentEpicNumber).toBe(11);
  });

  it("resolves repo from RepoConnection when no config set", async () => {
    seedReadyFeature();
    repoConnRows.set("rc1", {
      id: "rc1",
      projectId: "p1",
      ownerOrOrg: "owner-rc",
      repoName: "repo-rc",
      deletedAt: null,
    });
    const create = vi.fn(async () => ({ number: 1, url: "https://x" }));
    const r = await runTasksToIssues({
      projectId: "p1",
      featureSlug: "001-foo",
      client: { create },
    });
    expect(r.repo).toEqual({ owner: "owner-rc", name: "repo-rc" });
  });

  it("resolves repo from SPECKIT_TASKS_DEFAULT_REPO env fallback", async () => {
    seedReadyFeature();
    const prev = process.env.SPECKIT_TASKS_DEFAULT_REPO;
    process.env.SPECKIT_TASKS_DEFAULT_REPO = "env-owner/env-repo";
    try {
      const create = vi.fn(async () => ({ number: 1, url: "https://x" }));
      const r = await runTasksToIssues({
        projectId: "p1",
        featureSlug: "001-foo",
        client: { create },
      });
      expect(r.repo).toEqual({ owner: "env-owner", name: "env-repo" });
    } finally {
      if (prev === undefined) delete process.env.SPECKIT_TASKS_DEFAULT_REPO;
      else process.env.SPECKIT_TASKS_DEFAULT_REPO = prev;
    }
  });

  it("throws SPECKIT_NO_REPO_CONFIGURED when nothing resolves the repo", async () => {
    seedReadyFeature();
    const prev = process.env.SPECKIT_TASKS_DEFAULT_REPO;
    delete process.env.SPECKIT_TASKS_DEFAULT_REPO;
    try {
      await expect(
        runTasksToIssues({
          projectId: "p1",
          featureSlug: "001-foo",
          client: { create: vi.fn() },
        }),
      ).rejects.toMatchObject({ code: "SPECKIT_NO_REPO_CONFIGURED" });
    } finally {
      if (prev !== undefined) process.env.SPECKIT_TASKS_DEFAULT_REPO = prev;
    }
  });
});

// keep `path` import referenced — used by guard helpers in higher-level suites.
void path;
