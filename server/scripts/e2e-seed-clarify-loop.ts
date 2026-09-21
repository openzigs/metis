/**
 * Seed a COMPLETED analysis with one deterministic specialist finding for the
 * #235 generative-loop e2e test (epic #209).
 *
 * Why this exists: the synthesis prompt embeds the persisted findings table.
 * The deterministic e2e harness runs replay/offline providers that never emit
 * structured findings of their own, so a live run would synthesise from zero
 * findings. Seeding exactly ONE `code` finding makes `readFlattenedFindings`
 * (and therefore `formatFindingsTable`) fully predictable, which is what lets
 * `e2e-build-clarify-fixtures.ts` compute the exact synthesis fixture key.
 *
 * Mirrors `e2e-seed-analysis-grounding.ts`. The finding shape is the single
 * source of truth in `e2e/fixtures/clarify-loop.ts` (`SEED_FINDING`).
 *
 * Usage:
 *   tsx server/scripts/e2e-seed-clarify-loop.ts <projectId> <startedById>
 */
/* eslint-disable no-console -- CLI script: writes JSON to stdout, errors to stderr */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { LOOP_MODEL_ID, SEED_FINDING } from "../../e2e/fixtures/clarify-loop.js";

async function main(): Promise<void> {
  const [projectId, startedById] = process.argv.slice(2);
  if (!projectId || !startedById) {
    console.error("usage: e2e-seed-clarify-loop.ts <projectId> <startedById>");
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
    const now = new Date();
    const analysis = await prisma.analysis.create({
      data: {
        projectId,
        startedById,
        status: "completed",
        startedAt: now,
        completedAt: now,
        totalTokens: 0,
        // Pin an explicit model so the regenerate path uses it directly
        // (bypassing the dynamic model router) — this keeps the specialist and
        // synthesis chat fixture keys fully deterministic. documentIds is empty
        // so the specialist agent retrieves no RAG context.
        metadata: JSON.stringify({
          source: "e2e-seed-clarify-loop",
          model: LOOP_MODEL_ID,
          documentIds: [],
        }),
      },
    });

    const agentResult = await prisma.agentResult.create({
      data: {
        analysisId: analysis.id,
        agentKey: SEED_FINDING.agentKey,
        status: "completed",
        startedAt: now,
        completedAt: now,
        output: JSON.stringify({
          agentKey: SEED_FINDING.agentKey,
          summary: "Seeded specialist finding (e2e #235).",
          findings: [],
          notes: [],
        }),
      },
    });

    await prisma.finding.create({
      data: {
        agentResultId: agentResult.id,
        category: SEED_FINDING.category,
        severity: SEED_FINDING.severity,
        title: SEED_FINDING.title,
        body: SEED_FINDING.body,
        derivation: "inferred",
        confidence: 0.7,
        evidence: JSON.stringify({
          citations: [],
          tags: SEED_FINDING.tags,
          requirementId: null,
        }),
      },
    });

    process.stdout.write(JSON.stringify({ id: analysis.id }));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
