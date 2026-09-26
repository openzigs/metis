/**
 * Epic #129 — authoring the one agent definition and importing Agent Skills,
 * against a REAL SQLite database (every assertion reads back through the
 * production services, never the object the test built).
 *
 *   #145 — custom agents carry skills, an approval override and a version;
 *          library agents take `reasoningEffort` / `approvalPolicy` in their
 *          frontmatter and may name the agent tools in `tools:`; import/export
 *          carries the new fields (v2) and still reads v1; credentials are
 *          refused in either kind.
 *   #146 — an Agent Skills directory (SKILL.md + supporting files, with the
 *          open format's `license` / `metadata` / `allowed-tools`) imports as ONE
 *          skill whose files `load_skill` can serve; malformed frontmatter and
 *          unsafe supporting files are rejected with a clear reason.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import { createMigratedSqlite, type MigratedSqlite } from "./helpers/sqlite-migrated-db.js";
import type { ToolDefinition } from "../src/lib/ai/types.js";

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

const custom = await import("../src/lib/custom-agents/index.js");
const { exportAgent, parseAgentImport, AgentImportError } =
  await import("../src/lib/custom-agents/portability.js");
const { AgentService } = await import("../src/lib/library/agent-service.js");
const { SkillService } = await import("../src/lib/library/skill-service.js");
const { LibraryImporter, InlineLoader, FilesystemLoader } =
  await import("../src/lib/library/import.js");
const { loadAgentDefinition } = await import("../src/lib/agent-runtime/definition.js");
const { loadSkillTool, resolveSkillCatalog } = await import("../src/lib/agent-runtime/skills.js");
const { SessionRuntime } = await import("../src/lib/library/session-runtime.js");
const { getToolRegistry, __resetToolRegistrySingleton } =
  await import("../src/lib/ai/tool-registry.js");

const GH_TOKEN = ["ghp_", "Z".repeat(36)].join("");

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "Epic #129 — agent definitions and Agent Skills import (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    const actor = { id: "u1" };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("129-defs");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: "u1", username: "u1", displayName: "u1", email: "u1@x.test" },
      });
      await db.project.create({ data: { id: "p1", name: "P", slug: "p1", createdById: "u1" } });
      await db.skill.create({
        data: { id: "s1", key: "style-guide", name: "Style", instructions: "b" },
      });
      await db.skill.create({
        data: { id: "s2", key: "off-skill", name: "Off", instructions: "b", enabled: false },
      });
      __resetToolRegistrySingleton();
      getToolRegistry().register({
        name: "count_rows",
        description: "c",
        schema: z.object({}),
        risk: "low",
        exec: async () => ({ text: "" }),
      } as ToolDefinition);
    });

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    // ── #145 custom agents ───────────────────────────────────────────────
    describe("custom agents carry the whole definition", () => {
      it("skills + approval override + version, read back through the one loader", async () => {
        const created = await custom.createAgent(
          {
            projectId: "p1",
            name: "Scribe",
            description: "",
            systemPrompt: "You write.",
            tools: ["count_rows"],
            skillKeys: ["style-guide", "style-guide"],
            approvalPolicy: { high: "deny" },
          },
          "u1",
        );
        expect(created).toMatchObject({
          skillKeys: ["style-guide"],
          approvalPolicy: { high: "deny" },
          version: "1.0.0",
        });
        const updated = await custom.updateAgent(created.id, { description: "Writes." }, "u1");
        expect(updated.version).toBe("1.0.1");
        expect(await loadAgentDefinition(`custom:${created.id}`)).toMatchObject({
          skillKeys: ["style-guide"],
          approvalPolicy: { high: "deny" },
          version: "1.0.1",
          toolAllowlist: ["count_rows"],
        });
        // Clearing the override stores NULL (not "{}").
        const cleared = await custom.updateAgent(created.id, { approvalPolicy: null }, "u1");
        expect(cleared.approvalPolicy).toBeNull();
      });

      it("refuses unknown or disabled skills, a malformed override and a credential in the prompt", async () => {
        const base = {
          projectId: "p1",
          description: "",
          systemPrompt: "ok",
          tools: [] as string[],
        };
        await expect(
          custom.createAgent({ ...base, name: "Bad One", skillKeys: ["nope"] }, "u1"),
        ).rejects.toThrow(/Unknown or disabled skills: nope/);
        await expect(
          custom.createAgent({ ...base, name: "Bad Two", skillKeys: ["off-skill"] }, "u1"),
        ).rejects.toThrow(/off-skill/);
        await expect(
          custom.createAgent(
            { ...base, name: "Bad Three", approvalPolicy: { low: "yolo" } as never },
            "u1",
          ),
        ).rejects.toThrow(/approvalPolicy/);
        await expect(
          custom.createAgent({ ...base, name: "Bad Four", systemPrompt: `use ${GH_TOKEN}` }, "u1"),
        ).rejects.toThrow(/credential/);
        await expect(
          custom.createAgent({ ...base, name: "Bad Five", skillKeys: ["../etc"] }, "u1"),
        ).rejects.toThrow(/skillKeys/);
        expect(await db.customAgent.count({ where: { name: { startsWith: "Bad" } } })).toBe(0);
      });

      it("export → import round-trips skills and the override (v2); v1 still imports; smuggled fields are refused", async () => {
        const src = await custom.createAgent(
          {
            projectId: "p1",
            name: "Porter",
            description: "",
            systemPrompt: "Port.",
            tools: [],
            skillKeys: ["style-guide"],
            approvalPolicy: { medium: "always-prompt" },
          },
          "u1",
        );
        const doc = exportAgent(src);
        expect(doc.schemaVersion).toBe(2);
        const def = parseAgentImport(
          JSON.parse(JSON.stringify({ ...doc, agent: { ...doc.agent, name: "Porter Two" } })),
        );
        const imported = await custom.createAgent({ ...def, projectId: "p1" }, "u1");
        expect(imported).toMatchObject({
          skillKeys: ["style-guide"],
          approvalPolicy: { medium: "always-prompt" },
        });
        expect(
          parseAgentImport({ schemaVersion: 1, agent: { name: "Old", systemPrompt: "x" } }),
        ).toMatchObject({ skillKeys: [], approvalPolicy: null });
        expect(() =>
          parseAgentImport({
            schemaVersion: 1,
            agent: { name: "Old", systemPrompt: "x", skillKeys: [] },
          }),
        ).toThrow(AgentImportError);
        expect(() =>
          parseAgentImport({
            schemaVersion: 2,
            agent: { name: "Old", systemPrompt: "x", approvalPolicy: { low: "auto", extra: "x" } },
          }),
        ).toThrow(AgentImportError);
      });
    });

    // ── #145 library agents ──────────────────────────────────────────────
    describe("library agents: frontmatter carries the whole definition", () => {
      const svc = () => new AgentService(db);

      it("stores reasoningEffort + approvalPolicy and accepts the agent tool refs", async () => {
        const target = await custom.createAgent(
          { projectId: "p1", name: "Target", description: "", systemPrompt: "t", tools: [] },
          "u1",
        );
        const created = await svc().create(
          {
            source: [
              "---",
              "name: planner",
              "reasoningEffort: high",
              "approvalPolicy:",
              "  high: deny",
              "tools:",
              "  - count_rows",
              "  - load_skill",
              "  - agent:*",
              `  - agent:custom:${target.id}`,
              "---",
              "You plan.",
            ].join("\n"),
          },
          actor,
        );
        expect(await loadAgentDefinition(`library:${created.id}`)).toMatchObject({
          reasoningEffort: "high",
          approvalPolicy: { high: "deny" },
          toolAllowlist: ["count_rows", "load_skill", "agent:*", `agent:custom:${target.id}`],
        });
      });

      it("rejects a malformed agent ref, a bad override and a credential in the body", async () => {
        const src = (extra: string, body = "Body.") =>
          ["---", `name: bad-${Math.random().toString(36).slice(2, 7)}`, extra, "---", body].join(
            "\n",
          );
        await expect(
          svc().create({ source: src("tools:\n  - agent:bogus") }, actor),
        ).rejects.toThrow(/AGENT_TOOL_REF_UNKNOWN/);
        await expect(
          svc().create({ source: src("approvalPolicy:\n  low: sometimes") }, actor),
        ).rejects.toThrow(/VALIDATION_ERROR/);
        await expect(svc().create({ source: src("", `key ${GH_TOKEN}`) }, actor)).rejects.toThrow(
          /AGENT_CONTAINS_SECRET/,
        );
      });
    });

    // ── #146 Agent Skills import ─────────────────────────────────────────
    describe("importing an Agent Skills directory", () => {
      const importer = () => new LibraryImporter({ skillService: new SkillService(db) });
      const SKILL_MD = [
        "---",
        "name: pdf-processing",
        "description: Extract PDF text and fill forms. Use when handling PDFs.",
        "license: Apache-2.0",
        "compatibility: Requires poppler",
        "metadata:",
        "  author: example-org",
        '  version: "1.0"',
        "allowed-tools: Bash(pdftotext:*) Read",
        "---",
        "# PDF processing",
        "",
        "See [the forms guide](references/FORMS.md).",
      ].join("\n");

      it("a standard SKILL.md directory imports as one skill; load_skill serves its supporting files", async () => {
        const res = await importer().importSkills(
          new InlineLoader([
            { path: "pdf-processing/SKILL.md", contents: SKILL_MD },
            { path: "pdf-processing/references/FORMS.md", contents: "FORMS-GUIDE" },
            { path: "pdf-processing/scripts/extract.py", contents: "print('never executed')" },
          ]),
          actor,
        );
        expect(res.failed).toEqual([]);
        expect(res.imported).toHaveLength(1);
        const skill = await db.skill.findUniqueOrThrow({
          where: { key: "pdf-processing" },
          include: { files: { orderBy: { path: "asc" } } },
        });
        expect(skill.files.map((f) => f.path)).toEqual([
          "references/FORMS.md",
          "scripts/extract.py",
        ]);
        // `allowed-tools` is kept as metadata only — it is not a tool grant.
        expect(JSON.parse(skill.manifest)).toMatchObject({
          license: "Apache-2.0",
          "allowed-tools": "Bash(pdftotext:*) Read",
          metadata: { author: "example-org", version: "1.0" },
        });
        const catalog = await resolveSkillCatalog({
          skillKeys: ["pdf-processing"],
          projectId: null,
        });
        const tool = loadSkillTool({ catalog });
        const ctx = { sessionId: "s", userId: "u1", projectId: null };
        const body = await tool.execute({ name: "pdf-processing" }, ctx);
        expect(body.text).toContain("See [the forms guide]");
        expect(body.text).toContain("- references/FORMS.md");
        const file = await tool.execute(
          { name: "pdf-processing", file: "references/FORMS.md" },
          ctx,
        );
        expect(file.text).toContain("FORMS-GUIDE");
      });

      it("malformed frontmatter and unsafe supporting files are rejected with a clear reason, nothing stored", async () => {
        const res = await importer().importSkills(
          new InlineLoader([
            {
              path: "broken/SKILL.md",
              contents: "---\nname: broken\ndescription: [unterminated\n---\nbody",
            },
            {
              path: "unknown-key/SKILL.md",
              contents: "---\nname: unknown-key\nexecute: rm -rf /\n---\nbody",
            },
            { path: "no-fm/SKILL.md", contents: "just text" },
            { path: "leaky/SKILL.md", contents: "---\nname: leaky\n---\nbody" },
            { path: "leaky/references/KEYS.md", contents: `token ${GH_TOKEN}` },
          ]),
          actor,
        );
        expect(res.imported).toHaveLength(0);
        const reasons = Object.fromEntries(res.failed.map((f) => [f.path, f.error]));
        expect(reasons["broken/SKILL.md"]).toMatch(/YAML_PARSE_ERROR/);
        expect(reasons["unknown-key/SKILL.md"]).toMatch(/Frontmatter key 'execute' is not allowed/);
        expect(reasons["no-fm/SKILL.md"]).toMatch(/must begin with a `---` YAML frontmatter block/);
        expect(reasons["leaky/SKILL.md"]).toMatch(/credential/);
        expect(
          await db.skill.count({ where: { key: { in: ["broken", "unknown-key", "leaky"] } } }),
        ).toBe(0);
      });

      it("materialised on disk (the Copilot SDK's skillDirectories), a skill keeps its supporting files — and a bad stored path is never written", async () => {
        const skill = await db.skill.findUniqueOrThrow({ where: { key: "pdf-processing" } });
        await db.skillFile.create({
          data: {
            skillId: skill.id,
            path: "../escape.md",
            content: "EVIL",
            sizeBytes: 4,
            sha256: "0".repeat(64),
          },
        });
        const home = mkdtempSync(path.join(os.tmpdir(), "metis-129-home-"));
        try {
          const rt = new SessionRuntime({ db });
          const out = await rt.materializeSkillsForSession({
            sessionId: "s",
            copilotHome: home,
            loadedSkillIds: [skill.id],
          });
          expect(out.written).toEqual(["pdf-processing"]);
          const dir = path.join(home, "skills", "pdf-processing");
          expect(readFileSync(path.join(dir, "references", "FORMS.md"), "utf8")).toBe(
            "FORMS-GUIDE",
          );
          expect(existsSync(path.join(dir, "scripts", "extract.py"))).toBe(true);
          expect(existsSync(path.join(home, "skills", "escape.md"))).toBe(false);
          expect(existsSync(path.join(dir, "..", "escape.md"))).toBe(false);
        } finally {
          rmSync(home, { recursive: true, force: true });
        }
      });

      it("from the filesystem: supporting files are read only under a SKILL.md; an oversize one is left out and reported, the skill still imports", async () => {
        const root = mkdtempSync(path.join(os.tmpdir(), "metis-129-skills-"));
        try {
          mkdirSync(path.join(root, "notes-skill", "references"), { recursive: true });
          writeFileSync(
            path.join(root, "notes-skill", "SKILL.md"),
            "---\nname: notes-skill\ndescription: Notes.\n---\nRead references/NOTES.md",
          );
          writeFileSync(path.join(root, "notes-skill", "references", "NOTES.md"), "NOTES-BODY");
          writeFileSync(path.join(root, "README.md"), "not a skill and not claimed");
          mkdirSync(path.join(root, "huge-skill"));
          writeFileSync(
            path.join(root, "huge-skill", "SKILL.md"),
            "---\nname: huge-skill\n---\nbig",
          );
          writeFileSync(path.join(root, "huge-skill", "blob.md"), "x".repeat(70 * 1024));
          const res = await importer().importSkills(
            new FilesystemLoader(root, "skills", undefined, { supportingFiles: true }),
            actor,
          );
          expect(res.imported.map((s) => s.key).sort()).toEqual(["huge-skill", "notes-skill"]);
          expect(res.failed).toEqual([]);
          expect(res.skippedFiles).toEqual([
            {
              skill: "huge-skill/SKILL.md",
              path: "blob.md",
              reason: expect.stringMatching(/larger than 65536 bytes/),
            },
          ]);
          const files = await db.skillFile.findMany({ where: { skill: { key: "notes-skill" } } });
          expect(files.map((f) => [f.path, f.content])).toEqual([
            ["references/NOTES.md", "NOTES-BODY"],
          ]);
          expect(await db.skillFile.count({ where: { skill: { key: "huge-skill" } } })).toBe(0);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });

      it("a real skill folder with a binary asset, OS junk, an odd file name and too many files still imports — each left-out file is reported with its reason", async () => {
        const root = mkdtempSync(path.join(os.tmpdir(), "metis-129-messy-"));
        try {
          const dir = path.join(root, "messy-skill");
          mkdirSync(path.join(dir, "assets"), { recursive: true });
          mkdirSync(path.join(dir, "references"), { recursive: true });
          mkdirSync(path.join(dir, "__MACOSX"), { recursive: true });
          writeFileSync(
            path.join(dir, "SKILL.md"),
            "---\nname: messy-skill\ndescription: Messy.\n---\nSee references/GUIDE.md",
          );
          writeFileSync(path.join(dir, "references", "GUIDE.md"), "GUIDE-BODY");
          // A PNG: signature + IHDR length bytes (NULs) — binary.
          writeFileSync(
            path.join(dir, "assets", "logo.png"),
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]),
          );
          writeFileSync(path.join(dir, ".DS_Store"), "Bud1");
          writeFileSync(path.join(dir, "__MACOSX", "junk"), "x");
          writeFileSync(path.join(dir, "._GUIDE.md"), "x");
          writeFileSync(path.join(dir, "notes(1).md"), "odd name");
          // 32 more text files: with GUIDE.md that is one past the limit.
          for (let i = 0; i < 32; i++) {
            writeFileSync(
              path.join(dir, "references", `r${String(i).padStart(2, "0")}.md`),
              `R${i}`,
            );
          }
          const res = await importer().importSkills(
            new FilesystemLoader(root, "skills", undefined, { supportingFiles: true }),
            actor,
          );
          expect(res.failed).toEqual([]);
          expect(res.imported.map((s) => s.key)).toEqual(["messy-skill"]);
          const reasons = Object.fromEntries(
            (res.skippedFiles ?? []).map((f) => [f.path, f.reason]),
          );
          expect(reasons["assets/logo.png"]).toBe("not a text file");
          expect(reasons[".DS_Store"]).toBe("operating-system metadata file");
          expect(reasons["__MACOSX/junk"]).toBe("operating-system metadata file");
          expect(reasons["._GUIDE.md"]).toBe("operating-system metadata file");
          expect(reasons["notes(1).md"]).toMatch(/^invalid path/);
          const overLimit = Object.entries(reasons).filter(([, r]) => /32-file limit/.test(r));
          expect(overLimit).toHaveLength(1);
          expect((res.skippedFiles ?? []).every((f) => f.skill === "messy-skill/SKILL.md")).toBe(
            true,
          );
          const stored = await db.skillFile.findMany({
            where: { skill: { key: "messy-skill" } },
            select: { path: true },
          });
          expect(stored).toHaveLength(32);
          expect(stored.map((f) => f.path)).not.toContain("assets/logo.png");
          expect(stored.map((f) => f.path)).not.toContain(".DS_Store");
          expect(stored.map((f) => f.path)).not.toContain("notes(1).md");
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });
    });
  },
);
