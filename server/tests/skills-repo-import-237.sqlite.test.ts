/**
 * #237 — importing an Agent Skills directory from a repository connector
 * brings its supporting files, not just SKILL.md, bounded exactly like the
 * filesystem loader: depth, 64 KB per file, 32 files / 512 KB per skill, text
 * only. What the loader refuses is REPORTED, never dropped, and a path that
 * tries to leave the import root is never fetched at all.
 *
 * The fetcher is a fake (no network); the import writes through the real
 * `SkillService` into a real SQLite database, and every assertion about what
 * was stored reads it back through `load_skill` — the path the model uses.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/prisma.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return {
    get prisma() {
      return state.db;
    },
    Prisma,
  };
});
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

const { RepoLoader, LibraryImporter, REPO_MAX_LISTINGS, REPO_SKILLS_MAX_DEPTH } =
  await import("../src/lib/library/import.js");
const { SkillService } = await import("../src/lib/library/skill-service.js");
const { loadSkillTool, resolveSkillCatalog } = await import("../src/lib/agent-runtime/skills.js");
const { MAX_SKILL_FILE_BYTES, MAX_SKILL_FILES, groupSkillImport, triageSkillFiles } =
  await import("../src/lib/agent-runtime/skill-bundle.js");

type Entry = { path: string; type: string; size?: number };

const skillMd = (name: string) =>
  `---\nname: ${name}\ndescription: The ${name} skill.\nversion: 1.0.0\n---\n\nRead references/guide.md first.\n`;

/**
 * A fake connector over an in-memory tree. `list(dir)` returns that directory's
 * direct children (as the GitHub contents API does); `extra` lets a test add
 * hostile entries to any listing. Every read is recorded.
 */
function fakeRepo(
  tree: Record<string, string>,
  opts: {
    extra?: Record<string, Entry[]>;
    sizes?: Record<string, number>;
    types?: Record<string, string>;
  } = {},
) {
  const reads: string[] = [];
  const lists: string[] = [];
  const fetcher = {
    list: vi.fn(async (dir: string) => {
      lists.push(dir);
      const prefix = dir === "" ? "" : `${dir}/`;
      const children = new Map<string, Entry>();
      for (const p of Object.keys(tree)) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        const [head, ...tail] = rest.split("/");
        const child = `${prefix}${head}`;
        if (tail.length > 0) children.set(child, { path: child, type: "dir" });
        else
          children.set(child, {
            path: child,
            type: opts.types?.[child] ?? "file",
            ...(opts.sizes?.[child] !== undefined ? { size: opts.sizes[child] } : {}),
          });
      }
      return [...children.values(), ...(opts.extra?.[dir] ?? [])];
    }),
    read: vi.fn(async (p: string) => {
      reads.push(p);
      if (!(p in tree)) throw new Error(`no such file: ${p}`);
      return tree[p]!;
    }),
  };
  return { fetcher, reads, lists };
}

