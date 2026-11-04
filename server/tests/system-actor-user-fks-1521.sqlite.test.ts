/**
 * #1521 — system-initiated work never writes `SYSTEM_ACTOR_ID` into a foreign
 * key to `users`.
 *
 * #1518 fixed the audit rows and #1528 the scheduled analysis re-run
 * (`Analysis.startedById`, covered by `scheduled-analysis-system-start-1528`).
 * Two more writes took the `"system"` id straight into a `User` foreign key, so
 * the write itself failed:
 *
 *   - a scheduled repository / database refresh creating a NEW connector
 *     document: `Document.uploadedById` is a required foreign key. The unit's
 *     error is swallowed into `failures`, so the refresh "succeeded" with the
 *     document missing.
 *   - library auto-discover at boot: `createdBy: { connect: { id: "system" } }`
 *     on `Skill` / `Agent` (and their first version) names a user that does not
 *     exist, so every discovered skill and agent landed in `failed`.
 *
 * The rule per path:
 *
 *   - Document: resolved to a real user — the connector's creator, else the
 *     project's creator (`Project.createdById` is a required foreign key, so it
 *     always names a user). A user-run ingest is still attributed to that user.
 *   - Skill / Agent (and versions): written with no creator. The columns are
 *     nullable (`ON DELETE SET NULL`), and nobody created a discovered file.
 *
 * Real SQLite built by the migration chain and the real services; storage, the
 * knowledge service and the audit sink are stubbed (they are not under test).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DbSchemaSnapshot } from "@metis/shared";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";
import type { RepoMetadata } from "../src/lib/connectors/repo/repo-service.js";

const state = vi.hoisted(() => ({ db: null as unknown, blobs: 0 }));
vi.mock("../src/lib/prisma.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return {
    get prisma() {
      return state.db;
    },
    Prisma,
    resolveDatabaseProvider: () => "sqlite" as const,
  };
});
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));
vi.mock("../src/lib/documents/storage.js", () => ({
  getDocumentStorage: () => ({
    write: async ({ buffer }: { buffer: Buffer }) => {
      state.blobs += 1;
      return {
        storagePath: `blob/${state.blobs}`,
        checksum: `sha-${state.blobs}`,
        sizeBytes: buffer.length,
      };
    },
  }),
}));
vi.mock("../src/lib/rag/knowledge-service.js", () => ({
  getKnowledgeService: () => ({
    ingestDocument: async () => ({ status: "ready", chunkCount: 1 }),
  }),
}));

const { ingestDbSchema, ingestRepoMetadata } =
  await import("../src/lib/connectors/connector-ingest.js");
const { autoDiscoverFromWorkspace } = await import("../src/lib/library/import.js");
const { SkillService } = await import("../src/lib/library/skill-service.js");
const { AgentService } = await import("../src/lib/library/agent-service.js");
const { SYSTEM_ACTOR_ID } = await import("../src/lib/audit/system-actor.js");

const PROJ = "p-1521";
const PROJECT_OWNER = "u-1521-owner";
const DB_CREATOR = "u-1521-db";
const MEMBER = "u-1521-member";

function snapshot(table: string): DbSchemaSnapshot {
  return {
    driver: "postgres",
    schema: "public",
    extractedAt: new Date(0).toISOString(),
    durationMs: 1,
    tables: [
      {
        schema: "public",
        name: table,
        columns: [{ name: "id", dataType: "int", nullable: false, isPrimaryKey: true }],
        primaryKey: ["id"],
        foreignKeys: [],
        indexes: [],
      },
    ],
  } as unknown as DbSchemaSnapshot;
}

const repoMeta = {
  repo: { full_name: "acme/app", default_branch: "main" },
  ref: "main",
  refFoundUpstream: true,
  headSha: "abc",
  languages: {},
  topLevel: [],
  readme: "# App",
  manifests: {},
} as unknown as RepoMetadata;

const skillSrc = (name: string, body = "Body") => `---
name: ${name}
description: Skill ${name}
version: 1.0.0
---

${body} for ${name}
`;
const agentSrc = (name: string) => `---
name: ${name}
displayName: ${name}
description: Agent ${name}
version: 1.0.0
---

System prompt for ${name}.
`;

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  '#1521 — the "system" actor never reaches a User foreign key (real SQLite)',
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let workspace: string;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1521-system-actor-fks");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      for (const id of [PROJECT_OWNER, DB_CREATOR, MEMBER]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
      }
      await db.project.create({
        data: { id: PROJ, name: PROJ, slug: PROJ, createdById: PROJECT_OWNER },
      });
      // A repository connector whose creator is gone (SET NULL) and a database
      // connector whose creator is still here.
      await db.repoConnection.create({ data: { id: "c-repo", projectId: PROJ, label: "r" } });
      await db.databaseConnection.create({
        data: {
          id: "c-db",
          projectId: PROJ,
          label: "d",
          driver: "postgres",
          createdById: DB_CREATOR,
        },
      });

      workspace = mkdtempSync(path.join(tmpdir(), "metis-1521-"));
      mkdirSync(path.join(workspace, ".github", "skills", "found-skill"), { recursive: true });
      writeFileSync(
        path.join(workspace, ".github", "skills", "found-skill", "SKILL.md"),
        skillSrc("found-skill"),
      );
      mkdirSync(path.join(workspace, ".github", "agents"), { recursive: true });
      writeFileSync(
        path.join(workspace, ".github", "agents", "found.agent.md"),
        agentSrc("found-agent"),
      );
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
      if (workspace) rmSync(workspace, { recursive: true, force: true });
    });

    describe("scheduled connector refresh — Document.uploadedById", () => {
      it("a system DB ingest creates its documents, attributed to the connector's creator", async () => {
        const summary = await ingestDbSchema(PROJ, "c-db", SYSTEM_ACTOR_ID, snapshot("orders"));
        expect(summary.failures).toBe(0);
        expect(summary.documentsCreated).toBe(2);
        const docs = await db.document.findMany({
          where: { projectId: PROJ, source: "db" },
          select: { uploadedById: true },
        });
        expect(docs).toHaveLength(2);
        expect(docs.every((d) => d.uploadedById === DB_CREATOR)).toBe(true);
      });

      it("a system repo ingest falls back to the project's creator when the connector has none", async () => {
        const summary = await ingestRepoMetadata(PROJ, "c-repo", SYSTEM_ACTOR_ID, repoMeta);
        expect(summary.failures).toBe(0);
        expect(summary.documentsCreated).toBe(2);
        const docs = await db.document.findMany({
          where: { projectId: PROJ, source: "repo" },
          select: { uploadedById: true },
        });
        expect(docs).toHaveLength(2);
        expect(docs.every((d) => d.uploadedById === PROJECT_OWNER)).toBe(true);
      });

      it("a user-run ingest is still attributed to that user", async () => {
        const summary = await ingestDbSchema(PROJ, "c-db", MEMBER, snapshot("invoices"));
        expect(summary.failures).toBe(0);
        const doc = await db.document.findFirstOrThrow({
          where: { projectId: PROJ, filename: "connector:db:c-db:public.invoices.md" },
          select: { uploadedById: true },
        });
        expect(doc.uploadedById).toBe(MEMBER);
      });

      it("never persists the system id", async () => {
        expect(await db.document.count({ where: { uploadedById: SYSTEM_ACTOR_ID } })).toBe(0);
      });
    });

    describe("library auto-discover at boot — Skill / Agent createdById", () => {
      it("imports every discovered skill and agent with no creator", async () => {
        const out = await autoDiscoverFromWorkspace(
          workspace,
          { id: SYSTEM_ACTOR_ID },
          { skillService: new SkillService(db), agentService: new AgentService(db) },
        );
        expect(out.skills.failed).toEqual([]);
        expect(out.agents.failed).toEqual([]);
        expect(out.skills.imported.map((s) => s.key)).toEqual(["found-skill"]);
        expect(out.agents.imported.map((a) => a.key)).toEqual(["found-agent"]);

        const skill = await db.skill.findUniqueOrThrow({
          where: { key: "found-skill" },
          include: { versions: true },
        });
        expect(skill.createdById).toBeNull();
        expect(skill.versions.map((v) => v.createdById)).toEqual([null]);
        const agent = await db.agent.findUniqueOrThrow({
          where: { key: "found-agent" },
          include: { versions: true },
        });
        expect(agent.createdById).toBeNull();
        expect(agent.versions.map((v) => v.createdById)).toEqual([null]);
      });

      it("a system update writes its new version with no creator", async () => {
        const skills = new SkillService(db);
        const agents = new AgentService(db);
        const skill = await db.skill.findUniqueOrThrow({ where: { key: "found-skill" } });
        await skills.update(
          skill.id,
          { source: skillSrc("found-skill", "Changed") },
          { id: SYSTEM_ACTOR_ID },
        );
        const agent = await db.agent.findUniqueOrThrow({ where: { key: "found-agent" } });
        await agents.update(
          agent.id,
          { source: agentSrc("found-agent").replace("System prompt", "New prompt") },
          { id: SYSTEM_ACTOR_ID },
        );
        const sv = await db.skillVersion.findMany({ where: { skillId: skill.id } });
        const av = await db.agentVersion.findMany({ where: { agentId: agent.id } });
        expect(sv).toHaveLength(2);
        expect(av).toHaveLength(2);
        expect([...sv, ...av].every((v) => v.createdById === null)).toBe(true);
      });

      it("a user-created skill still records its creator", async () => {
        const created = await new SkillService(db).create(
          { source: skillSrc("user-skill") },
          { id: MEMBER },
        );
        expect(created.createdById).toBe(MEMBER);
      });
    });
  },
);
