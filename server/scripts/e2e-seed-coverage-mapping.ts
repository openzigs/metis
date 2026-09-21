/**
 * Seed a completed test-coverage run (with mapped TestCaseDocs and/or
 * Suggestions) directly into the e2e SQLite database (Epic #260, issues #44/#45).
 *
 * Why this exists: both backend features under test consume data the offline
 * pipeline cannot produce deterministically inside the test window —
 *
 *   - #45 JUnit round-trip propagates a verdict to a `CoverageMapping` whose
 *     `testCaseDoc.title` normalises to a `<testcase name>` in the uploaded XML.
 *   - #44 Playwright-POM export scaffolds one spec per `Suggestion` on the run.
 *
 * Producing mappings/suggestions through the real pipeline requires the
 * offline-stub AI to emit structured JSON + a non-zero cosine score, which it
 * cannot. Rather than ship an AI hack, the e2e suite seeds a known run +
 * Requirement + TestCaseDocs + CoverageMappings + Suggestions here so the
 * matched/updated/unmatched and export-scaffold assertions are deterministic.
 *
 * The run is created with `status="completed"` so the route's
 * "most-recent completed run" fallback also resolves it.
 *
 * Usage:
 *   tsx server/scripts/e2e-seed-coverage-mapping.ts <projectId> <userId> <configJson>
 *
 *   configJson = { docTitles?: string[], suggestionTitles?: string[] }
 *
 * Emits JSON: { runId, requirementId, docTitles: string[], suggestionIds: string[] }
 */
/* eslint-disable no-console -- this is a CLI script that writes to stdout/stderr */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";

interface SeedConfig {
  docTitles?: string[];
  suggestionTitles?: string[];
}

async function main(): Promise<void> {
  const [projectId, userId, configJson] = process.argv.slice(2);
  if (!projectId || !userId) {
    console.error("usage: e2e-seed-coverage-mapping.ts <projectId> <userId> <configJson>");
    process.exit(2);
  }
  let config: SeedConfig = {};
  if (configJson) {
    try {
      config = JSON.parse(configJson) as SeedConfig;
    } catch (err) {
      console.error(`invalid config JSON: ${(err as Error).message}`);
      process.exit(2);
    }
  }
  const docTitles = config.docTitles ?? [];
  const suggestionTitles = config.suggestionTitles ?? [];

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL must be set");
    process.exit(2);
  }

  const adapter = new PrismaBetterSqlite3({ url: databaseUrl });
  const prisma = new PrismaClient({ adapter });
  try {
    const out = await prisma.$transaction(async (tx) => {
      const analysis = await tx.analysis.create({
        data: { projectId, status: "completed", startedById: userId },
        select: { id: true },
      });

      const requirement = await tx.requirement.create({
        data: {
          projectId,
          analysisId: analysis.id,
          type: "feature",
          title: "E2E seeded — test-synthesis target requirement",
          body: "Seeded by the e2e test-synthesis suite to anchor coverage mappings + suggestions.",
          priority: "high",
          reviewStatus: "approved",
        },
        select: { id: true },
      });

      const run = await tx.testCoverageRun.create({
        data: {
          projectId,
          createdById: userId,
          status: "completed",
          mode: "A",
          contentHash: `e2e-synth-${Date.now()}`,
          completedAt: new Date(),
        },
        select: { id: true },
      });

      if (docTitles.length > 0) {
        const imp = await tx.testCaseImport.create({
          data: {
            projectId,
            source: "csv",
            status: "completed",
            label: "E2E synth seed",
            testCount: docTitles.length,
          },
          select: { id: true },
        });
        let i = 0;
        for (const title of docTitles) {
          const doc = await tx.testCaseDoc.create({
            data: {
              projectId,
              sourceImportId: imp.id,
              source: "csv",
              externalId: `e2e-synth-${run.id}-${i}`,
              title,
              stepsJson: "[]",
              tags: "[]",
              priority: "medium",
              contentHash: `e2e-synth-doc-${run.id}-${i}`,
            },
            select: { id: true },
          });
          await tx.coverageMapping.create({
            data: {
              runId: run.id,
              requirementId: requirement.id,
              testCaseDocId: doc.id,
              cosine: 0.9,
              bm25: 0.5,
              fused: 0.9,
              status: "COVERED",
            },
          });
          i += 1;
        }
      }

      const suggestionIds: string[] = [];
      for (const title of suggestionTitles) {
        const s = await tx.suggestion.create({
          data: {
            runId: run.id,
            title,
            mappedRequirementIds: JSON.stringify([requirement.id]),
            gwtJson: JSON.stringify({
              given: ["the system is in a known state"],
              when: ["the user performs the action"],
              then: ["the expected outcome is observed"],
            }),
            stepsJson: JSON.stringify([{ action: "do the thing", expected: "it works" }]),
            // High faithfulness so the export's low-confidence gate is not tripped.
            faithfulness: 0.95,
            lowConfidence: false,
            status: "draft",
          },
          select: { id: true },
        });
        suggestionIds.push(s.id);
      }

      return { runId: run.id, requirementId: requirement.id, docTitles, suggestionIds };
    });

    process.stdout.write(JSON.stringify(out));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
