/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Tests for the Spec Kit `constitution.md` generator (#209).
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rows = new Map<string, any>();
let nextId = 0;

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    auditLog: { create: vi.fn(async () => ({})) },
    specKitArtifact: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.projectId_name) {
          for (const r of rows.values()) {
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
        rows.set(row.id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const r = rows.get(where.id);
        Object.assign(r, data, { updatedAt: new Date() });
        return r;
      }),
    },
  },
}));

vi.mock("../src/lib/audit/audit-service.js", () => ({
  audit: vi.fn(),
  getAuditService: vi.fn(() => ({ record: vi.fn() })),
}));

import {
  __TESTING__,
  buildConstitution,
  defaultReader,
  generateConstitution,
  projectHasConstitution,
  readProjectConstitution,
} from "../src/lib/spec-kit/constitution.js";

beforeEach(() => {
  rows.clear();
  nextId = 0;
});
afterEach(() => vi.clearAllMocks());

describe("buildConstitution", () => {
  it("renders header + auto markers + empty overrides block when no inputs", () => {
    const out = buildConstitution([]);
    expect(out).toContain(__TESTING__.AUTO_BEGIN);
    expect(out).toContain(__TESTING__.AUTO_END);
    expect(out).toContain(__TESTING__.OVERRIDES_BEGIN);
    expect(out).toContain(__TESTING__.OVERRIDES_END);
    expect(out).toContain("# Project Constitution");
  });

  it("inlines each instruction file under its source heading", () => {
    const out = buildConstitution([
      { filename: "go.instructions.md", content: "Use idiomatic Go." },
      { filename: "python.instructions.md", content: "Use type hints." },
    ]);
    expect(out).toContain("## From `.github/instructions/go.instructions.md`");
    expect(out).toContain("Use idiomatic Go.");
    expect(out).toContain("Use type hints.");
  });

  it("emits the project overrides section when provided", () => {
    const out = buildConstitution([], "  Always log errors with structured fields.  ");
    expect(out).toContain("## Project-level overrides");
    expect(out).toContain("Always log errors with structured fields.");
  });

  it("omits the overrides body when the override string is whitespace", () => {
    const out = buildConstitution([], "   \n\t  ");
    expect(out).not.toContain("## Project-level overrides");
  });
});

describe("defaultReader", () => {
  it("returns [] when the dir is missing", async () => {
    const r = await defaultReader("/definitely/not/a/dir/here");
    expect(r).toEqual([]);
  });

  it("reads and alphabetises *.md files", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "metis-spec-kit-"));
    try {
      await fs.writeFile(path.join(tmp, "z.md"), "Z body");
      await fs.writeFile(path.join(tmp, "a.md"), "A body");
      await fs.writeFile(path.join(tmp, "ignored.txt"), "no");
      const files = await defaultReader(tmp);
      expect(files.map((f) => f.filename)).toEqual(["a.md", "z.md"]);
      expect(files[0]?.content).toBe("A body");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("generateConstitution + readProjectConstitution", () => {
  it("writes and round-trips the artifact", async () => {
    const reader = vi.fn(async () => [{ filename: "core.md", content: "Be safe." }]);
    const text = await generateConstitution({
      projectId: "p1",
      reader,
      projectOverrides: "Be fast.",
      actorId: "u1",
    });
    expect(text).toContain("Be safe.");
    expect(text).toContain("Be fast.");
    expect(reader).toHaveBeenCalled();

    const persisted = await readProjectConstitution("p1");
    expect(persisted).toBe(text);
    expect(await projectHasConstitution("p1")).toBe(true);
  });

  it("returns null + false when no constitution exists yet", async () => {
    expect(await readProjectConstitution("missing")).toBeNull();
    expect(await projectHasConstitution("missing")).toBe(false);
  });
});