describe("#237 RepoLoader (skills) — walks the tree, bounded, and reports what it refuses", () => {
  it("reads each SKILL.md with every supporting file beneath its directory", async () => {
    const { fetcher, reads } = fakeRepo({
      ".github/skills/pdf/SKILL.md": skillMd("pdf"),
      ".github/skills/pdf/references/guide.md": "GUIDE",
      ".github/skills/pdf/scripts/fill.py": "print('x')",
      ".github/skills/pdf/assets/deep/er/still/ok.txt": "DEEP",
      ".github/skills/notes.skill.md": skillMd("notes"),
      ".github/README.md": "outside the root: never listed",
    });
    const loader = new RepoLoader(fetcher, ".github/skills", "abc123", "skills");
    const files = await loader.load();
    expect(files.map((f) => f.path).sort()).toEqual([
      ".github/skills/notes.skill.md",
      ".github/skills/pdf/SKILL.md",
      ".github/skills/pdf/assets/deep/er/still/ok.txt",
      ".github/skills/pdf/references/guide.md",
      ".github/skills/pdf/scripts/fill.py",
    ]);
    expect(reads).not.toContain(".github/README.md");
    expect(loader.rejectedPaths()).toEqual([]);
  });

  it("never fetches a path that tries to leave the import root, and reports it", async () => {
    const hostile: Entry[] = [
      { path: ".github/skills/pdf/../../../etc/passwd", type: "file" },
      { path: "/etc/passwd", type: "file" },
      { path: "../outside/SKILL.md", type: "file" },
      { path: "other/SKILL.md", type: "file" },
      { path: ".github/skills/pdf/references\\..\\..\\x.md", type: "file" },
      { path: ".github/skills/pdf/./SKILL.md", type: "file" },
      { path: ".github/skills//pdf/x.md", type: "file" },
      { path: "C:/Windows/win.ini", type: "file" },
      { path: ".github/skills-evil/SKILL.md", type: "file" },
      { path: ".github/skills/pdf/../..", type: "dir" },
    ];
    const { fetcher, reads, lists } = fakeRepo(
      {
        ".github/skills/pdf/SKILL.md": skillMd("pdf"),
        ".github/skills/pdf/references/guide.md": "GUIDE",
      },
      { extra: { ".github/skills/pdf": hostile } },
    );
    const loader = new RepoLoader(fetcher, ".github/skills", "abc123", "skills");
    const files = await loader.load();
    expect(files.map((f) => f.path).sort()).toEqual([
      ".github/skills/pdf/SKILL.md",
      ".github/skills/pdf/references/guide.md",
    ]);
    expect(reads.sort()).toEqual([
      ".github/skills/pdf/SKILL.md",
      ".github/skills/pdf/references/guide.md",
    ]);
    expect(lists.every((d) => d === ".github/skills" || d.startsWith(".github/skills/"))).toBe(
      true,
    );
    expect(loader.rejectedPaths().map((r) => r.path)).toEqual(hostile.map((h) => h.path));
    for (const r of loader.rejectedPaths()) {
      expect(r.reason).toBe("outside the import root or not a clean relative path");
    }
  });

  it("refuses a root that is not a clean relative path", async () => {
    const { fetcher } = fakeRepo({});
    await expect(new RepoLoader(fetcher, "../etc", "x", "skills").load()).rejects.toThrow(
      /INVALID_ROOT/,
    );
    await expect(new RepoLoader(fetcher, "/etc", "x", "skills").load()).rejects.toThrow(
      /INVALID_ROOT/,
    );
    // A Windows drive-letter root and a NUL byte are refused too, not walked.
    for (const root of ["C:/skills", "c:skills", "skills\0x"]) {
      await expect(new RepoLoader(fetcher, root, "x", "skills").load()).rejects.toThrow(
        /INVALID_ROOT/,
      );
    }
    expect(fetcher.list).not.toHaveBeenCalled();
  });

  // With an EMPTY root `within()` admits every path, so the drive-letter and
  // NUL checks in `cleanRepoPath` are the only thing standing between a
  // hostile listing and a fetch.
  for (const root of ["", "/", "./"]) {
    it(`with the repository root (${JSON.stringify(root)}) a drive-letter or NUL path is refused, never fetched`, async () => {
      const hostile: Entry[] = [
        { path: "C:/skills/evil/SKILL.md", type: "file" },
        { path: "d:evil/SKILL.md", type: "file" },
        { path: "C:", type: "dir" },
        { path: "skills/a\0b/SKILL.md", type: "file" },
        { path: "skills/ok/\0.md", type: "file" },
      ];
      const { fetcher, reads, lists } = fakeRepo(
        { "skills/ok/SKILL.md": skillMd("ok") },
        { extra: { "": hostile } },
      );
      const loader = new RepoLoader(fetcher, root, "abc123", "skills");
      const files = await loader.load();
      expect(files.map((f) => f.path)).toEqual(["skills/ok/SKILL.md"]);
      expect(reads).toEqual(["skills/ok/SKILL.md"]);
      expect(lists).not.toContain("C:");
      expect(loader.rejectedPaths().map((r) => r.path)).toEqual(hostile.map((h) => h.path));
    });
  }

  it("reads only files beneath a SKILL.md directory: an unrelated file inside the import root is never fetched", async () => {
    const { fetcher, reads } = fakeRepo({
      "skills/pdf/SKILL.md": skillMd("pdf"),
      "skills/pdf/references/guide.md": "GUIDE",
      "skills/unrelated/notes.md": "NOT A SKILL FILE",
      "skills/README.md": "NOT A SKILL FILE EITHER",
    });
    const loader = new RepoLoader(fetcher, "skills", "abc123", "skills");
    const files = await loader.load();
    expect(files.map((f) => f.path).sort()).toEqual([
      "skills/pdf/SKILL.md",
      "skills/pdf/references/guide.md",
    ]);
    expect(reads).not.toContain("skills/unrelated/notes.md");
    expect(reads).not.toContain("skills/README.md");
  });

  it("never fetches a binary type, an oversize file (by reported size) or a symlink/submodule", async () => {
    const big = "y".repeat(MAX_SKILL_FILE_BYTES + 1);
    const { fetcher, reads } = fakeRepo(
      {
        "skills/pdf/SKILL.md": skillMd("pdf"),
        "skills/pdf/assets/logo.png": "PNG",
        "skills/pdf/references/huge.md": big,
        "skills/pdf/references/link.md": "LINK",
        "skills/pdf/vendor": "SUBMODULE",
      },
      {
        sizes: { "skills/pdf/references/huge.md": big.length },
        types: { "skills/pdf/references/link.md": "symlink", "skills/pdf/vendor": "submodule" },
      },
    );
    const files = await new RepoLoader(fetcher, "skills", "r", "skills").load();
    expect(reads).toEqual(["skills/pdf/SKILL.md"]);
    expect(files.map((f) => f.path).sort()).toEqual([
      "skills/pdf/SKILL.md",
      "skills/pdf/assets/logo.png",
      "skills/pdf/references/huge.md",
    ]);
  });

  it("reads at most MAX_SKILL_FILES supporting files per skill", async () => {
    const tree: Record<string, string> = { "skills/big/SKILL.md": skillMd("big") };
    for (let i = 0; i < MAX_SKILL_FILES + 5; i++) {
      tree[`skills/big/references/f${String(i).padStart(2, "0")}.md`] = `file ${i}`;
    }
    const { fetcher, reads } = fakeRepo(tree);
    const files = await new RepoLoader(fetcher, "skills", "r", "skills").load();
    expect(reads).toHaveLength(1 + MAX_SKILL_FILES);
    expect(files).toHaveLength(1 + MAX_SKILL_FILES + 5);
    // The unread ones are REPORTED by the import's triage, with why.
    const [entry] = groupSkillImport(files);
    const { accepted, skipped } = triageSkillFiles(entry!.files);
    expect(accepted).toHaveLength(MAX_SKILL_FILES);
    expect(skipped).toEqual(
      ["f32", "f33", "f34", "f35", "f36"].map((f) => ({
        path: `references/${f}.md`,
        reason: `not read: past the ${MAX_SKILL_FILES}-file limit`,
      })),
    );
  });

  it("stops walking at REPO_SKILLS_MAX_DEPTH levels and REPO_MAX_LISTINGS directories", async () => {
    // A tree deeper than the limit: nothing below it is listed.
    const deep = `skills/${Array.from({ length: REPO_SKILLS_MAX_DEPTH + 3 }, (_, i) => `d${i}`).join("/")}/SKILL.md`;
    const d = fakeRepo({ [deep]: skillMd("deep") });
    await new RepoLoader(d.fetcher, "skills", "r", "skills").load();
    expect(Math.max(...d.lists.map((l) => l.split("/").length - 1))).toBe(REPO_SKILLS_MAX_DEPTH);

    // A hostile connector that invents a new sub-directory in every listing.
    let n = 0;
    const endless = {
      list: vi.fn(async (dir: string) =>
        Array.from({ length: 4 }, () => ({ path: `${dir}/x${n++}`, type: "dir" })),
      ),
      read: vi.fn(async () => ""),
    };
    const loader = new RepoLoader(endless, "skills", "r", "skills");
    await loader.load();
    expect(endless.list).toHaveBeenCalledTimes(REPO_MAX_LISTINGS);
    expect(loader.rejectedPaths().length).toBeGreaterThan(0);
    expect(loader.rejectedPaths()[0]!.reason).toMatch(/directory limit/);
  });

  it("agents still read the root only (no walk)", async () => {
    const { fetcher, lists } = fakeRepo({
      "agents/A.agent.md": "---\nname: a\n---\nbody",
      "agents/nested/B.agent.md": "---\nname: b\n---\nbody",
    });
    const files = await new RepoLoader(fetcher, "agents", "r", "agents").load();
    expect(files.map((f) => f.path)).toEqual(["agents/A.agent.md"]);
    expect(lists).toEqual(["agents"]);
  });
});

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#237 repository import → real SQLite → load_skill serves the supporting files",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("237-repo-skills");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: "u-admin", username: "admin", displayName: "admin", email: "a@example.test" },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("imports the skill with its files, reports every file it left out, and progressive loading is unchanged", async () => {
      const big = "z".repeat(MAX_SKILL_FILE_BYTES + 10);
      const { fetcher } = fakeRepo(
        {
          "skills/pdf/SKILL.md": skillMd("pdf"),
          "skills/pdf/references/guide.md": "GUIDE-MARKER",
          "skills/pdf/scripts/fill.py": "print('FILL-MARKER')",
          "skills/pdf/assets/logo.png": "PNG",
          "skills/pdf/references/huge.md": big, // no reported size: fetched, then refused
          "skills/pdf/.DS_Store": "junk",
          "skills/pdf/a/b/c/d/too-deep.md": "DEEP",
        },
        { extra: { "skills/pdf": [{ path: "skills/pdf/../../secret.md", type: "file" }] } },
      );
      const importer = new LibraryImporter({ skillService: new SkillService(db) });
      const result = await importer.importSkills(
        new RepoLoader(fetcher, "skills", "abc123", "skills"),
        { id: "u-admin", role: "admin" },
      );
      expect(result.failed).toEqual([]);
      expect(result.imported.map((s) => s.key)).toEqual(["pdf"]);
      expect(result.skipped).toEqual([
        {
          path: "skills/pdf/../../secret.md",
          reason: "outside the import root or not a clean relative path",
        },
      ]);
      const leftOut = Object.fromEntries(
        (result.skippedFiles ?? []).map((f) => [f.path, f.reason]),
      );
      expect(leftOut).toEqual({
        "assets/logo.png": "not a text file",
        "references/huge.md": `larger than ${MAX_SKILL_FILE_BYTES} bytes`,
        ".DS_Store": "operating-system metadata file",
        "a/b/c/d/too-deep.md": expect.stringMatching(/^invalid path/),
      });

      // Read back through the path the model uses.
      const catalog = await resolveSkillCatalog({ skillKeys: ["pdf"], db });
      expect(catalog.map((c) => c.key)).toEqual(["pdf"]);
      const tool = loadSkillTool({ catalog, db });
      const ctx = { sessionId: "s", userId: "u", projectId: null } as never;
      const body = await tool.execute({ name: "pdf" }, ctx);
      expect(body.text).toContain("Read references/guide.md first.");
      expect(body.text).toContain("- references/guide.md");
      expect(body.text).toContain("- scripts/fill.py");
      // Progressive: a file's content is served only when asked for by path.
      expect(body.text).not.toContain("GUIDE-MARKER");
      const guide = await tool.execute({ name: "pdf", file: "references/guide.md" }, ctx);
      expect(guide.text).toContain("GUIDE-MARKER");
      const script = await tool.execute({ name: "pdf", file: "scripts/fill.py" }, ctx);
      expect(script.text).toContain("FILL-MARKER");
      const stored = await db.skillFile.findMany({
        select: { path: true },
        orderBy: { path: "asc" },
      });
      expect(stored.map((f) => f.path)).toEqual(["references/guide.md", "scripts/fill.py"]);
    });
  },
);
