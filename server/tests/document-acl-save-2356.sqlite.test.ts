/**
 * #2356 — document ACL writes, on real SQLite built by the migration chain:
 *   - `saveDocumentAcl` writes the document and every chunk together, and
 *     checks the group rule (#2261) against the ACL it replaces: when another
 *     save lands between its read and its write, it reads again, so a legacy
 *     group the other editor removed is refused, never written back;
 *   - the ingest-time ACL write (`writeQuarantine`) is held to the same rule.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

const { saveDocumentAcl, AclGroupUnsupportedError, AclSaveConflictError, ACL_SAVE_ATTEMPTS } =
  await import("../src/lib/rag/acl.js");
const { writeQuarantine } = await import("../src/lib/rag/quarantine.js");

const USER = "u-owner";
const PROJECT = "p-2356";
const OTHER_PROJECT = "p-2356-other";
const DOC = "d-2356";
const LEGACY = JSON.stringify([
  { kind: "group", value: "legacy" },
  { kind: "user", value: "alice" },
]);

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2356 — document ACL writes (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    const acl = async () =>
      (await db.document.findUniqueOrThrow({ where: { id: DOC } })).aclSubjects;
    const chunkAcls = async () =>
      (await db.knowledgeChunk.findMany({ where: { documentId: DOC } })).map((c) => c.aclSubjects);

    beforeAll(async () => {
      sqlite = createMigratedSqlite("document-acl-save-2356");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: USER, username: "owner", displayName: "owner", email: "o@example.test" },
      });
      for (const id of [PROJECT, OTHER_PROJECT]) {
        await db.project.create({ data: { id, name: id, slug: id, createdById: USER } });
      }
      await db.document.create({
        data: {
          id: DOC,
          projectId: PROJECT,
          filename: "policy.md",
          mimeType: "text/markdown",
          sizeBytes: 1,
          storagePath: "/tmp/policy.md",
          checksum: DOC,
          uploadedById: USER,
          status: "ready",
        },
      });
      for (const position of [0, 1]) {
        await db.knowledgeChunk.create({
          data: {
            id: `c-${position}`,
            projectId: PROJECT,
            documentId: DOC,
            position,
            text: `chunk ${position}`,
            md5: `md5-${position}`,
            embeddingModel: "test",
          },
        });
      }
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    beforeEach(async () => {
      await db.document.update({ where: { id: DOC }, data: { aclSubjects: LEGACY } });
      await db.knowledgeChunk.updateMany({
        where: { documentId: DOC },
        data: { aclSubjects: LEGACY },
      });
    });

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    describe("saveDocumentAcl", () => {
      it("writes the document and every chunk, keeping a group it already holds", async () => {
        const next = [
          { kind: "group" as const, value: "legacy" },
          { kind: "role" as const, value: "developer" },
        ];
        await expect(
          saveDocumentAcl({ documentId: DOC, projectId: PROJECT, aclSubjects: next }),
        ).resolves.toEqual({ chunkCount: 2 });
        expect(await acl()).toBe(JSON.stringify(next));
        expect(await chunkAcls()).toEqual([JSON.stringify(next), JSON.stringify(next)]);
      });

      it("refuses a new group and writes nothing", async () => {
        const err = await saveDocumentAcl({
          documentId: DOC,
          projectId: PROJECT,
          aclSubjects: [{ kind: "group", value: "finance" }],
        }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(AclGroupUnsupportedError);
        expect((err as InstanceType<typeof AclGroupUnsupportedError>).groups).toEqual(["finance"]);
        expect(await acl()).toBe(LEGACY);
        expect(await chunkAcls()).toEqual([LEGACY, LEGACY]);
      });

      it("answers null for a document of another project, and writes nothing", async () => {
        await expect(
          saveDocumentAcl({ documentId: DOC, projectId: OTHER_PROJECT, aclSubjects: [] }),
        ).resolves.toBeNull();
        expect(await acl()).toBe(LEGACY);
      });

      // The race #2356 names: Bob's editor still shows the legacy group. His save
      // reads the ACL holding it; Alice's save removes it before his write lands.
      it("never writes back a group another save removed between its read and its write", async () => {
        const alice = [{ kind: "user" as const, value: "alice" }];
        const bob = [
          { kind: "group" as const, value: "legacy" },
          { kind: "user" as const, value: "bob" },
        ];
        let raced = false;
        const err = await saveDocumentAcl(
          { documentId: DOC, projectId: PROJECT, aclSubjects: bob },
          {
            afterRead: async () => {
              if (raced) return;
              raced = true;
              await saveDocumentAcl({ documentId: DOC, projectId: PROJECT, aclSubjects: alice });
            },
          },
        ).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(AclGroupUnsupportedError);
        expect(await acl()).toBe(JSON.stringify(alice));
        expect(await chunkAcls()).toEqual([JSON.stringify(alice), JSON.stringify(alice)]);
      });

      it("saves over the other save when the ACL it lost to still allows it", async () => {
        const bob = [{ kind: "user" as const, value: "bob" }];
        let raced = false;
        await saveDocumentAcl(
          { documentId: DOC, projectId: PROJECT, aclSubjects: bob },
          {
            afterRead: async () => {
              if (raced) return;
              raced = true;
              await db.document.update({
                where: { id: DOC },
                data: { aclSubjects: JSON.stringify([{ kind: "user", value: "carol" }]) },
              });
            },
          },
        );
        expect(await acl()).toBe(JSON.stringify(bob));
        expect(await chunkAcls()).toEqual([JSON.stringify(bob), JSON.stringify(bob)]);
      });

      it("gives up with a conflict when the ACL changes under every attempt", async () => {
        let n = 0;
        const err = await saveDocumentAcl(
          { documentId: DOC, projectId: PROJECT, aclSubjects: [] },
          {
            afterRead: async () => {
              n += 1;
              await db.document.update({
                where: { id: DOC },
                data: { aclSubjects: JSON.stringify([{ kind: "user", value: `u${n}` }]) },
              });
            },
          },
        ).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(AclSaveConflictError);
        expect(n).toBe(ACL_SAVE_ATTEMPTS);
        // The last concurrent write stands; the chunks were never touched.
        expect(await acl()).toBe(JSON.stringify([{ kind: "user", value: `u${n}` }]));
        expect(await chunkAcls()).toEqual([LEGACY, LEGACY]);
      });
    });

    describe("writeQuarantine (the ingest-time ACL write)", () => {
      const quarantine = (aclSubjects: Array<{ kind: "user" | "role" | "group"; value: string }>) =>
        writeQuarantine({
          documentId: DOC,
          projectId: PROJECT,
          filename: "policy.md",
          chunks: [],
          embeddingModel: "test",
          aclSubjects,
        });

      it("refuses a group subject the document does not hold, and changes nothing", async () => {
        const err = await quarantine([{ kind: "group", value: "finance" }]).catch(
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(AclGroupUnsupportedError);
        expect((err as InstanceType<typeof AclGroupUnsupportedError>).groups).toEqual(["finance"]);
        const doc = await db.document.findUniqueOrThrow({ where: { id: DOC } });
        expect(doc.aclSubjects).toBe(LEGACY);
        expect(doc.indexState).not.toBe("quarantined");
      });

      it("writes the document's own ACL, legacy group included, as ingest always has", async () => {
        await quarantine([
          { kind: "group", value: "legacy" },
          { kind: "user", value: "alice" },
        ]);
        const doc = await db.document.findUniqueOrThrow({ where: { id: DOC } });
        expect(doc.aclSubjects).toBe(LEGACY);
        expect(doc.indexState).toBe("quarantined");
      });
    });
  },
);
