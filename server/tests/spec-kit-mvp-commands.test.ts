/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Epic #396 (MVP-2/3/4/6) — pure helpers + runConstitution.
 * Runner-dependent commands are exercised via route-layer tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const artifactRows = new Map<string, any>();
const constitutionRows = new Map<string, any>();
let nextId = 0;

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    auditLog: { create: vi.fn(async () => ({})) },
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
      create: vi.fn(async ({ data }: any) => {
        nextId++;
        const row = {
          id: `ska_${nextId}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          version: 1,
          updatedById: null,
          ...data,
        };
        artifactRows.set(row.id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const r = artifactRows.get(where.id);
        Object.assign(r, data, { updatedAt: new Date() });
        return r;
      }),
    },
    specKitConstitution: {
      findUnique: vi.fn(async ({ where }: any) => constitutionRows.get(where.projectId) ?? null),
      upsert: vi.fn(async ({ where, update, create }: any) => {
        const existing = constitutionRows.get(where.projectId);
        if (existing) {
          Object.assign(existing, update, { updatedAt: new Date() });
          return existing;
        }
        const row = {
          id: `c_${++nextId}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...create,
        };
        constitutionRows.set(where.projectId, row);
        return row;
      }),
    },
  },
}));

vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

import { runConstitution } from "../src/lib/spec-kit/commands/constitution.js";
import {
  generateChecklist,
  mergeChecklists,
  DEFAULT_CHECKLIST_DOMAINS,
} from "../src/lib/spec-kit/commands/checklist.js";
import { ensureValidOpenAPI } from "../src/lib/spec-kit/commands/plan-expanded.js";
import { renderIssueBody, noopIssueClient } from "../src/lib/spec-kit/commands/taskstoissues.js";
import { SpecKitArtifactError } from "../src/lib/spec-kit/artifacts.js";

const VALID_CONSTITUTION = `
# Project Constitution

Version: 0.1.0
Ratified: 2026-04-30
Last Amended: 2026-04-30

# Core Principles

## TDD
Tests first.

# History

- 2026-04-30: Initial.

# Governance

Coordinator approves.
`.trim();

beforeEach(() => {
  artifactRows.clear();
  constitutionRows.clear();
  nextId = 0;
});

afterEach(() => vi.clearAllMocks());

describe("runConstitution", () => {
  it("rejects empty input", async () => {
    await expect(runConstitution({ projectId: "p1", content: "  " })).rejects.toBeInstanceOf(
      SpecKitArtifactError,
    );
  });

  it("writes the constitution and returns metadata", async () => {
    const r = await runConstitution({
      projectId: "p1",
      content: VALID_CONSTITUTION,
      actorId: "u1",
    });
    expect(r.toVersion).toBe("0.1.0");
    expect(r.bump).toBe("minor");
    expect(r.message).toContain("0.0.0");
    expect(r.message).toContain("0.1.0");
  });

  it("accepts no actorId and writes successfully", async () => {
    const r = await runConstitution({
      projectId: "p1",
      content: VALID_CONSTITUTION,
    });
    expect(r.toVersion).toBe("0.1.0");
  });
});

describe("checklist helpers", () => {
  it("generateChecklist emits per-domain markdown", () => {
    const md = generateChecklist("security", "001-foo");
    expect(md).toContain("# Security Checklist — 001-foo");
    expect(md).toContain("- [ ]");
    expect(md).toContain("rationale:");
    expect(md).toContain("owner:");
  });

  it("generateChecklist falls back to a stub for unknown domains", () => {
    const md = generateChecklist("voodoo", "001-foo");
    expect(md).toContain("voodoo");
    expect(md).toContain("Domain not in default template");
  });

  it("mergeChecklists preserves [x] state by exact text match", () => {
    const existing = `- [x] Authentication enforced on every mutating endpoint — rationale: foo — owner: engineer\n`;
    const generated = generateChecklist("security", "001-foo");
    const merged = mergeChecklists(existing, generated);
    expect(merged).toContain("- [x] Authentication enforced on every mutating endpoint");
    expect(merged).toContain("- [ ] Input validation on all user-supplied data");
  });

  it("mergeChecklists leaves new items unchecked when no prior state", () => {
    const merged = mergeChecklists("", generateChecklist("performance", "001-x"));
    expect(merged).not.toContain("- [x]");
  });

  it("DEFAULT_CHECKLIST_DOMAINS contains all five expected domains", () => {
    expect(DEFAULT_CHECKLIST_DOMAINS).toEqual([
      "security",
      "performance",
      "accessibility",
      "observability",
      "testability",
    ]);
  });
});

describe("ensureValidOpenAPI", () => {
  it("preserves a valid spec", () => {
    const spec = `openapi: 3.1.0\ninfo:\n  title: x\n  version: 1.0.0\npaths: {}\n`;
    const out = ensureValidOpenAPI(spec, "001-x");
    expect(out).toContain("openapi: 3.1.0");
  });

  it("strips ```yaml fences", () => {
    const fenced = "```yaml\nopenapi: 3.1.0\ninfo:\n  title: x\n  version: 1.0.0\npaths: {}\n```\n";
    const out = ensureValidOpenAPI(fenced, "001-x");
    expect(out).not.toContain("```");
    expect(out).toContain("openapi:");
  });

  it("returns a /health stub when input is invalid YAML", () => {
    const out = ensureValidOpenAPI("::: not yaml :::", "001-x");
    expect(out).toContain("openapi:");
    expect(out).toContain("/health");
  });

  it("returns a stub when openapi key is missing", () => {
    const out = ensureValidOpenAPI("foo: bar\n", "001-foo");
    expect(out).toContain("openapi:");
    expect(out).toContain("001-foo");
  });
});

describe("renderIssueBody", () => {
  it("includes traceability footer + Parallelizable + Files", () => {
    const body = renderIssueBody(
      {
        id: "T01",
        title: "Do work",
        parallelizable: true,
        dependsOn: ["T00"],
        files: ["src/x.ts"],
        userStorySlug: null,
        storyPoints: 3,
        notes: "",
      },
      "001-foo",
    );
    expect(body).toContain("Source: specs/001-foo/tasks.md#T01");
    expect(body).toContain("Parallelizable: yes");
    expect(body).toContain("Depends on: T00");
    expect(body).toContain("Story Points: 3");
    expect(body).toContain("## Files");
    expect(body).toContain("src/x.ts");
  });

  it("omits optional sections when not present", () => {
    const body = renderIssueBody(
      {
        id: "T05",
        title: "Bare task",
        parallelizable: false,
        dependsOn: [],
        files: [],
        userStorySlug: null,
        storyPoints: null,
        notes: "",
      },
      "001-foo",
    );
    expect(body).toContain("Parallelizable: no");
    expect(body).not.toContain("Depends on:");
    expect(body).not.toContain("Story Points:");
    expect(body).not.toContain("## Files");
  });

  it("renders user-story tag + notes when present", () => {
    const body = renderIssueBody(
      {
        id: "T07",
        title: "Story task",
        parallelizable: false,
        dependsOn: [],
        files: [],
        userStorySlug: "us42",
        storyPoints: null,
        notes: "important",
      },
      "001-foo",
    );
    expect(body).toContain("User Story: us42");
    expect(body).toContain("## Notes");
    expect(body).toContain("important");
  });
});

describe("noopIssueClient", () => {
  it("returns synthetic issue 0 with dryrun:// URL", async () => {
    const out = await noopIssueClient.create("o", "r", { title: "x", body: "y", labels: [] });
    expect(out.number).toBe(0);
    expect(out.url).toContain("dryrun://");
  });
});
