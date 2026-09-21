/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Epic #396 (MVP-2) — constitution semver/heuristic/preamble tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const artifactRows = new Map<string, any>();
const constitutionRows = new Map<string, any>();
let nextId = 0;

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    auditLog: { create: vi.fn(async () => ({})) },
    specKitArtifact: {
      findMany: vi.fn(async () => []),
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
          projectId: data.projectId,
          name: data.name,
          content: data.content ?? "",
          version: data.version ?? 1,
          updatedById: data.updatedById ?? null,
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
          Object.assign(existing, update);
          return existing;
        }
        const row = {
          id: `c_${nextId++}`,
          ...create,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        constitutionRows.set(where.projectId, row);
        return row;
      }),
    },
  },
}));

vi.mock("../src/lib/audit/audit-service.js", () => ({
  audit: vi.fn(),
}));

import {
  validateConstitution,
  bumpSemver,
  detectBump,
  upsertConstitution,
  loadAsPreamble,
  extractPrinciples,
} from "../src/lib/spec-kit/constitution-meta.js";

beforeEach(() => {
  artifactRows.clear();
  constitutionRows.clear();
  nextId = 0;
});

afterEach(() => vi.clearAllMocks());

const VALID_CONSTITUTION = `
# Project Constitution

Version: 0.1.0
Ratified: 2026-04-30
Last Amended: 2026-04-30

# Core Principles

## Test-driven development
We always write tests first.

## Security by default
Every endpoint requires auth.

# History

- 2026-04-30: Initial.

# Governance

Updates require coordinator approval.
`.trim();

describe("validateConstitution", () => {
  it("accepts a well-formed body", () => {
    expect(validateConstitution(VALID_CONSTITUTION)).toEqual({ ok: true, failures: [] });
  });

  it("flags every missing section", () => {
    const result = validateConstitution("# Foo\n");
    expect(result.ok).toBe(false);
    expect(result.failures.length).toBeGreaterThanOrEqual(5);
  });

  it("flags missing metadata lines", () => {
    const body = `# History\n# Governance\n# Core Principles\n## P\n`;
    const result = validateConstitution(body);
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.includes("Version"))).toBe(true);
    expect(result.failures.some((f) => f.includes("Ratified"))).toBe(true);
    expect(result.failures.some((f) => f.includes("Last Amended"))).toBe(true);
  });
});

describe("bumpSemver", () => {
  it("bumps patch", () => {
    expect(bumpSemver("1.2.3", "patch")).toBe("1.2.4");
  });
  it("bumps minor and resets patch", () => {
    expect(bumpSemver("1.2.3", "minor")).toBe("1.3.0");
  });
  it("bumps major and resets minor+patch", () => {
    expect(bumpSemver("1.2.3", "major")).toBe("2.0.0");
  });
  it("rejects non-semver input", () => {
    expect(() => bumpSemver("notavalidsemver", "patch")).toThrow();
  });
});

describe("detectBump", () => {
  it("returns patch on initial null", () => {
    expect(detectBump(null, VALID_CONSTITUTION)).toBe("patch");
  });
  it("detects added principle as minor", () => {
    const next = VALID_CONSTITUTION.replace(
      "## Security by default\nEvery endpoint requires auth.",
      "## Security by default\nEvery endpoint requires auth.\n\n## New principle\nWords.",
    );
    expect(detectBump(VALID_CONSTITUTION, next)).toBe("minor");
  });
  it("detects removed principle as major", () => {
    const stripped = VALID_CONSTITUTION.replace(/## Security by default[\s\S]*?(?=## |# )/, "");
    expect(detectBump(VALID_CONSTITUTION, stripped)).toBe("major");
  });
  it("returns patch when only wording differs", () => {
    const next = VALID_CONSTITUTION.replace(
      "We always write tests first.",
      "Tests are always first.",
    );
    expect(detectBump(VALID_CONSTITUTION, next)).toBe("patch");
  });
});

describe("upsertConstitution", () => {
  it("rejects invalid content with 400 SPECKIT_CONSTITUTION_INVALID", async () => {
    await expect(
      upsertConstitution({ projectId: "p1", content: "garbage", actorId: "u1" }),
    ).rejects.toMatchObject({ status: 400, code: "SPECKIT_CONSTITUTION_INVALID" });
  });

  it("initial write starts at 0.1.0 and stamps Ratified+LastAmended", async () => {
    const result = await upsertConstitution({
      projectId: "p1",
      content: VALID_CONSTITUTION,
      actorId: "u1",
    });
    expect(result.fromVersion).toBe("0.0.0");
    expect(result.toVersion).toBe("0.1.0");
    expect(result.bump).toBe("minor");
    expect(result.meta.ratifiedAt).toBeTruthy();
    expect(result.meta.lastAmendedAt).toBeTruthy();
  });

  it("subsequent edit bumps semver and preserves Ratified", async () => {
    const first = await upsertConstitution({
      projectId: "p1",
      content: VALID_CONSTITUTION,
      actorId: "u1",
    });
    const ratified = first.meta.ratifiedAt;
    const next = VALID_CONSTITUTION.replace(
      "## Security by default\nEvery endpoint requires auth.",
      "## Security by default\nEvery endpoint requires auth.\n\n## Bias for action\nDo it.",
    );
    const second = await upsertConstitution({ projectId: "p1", content: next, actorId: "u1" });
    expect(second.fromVersion).toBe("0.1.0");
    expect(second.toVersion).toBe("0.2.0");
    expect(second.meta.ratifiedAt).toBe(ratified);
  });
});

describe("loadAsPreamble", () => {
  it("returns null when no constitution exists", async () => {
    expect(await loadAsPreamble("p1")).toBeNull();
  });

  it("returns header + body when constitution exists", async () => {
    await upsertConstitution({ projectId: "p1", content: VALID_CONSTITUTION, actorId: "u1" });
    const preamble = await loadAsPreamble("p1");
    expect(preamble).toContain("speckit.constitution v0.1.0");
    expect(preamble).toContain("Test-driven development");
  });
});

describe("extractPrinciples", () => {
  it("extracts H2/H3 entries under the principles block", () => {
    const principles = extractPrinciples(VALID_CONSTITUTION);
    expect(principles).toContain("test-driven development");
    expect(principles).toContain("security by default");
  });

  it("ignores headings outside the principles block", () => {
    const body = `${VALID_CONSTITUTION}\n\n# Other\n\n## Not a principle\n`;
    expect(extractPrinciples(body)).toEqual(["test-driven development", "security by default"]);
  });

  it("returns [] when there is no principles section", () => {
    expect(extractPrinciples("# Foo\n## Bar\n")).toEqual([]);
  });
});
