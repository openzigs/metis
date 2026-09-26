/**
 * Epic #129 (#146) — the skill catalog and `load_skill`. The catalog in a
 * prompt is a SNAPSHOT: `load_skill` re-checks, at call time, that the skill is
 * still enabled and still allowed for the caller's project.
 */
import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { loadSkillTool, renderSkillCatalog, resolveSkillCatalog } from "./skills.js";

interface Row {
  id: string;
  key: string;
  name: string;
  description: string;
  version: string;
  instructions: string;
  enabled: boolean;
  archivedAt: Date | null;
  deletedAt: Date | null;
}

function fakeDb(
  rows: Row[],
  files: Array<{ skillId: string; path: string; content: string }> = [],
) {
  const match = (r: Row, where: Record<string, unknown>) => {
    const or = where.OR as Array<{ id?: { in: string[] }; key?: { in: string[] } }> | undefined;
    if (
      or &&
      !or.some((c) => (c.id && c.id.in.includes(r.id)) || (c.key && c.key.in.includes(r.key)))
    ) {
      return false;
    }
    if (where.enabled === true && !r.enabled) return false;
    if (where.archivedAt === null && r.archivedAt) return false;
    if (where.deletedAt === null && r.deletedAt) return false;
    return true;
  };
  return {
    skill: {
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        rows.filter((r) => match(r, where)),
      findUnique: async ({ where }: { where: { id: string } }) =>
        rows.find((r) => r.id === where.id) ?? null,
    },
    skillFile: {
      findUnique: async ({
        where,
      }: {
        where: { skillId_path: { skillId: string; path: string } };
      }) =>
        files.find(
          (f) => f.skillId === where.skillId_path.skillId && f.path === where.skillId_path.path,
        ) ?? null,
      findMany: async ({ where }: { where: { skillId: string } }) =>
        files.filter((f) => f.skillId === where.skillId).map((f) => ({ path: f.path })),
    },
  } as unknown as PrismaClient;
}

const row = (id: string, over: Partial<Row> = {}): Row => ({
  id,
  key: `key-${id}`,
  name: `Name ${id}`,
  description: `Desc ${id}`,
  version: "1.0.0",
  instructions: `BODY-${id}`,
  enabled: true,
  archivedAt: null,
  deletedAt: null,
  ...over,
});

const allowAll = { resolveAllowedSkillIds: async () => new Set(["a", "b", "c"]) };

describe("resolveSkillCatalog", () => {
  it("keeps input order, drops duplicates, disabled/archived skills and those the project does not allow", async () => {
    const db = fakeDb([
      row("a"),
      row("b", { enabled: false }),
      row("c"),
      row("d", { archivedAt: new Date() }),
    ]);
    const out = await resolveSkillCatalog({
      skillIds: ["c", "a", "b", "d", "a"],
      projectId: "p1",
      db,
      allowlist: { resolveAllowedSkillIds: async () => new Set(["a", "b", "d"]) },
    });
    expect(out.map((e) => e.id)).toEqual(["a"]);
  });

  it("with no project, only enablement filters", async () => {
    const db = fakeDb([row("a"), row("c")]);
    const out = await resolveSkillCatalog({ skillKeys: ["key-c", "key-a"], projectId: null, db });
    expect(out.map((e) => e.key)).toEqual(["key-c", "key-a"]);
  });

  it("no skills asked for: no query at all", async () => {
    expect(await resolveSkillCatalog({ projectId: "p", db: {} as PrismaClient })).toEqual([]);
  });
});

describe("renderSkillCatalog", () => {
  it("lists names and one-line descriptions — never bodies — and is empty for no skills", () => {
    const out = renderSkillCatalog([
      { id: "a", key: "k", name: "N", description: "line one\n\n  line two", version: "1" },
    ]);
    expect(out).toContain("- k: N — line one line two");
    expect(out).toContain("load_skill");
    expect(renderSkillCatalog([])).toBe("");
  });
});

describe("load_skill", () => {
  const catalog = [{ id: "a", key: "key-a", name: "Name a", description: "", version: "1.0.0" }];
  const ctx = { sessionId: "s", userId: "u", projectId: "p1" };

  it("returns the body and lists supporting files", async () => {
    const tool = loadSkillTool({
      catalog,
      db: fakeDb([row("a")], [{ skillId: "a", path: "references/R.md", content: "R" }]),
      allowlist: allowAll,
    });
    const r = await tool.execute({ name: "key-a" }, ctx);
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain("BODY-a");
    expect(r.text).toContain("- references/R.md");
  });

  it("serves a supporting file by exact path only", async () => {
    const tool = loadSkillTool({
      catalog,
      db: fakeDb([row("a")], [{ skillId: "a", path: "references/R.md", content: "FILE-R" }]),
      allowlist: allowAll,
    });
    expect((await tool.execute({ name: "key-a", file: "references/R.md" }, ctx)).text).toContain(
      "FILE-R",
    );
    expect((await tool.execute({ name: "key-a", file: "references/../R.md" }, ctx)).isError).toBe(
      true,
    );
    expect(
      (await tool.execute({ name: "key-a", file: "references/missing.md" }, ctx)).isError,
    ).toBe(true);
  });

  it("refuses a skill that is not in the caller's catalog", async () => {
    const tool = loadSkillTool({ catalog, db: fakeDb([row("a"), row("b")]), allowlist: allowAll });
    const r = await tool.execute({ name: "key-b" }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).not.toContain("BODY-b");
  });

  it("re-checks at CALL time: a skill disabled since the catalog was built is refused", async () => {
    const rows = [row("a")];
    const tool = loadSkillTool({ catalog, db: fakeDb(rows), allowlist: allowAll });
    rows[0]!.enabled = false;
    const r = await tool.execute({ name: "key-a" }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).not.toContain("BODY-a");
  });

  it("re-checks at CALL time: a skill the project has since disallowed is refused", async () => {
    const allowed = new Set(["a"]);
    const tool = loadSkillTool({
      catalog,
      db: fakeDb([row("a")]),
      allowlist: { resolveAllowedSkillIds: async () => allowed },
    });
    allowed.delete("a");
    const r = await tool.execute({ name: "key-a" }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("not enabled for this project");
  });

  it("validates arguments before anything runs", () => {
    const tool = loadSkillTool({ catalog, db: fakeDb([]) });
    expect(tool.validate({ name: "key-a" }).ok).toBe(true);
    expect(tool.validate({ name: "" }).ok).toBe(false);
    expect(tool.validate({ name: "key-a", extra: 1 }).ok).toBe(false);
    expect(tool.validate({ name: "key-a", file: 3 }).ok).toBe(false);
    expect(tool.validate(["key-a"]).ok).toBe(false);
    expect(tool.risk).toBe("low");
  });
});
