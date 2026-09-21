/**
 * Seed a usage-classification scenario into the e2e SQLite database — Epic #292 (#298).
 *
 * The per-object used/unreferenced/uncertain classification surfaced by the
 * project-impact UI is normally produced by reconciling a live DB connector's
 * introspected schema against the code→schema graph (#296/#297) and persisting
 * the result via `POST .../usage-classification`. That compute path requires a
 * real database connector + introspection, which is not deterministically
 * reproducible in the offline e2e stack.
 *
 * So this script seeds the *output* of that pipeline directly:
 *   1. an ImpactAnalysis + one ImpactItem for the project, so the detail page
 *      renders a `project-impact-section` (the UI only fetches + renders the
 *      classification block inside a rendered project section that has items),
 *   2. a deterministic set of `SchemaUsageClassification` rows covering all
 *      three classes (used / unreferenced / uncertain), with evidence on the
 *      used + uncertain ones and an `uncertainReason` on the uncertain one.
 *
 * The seeded rows are read back verbatim by `GET .../usage-classification`
 * (`readUsageClassification`), so the spec exercises the real route + the real
 * React rendering — only the upstream introspection is short-circuited.
 *
 * Usage:
 *   tsx server/scripts/e2e-seed-usage-classification.ts <projectId>
 *
 * Outputs JSON: { analysisId, projectId, used, unreferenced, uncertain }
 */
/* eslint-disable no-console -- CLI script */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";

interface SeededEvidence {
  edgeKind: string;
  source: string;
  fromQualifiedName: string | null;
  reconciliation: string | null;
}

async function main(): Promise<void> {
  const [projectId] = process.argv.slice(2);
  if (!projectId) {
    console.error("usage: e2e-seed-usage-classification.ts <projectId>");
    process.exit(2);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL must be set");
    process.exit(2);
  }

  // Prisma 7 uses driver adapters — mirror server/src/lib/prisma.ts so this
  // script binds to the same e2e SQLite database the server reads/writes.
  const adapter = new PrismaBetterSqlite3({ url: databaseUrl });
  const prisma = new PrismaClient({ adapter });

  try {
    const user = await prisma.user.findFirst({ where: { username: "admin" } });
    if (!user) {
      throw new Error("No admin user found — run primeAdminUser first");
    }

    // 1. An ImpactAnalysis with one ImpactItem for this project. The detail
    //    page only renders a project section (and therefore the classification
    //    block) when the analysis is `completed` and has at least one item.
    const analysis = await prisma.impactAnalysis.create({
      data: {
        status: "completed",
        sourceText: "e2e usage-classification seed",
        summary: "Seeded impact analysis for usage-classification e2e (#298)",
        startedById: user.id,
        completedAt: new Date(),
        totalImpactedSymbols: 1,
        items: {
          create: [
            {
              projectId,
              changeType: "modified",
              severity: "medium",
              impactScore: 0.5,
              confidence: 0.9,
              affectedFileCount: 1,
              affectedSymbolCount: 1,
            },
          ],
        },
      },
      select: { id: true },
    });

    // 2. The classification rows. Schema-qualified table identities mirror the
    //    reconciler's output shape. Evidence is JSON-encoded UsageEvidence[].
    const usedEvidence: SeededEvidence[] = [
      {
        edgeKind: "reads",
        source: "mybatis",
        fromQualifiedName: "com.acme.OrderMapper.findById",
        reconciliation: "matched",
      },
    ];
    const uncertainEvidence: SeededEvidence[] = [
      {
        edgeKind: "writes",
        source: "mybatis",
        fromQualifiedName: "com.acme.LegacyMapper.purge",
        reconciliation: "table-not-found",
      },
    ];

    // Clear any prior seed for idempotency (re-running overwrites cleanly).
    await prisma.schemaUsageClassification.deleteMany({ where: { projectId } });

    await prisma.schemaUsageClassification.createMany({
      data: [
        {
          projectId,
          kind: "table",
          tableName: "public.orders",
          columnName: null,
          columnType: null,
          usageClass: "used",
          uncertainReason: null,
          evidence: JSON.stringify(usedEvidence),
          overriddenClass: null,
        },
        {
          projectId,
          kind: "column",
          tableName: "public.orders",
          columnName: "total_cents",
          columnType: "integer",
          usageClass: "used",
          uncertainReason: null,
          evidence: JSON.stringify(usedEvidence),
          overriddenClass: null,
        },
        {
          projectId,
          kind: "table",
          tableName: "public.legacy_audit_log",
          columnName: null,
          columnType: null,
          usageClass: "unreferenced",
          uncertainReason: null,
          evidence: JSON.stringify([]),
          overriddenClass: null,
        },
        {
          projectId,
          kind: "table",
          tableName: "public.shadow_orders",
          columnName: null,
          columnType: null,
          usageClass: "uncertain",
          uncertainReason: "table-not-found",
          evidence: JSON.stringify(uncertainEvidence),
          overriddenClass: null,
        },
      ],
    });

    console.log(
      JSON.stringify({
        analysisId: analysis.id,
        projectId,
        used: 2,
        unreferenced: 1,
        uncertain: 1,
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
