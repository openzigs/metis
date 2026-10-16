/**
 * #1180 — the cross-project guard's lookup on a REAL Postgres.
 *
 * `findCrossProjectOwners` matches `owner/repo` case-insensitively with a
 * tagged `$queryRaw` folding both sides with `LOWER()` (GitHub names are
 * case-insensitive; Prisma `equals` is not). The SQLite route suite
 * (`publishing-cross-project-1180.sqlite.test.ts`) proves it on SQLite and is
 * skipped here, so this suite runs the same query against Postgres: the quoted
 * camel-case columns, `<>`, `IS NULL` and `LOWER` all have to hold on both.
 *
 * Gated like the other `*-postgres.integration.test.ts` suites: runs only when
 * `RUN_INTEGRATION_TESTS=1` AND `DATABASE_URL` is Postgres-shaped.
 */
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { selectPrismaAdapter } from "../src/lib/prisma.js";
import { findCrossProjectOwners } from "../src/lib/publishing/cross-project-guard.js";

const databaseUrl = process.env.DATABASE_URL ?? "";
const isPostgres = databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://");
const enabled = process.env.RUN_INTEGRATION_TESTS === "1" && isPostgres;

const SUFFIX = randomUUID().slice(0, 8);
const USER = `u-1180pg-${SUFFIX}`;
const MINE = `proj-1180pg-mine-${SUFFIX}`;
const OTHER = `proj-1180pg-other-${SUFFIX}`;
const GONE = `proj-1180pg-gone-${SUFFIX}`;
const OWNER = `Sandbox-Org-${SUFFIX}`;
const REPO = "Shared-1180";

describe.runIf(enabled)("#1180 cross-project guard lookup on real Postgres (integration)", () => {
  const db = new PrismaClient({ adapter: selectPrismaAdapter(databaseUrl) });

  beforeAll(async () => {
    await db.user.create({
      data: { id: USER, username: USER, displayName: USER, email: `${USER}@x.test` },
    });
    for (const id of [MINE, OTHER, GONE]) {
      await db.project.create({ data: { id, name: id, slug: id, createdById: USER } });
    }
    // Another project connects the repo, in the case it was typed there.
    await db.repoConnection.create({
      data: { projectId: OTHER, label: "shared", ownerOrOrg: OWNER, repoName: REPO },
    });
    // This project's own connection never counts.
    await db.repoConnection.create({
      data: { projectId: MINE, label: "shared", ownerOrOrg: OWNER, repoName: REPO },
    });
    // A soft-deleted connection never counts.
    await db.repoConnection.create({
      data: {
        projectId: GONE,
        label: "shared",
        ownerOrOrg: OWNER,
        repoName: REPO,
        deletedAt: new Date(),
      },
    });
  });

  afterAll(async () => {
    await db.repoConnection.deleteMany({ where: { projectId: { in: [MINE, OTHER, GONE] } } });
    await db.project.deleteMany({ where: { id: { in: [MINE, OTHER, GONE] } } });
    await db.user.deleteMany({ where: { id: USER } });
    await db.$disconnect();
  });

  it("finds the other project for the name as connected", async () => {
    expect(
      await findCrossProjectOwners({ projectId: MINE, targetOwner: OWNER, targetRepo: REPO }),
    ).toEqual([OTHER]);
  });

  it("finds it for a case variant of the name", async () => {
    expect(
      await findCrossProjectOwners({
        projectId: MINE,
        targetOwner: OWNER.toLowerCase(),
        targetRepo: REPO.toUpperCase(),
      }),
    ).toEqual([OTHER]);
  });

  it("does not match a different repository", async () => {
    expect(
      await findCrossProjectOwners({
        projectId: MINE,
        targetOwner: OWNER,
        targetRepo: `${REPO}-fork`,
      }),
    ).toEqual([]);
  });
});
