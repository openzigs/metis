/**
 * Seed a single Requirement row directly into the e2e SQLite database.
 *
 * Why this exists: the offline-stub AI provider returns deterministic
 * pseudo-prose, NOT the structured JSON the synthesis pipeline expects.
 * Specialist agents reject the response as non-JSON and the analysis
 * completes with zero requirements — which would block the publish-dry-run
 * step (`generateDrafts` rejects analyses with no requirements).
 *
 * Rather than ship a "produce structured JSON when AI_OFFLINE=1" hack into
 * the production stub, the e2e suite injects a requirement here to keep
 * the test focused on the API surface (drafts → publish dry-run) instead
 * of the LLM. The /api/auth/login, upload, analysis-completed, publish
 * dry-run, schedule, and cancel steps are still real.
 *
 * Invoked from `tests/full-flow.spec.ts` via the helper in
 * `fixtures/seed-helpers.ts`. Reads PrismaClient from the server package
 * so it matches the runtime schema exactly.
 *
 * Usage:
 *   tsx server/scripts/e2e-seed-requirement.ts <projectId> <analysisId>
 */
/* eslint-disable no-console -- this is a CLI script that writes to stdout/stderr */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";

async function main(): Promise<void> {
  const [projectId, analysisId] = process.argv.slice(2);
  if (!projectId || !analysisId) {
    console.error("usage: seed-requirement.ts <projectId> <analysisId>");
    process.exit(2);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL must be set");
    process.exit(2);
  }

  const adapter = new PrismaBetterSqlite3({ url: databaseUrl });
  const prisma = new PrismaClient({ adapter });
  try {
    const created = await prisma.requirement.create({
      data: {
        projectId,
        analysisId,
        type: "feature",
        title: "E2E seeded — full-flow drafts can be generated",
        body: [
          "This requirement is seeded by the Playwright full-flow e2e suite to",
          "exercise the drafts/publish dry-run path. The offline-stub AI",
          "provider does not emit structured JSON, so synthesis cannot",
          "produce a Requirement organically inside the test window.",
        ].join("\n"),
        priority: "high",
        labels: JSON.stringify(["metis:e2e", "type:feature"]),
        reviewStatus: "approved",
        storyPoints: 3,
      },
    });
    process.stdout.write(JSON.stringify({ id: created.id }));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
