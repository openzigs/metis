/**
 * Seed an impact-analysis "procedures & functions" scenario into the e2e SQLite
 * database — Epic #293 Phase 2 (#302).
 *
 * Phase 2 surfaces database **procedures & functions** alongside tables/columns
 * in the impact-analysis affected-objects UI. Two persisted shapes back that UI:
 *
 *   1. `ImpactAffectedTable` rows attached to an `ImpactItem`, now carrying an
 *      `objectKind` discriminator (`table|column|procedure|function`). Routine
 *      rows (`procedure`/`function`) drive the "Affected procedures & functions"
 *      sub-section in `AffectedTablesSection`. Their `suggestedDdl` slot is a
 *      **verify-only note** — never a drop/alter statement (Phase 2 does not
 *      analyse routine bodies; that is Phase 3, #294).
 *
 *   2. `SchemaUsageClassification` rows whose `kind` is `procedure`/`function`.
 *      These flow through the same Phase 1 used/unreferenced/uncertain UI
 *      (`UsageClassificationSection`). A routine whose body cannot be statically
 *      analysed is `uncertain` with reason `routine-body-unanalyzed` and is
 *      NEVER auto-recommended for dropping.
 *
 * Both compute paths require a live DB connector + introspection that the
 * offline e2e stack cannot reproduce deterministically, so — exactly like
 * `e2e-seed-usage-classification.ts` — this script seeds the persisted OUTPUT
 * and lets the spec drive the real read route + the real React rendering.
 *
 * Usage:
 *   tsx server/scripts/e2e-seed-impact-routines.ts <projectId>
 *
 * Outputs JSON:
 *   { analysisId, projectId, classification: {...}, affected: {...} }
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
    console.error("usage: e2e-seed-impact-routines.ts <projectId>");
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
    const user = await prisma.user.findFirst({ where: { username: "admin" } });
    if (!user) {
      throw new Error("No admin user found — run primeAdminUser first");
    }

    const tableEvidence: SeededEvidence[] = [
      {
        edgeKind: "reads",
        source: "mybatis",
        fromQualifiedName: "com.acme.OrderMapper.findById",
        reconciliation: "matched",
      },
    ];
    // A procedure that IS invoked from code → classified `used`.
    const procEvidence: SeededEvidence[] = [
      {
        edgeKind: "writes",
        source: "mybatis",
        fromQualifiedName: "com.acme.OrderMapper.recalcTotals",
        reconciliation: "matched",
      },
    ];

    // ── 1. ImpactAnalysis + ImpactItem with affected tables AND routines. ──
    //
    // The affected-objects list mixes one table with one procedure + one
    // function. Routine rows carry a verify-only note in `suggestedDdl` and use
    // `changeKind = reference` — there is deliberately NO drop/alter DDL.
    const analysis = await prisma.impactAnalysis.create({
      data: {
        status: "completed",
        sourceText: "e2e impact-routines seed",
        summary: "Seeded impact analysis surfacing procedures & functions (#302)",
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
              affectedTables: {
                create: [
                  // A plain table — proves routines render *alongside* tables.
                  {
                    objectKind: "table",
                    tableName: "public.orders",
                    columnName: null,
                    columnType: null,
                    changeKind: "alter-column",
                    suggestedDdl: "ALTER TABLE public.orders ADD COLUMN note text;",
                    source: "live-db",
                    reconciliation: "matched",
                    confidence: 0.9,
                  },
                  // A stored procedure surfaced as an affected routine. The note
                  // is verify-only — NOT a drop/alter statement.
                  {
                    objectKind: "procedure",
                    tableName: "public.recalc_order_totals",
                    columnName: null,
                    columnType: null,
                    changeKind: "reference",
                    suggestedDdl:
                      "-- Verify only: procedure body is not analysed in Phase 2. Review manually.",
                    source: "live-db",
                    reconciliation: "matched",
                    confidence: 0.6,
                  },
                  // A function surfaced as an affected routine.
                  {
                    objectKind: "function",
                    tableName: "public.fn_order_discount",
                    columnName: null,
                    columnType: null,
                    changeKind: "reference",
                    suggestedDdl:
                      "-- Verify only: function body is not analysed in Phase 2. Review manually.",
                    source: "live-db",
                    reconciliation: "matched",
                    confidence: 0.6,
                  },
                ],
              },
            },
          ],
        },
      },
      select: { id: true },
    });

    // ── 2. Usage classification rows including routines. ──────────────────
    //
    // A table (used) + a procedure (used) + a function (uncertain because its
    // body is unanalysed). This proves routines flow through the same
    // used/unreferenced/uncertain UI and that an unanalysed routine body is
    // `uncertain` — never auto-recommended for dropping.
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
          evidence: JSON.stringify(tableEvidence),
          overriddenClass: null,
        },
        {
          projectId,
          kind: "procedure",
          tableName: "public.recalc_order_totals",
          columnName: null,
          columnType: null,
          usageClass: "used",
          uncertainReason: null,
          evidence: JSON.stringify(procEvidence),
          overriddenClass: null,
        },
        {
          projectId,
          kind: "function",
          tableName: "public.fn_order_discount",
          columnName: null,
          columnType: null,
          usageClass: "uncertain",
          uncertainReason: "routine-body-unanalyzed",
          evidence: JSON.stringify([]),
          overriddenClass: null,
        },
      ],
    });

    console.log(
      JSON.stringify({
        analysisId: analysis.id,
        projectId,
        classification: { table: 1, procedureUsed: 1, functionUncertain: 1 },
        affected: { tables: 1, procedures: 1, functions: 1 },
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
