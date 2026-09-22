/**
 * Seed a DriftEvent + PublishedIssue row into the e2e SQLite database.
 *
 * The sync dashboard and drift badge e2e tests need drift events to exist
 * before the test body runs. Since the reconciliation service requires a
 * real GitHub/Jira webhook payload matched to an existing PublishedIssue,
 * we seed the full chain here: batch → draft → published issue → drift event.
 *
 * Usage:
 *   tsx server/scripts/e2e-seed-drift.ts <projectId> [field] [localValue] [externalValue]
 *
 * Outputs JSON: { driftId, publishedIssueId, projectId }
 */
/* eslint-disable no-console -- CLI script */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import * as crypto from "node:crypto";

async function main(): Promise<void> {
  const [projectId, field, localValue, externalValue] = process.argv.slice(2);
  if (!projectId) {
    console.error("usage: e2e-seed-drift.ts <projectId> [field] [localValue] [externalValue]");
    process.exit(2);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL must be set");
    process.exit(2);
  }

  // Prisma 7 dropped `datasources`; the SQLite driver adapter is the
  // supported way to point a client at the e2e database file.
  const adapter = new PrismaBetterSqlite3({ url: databaseUrl });
  const prisma = new PrismaClient({ adapter });

  try {
    // 0. Ensure we have a user row for the batch FK (startedById)
    const user = await prisma.user.findFirst({ where: { username: "admin" } });
    if (!user) {
      throw new Error("No admin user found — run primeAdminUser first");
    }

    // 1. Create a PublishBatch for this project
    const batch = await prisma.publishBatch.create({
      data: {
        projectId,
        status: "completed",
        targetOwner: "e2e-owner",
        targetRepo: "e2e-repo",
        provider: "github",
        startedById: user.id,
        totalDrafts: 1,
        publishedCount: 1,
      },
    });

    // 2. Create an IssueDraft (needed by PublishedIssue FK)
    const draft = await prisma.issueDraft.create({
      data: {
        projectId,
        title: localValue || "Original METIS title",
        body: "E2E seeded draft body for drift testing",
        labels: JSON.stringify(["e2e", "sync-test"]),
      },
    });

    // 3. Create a PublishedIssue
    const publishedIssue = await prisma.publishedIssue.create({
      data: {
        batchId: batch.id,
        draftId: draft.id,
        issueNumber: Math.floor(Math.random() * 9000) + 1000,
        issueId: `ext-${crypto.randomUUID().slice(0, 8)}`,
        htmlUrl: `https://github.com/e2e-owner/e2e-repo/issues/${Math.floor(Math.random() * 9000)}`,
        status: "created",
        destination: "github",
      },
    });

    // 4. Create the DriftEvent
    const driftField = field || "title";
    const driftLocal = localValue || "Original METIS title";
    const driftExternal = externalValue || "Edited title in GitHub";

    const driftEvent = await prisma.driftEvent.create({
      data: {
        publishedIssueId: publishedIssue.id,
        projectId,
        requirementId: null,
        source: "github",
        deliveryId: crypto.randomUUID(),
        action: "edited",
        fieldDiffs: JSON.stringify([
          { field: driftField, local: driftLocal, external: driftExternal },
        ]),
        externalSnapshot: JSON.stringify({
          title: driftField === "title" ? driftExternal : driftLocal,
          body: driftField === "body" ? driftExternal : "E2E seeded draft body",
          state: driftField === "state" ? driftExternal : "open",
          labels: [],
          assignees: [],
        }),
        localSnapshot: JSON.stringify({
          title: driftField === "title" ? driftLocal : "Original METIS title",
          body: driftField === "body" ? driftLocal : "E2E seeded draft body",
          state: "open",
          labels: [],
          assignees: [],
        }),
        status: "pending",
      },
    });

    console.log(
      JSON.stringify({
        driftId: driftEvent.id,
        publishedIssueId: publishedIssue.id,
        projectId,
      }),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
