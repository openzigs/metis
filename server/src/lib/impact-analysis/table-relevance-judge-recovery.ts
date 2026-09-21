/**
 * Issue #1029 — the RECOVERY PASS that turns the column-informed table-relevance
 * judge (table-relevance-judge.ts) into `AffectedTableInput` rows the impact engine
 * can merge.
 *
 * Given the tables the deterministic crossing (+ the #936 filter) already surfaced
 * and the project full table->columns catalog, it forms the UNSURFACED complement,
 * asks the judge which of those the requirement genuinely affects (strict,
 * column-informed, self-consistency-voted), and returns the picks as `possible`-tier
 * rows tagged `source: "llm-recovery"`. RECOVERY-ONLY by construction: it can only
 * ADD a missed table, never remove or demote a surfaced one, so it cannot lower the
 * table precision of the set already on screen.
 */
import type { PrismaClient } from "@prisma/client";
import type { AIProvider } from "../ai/types.js";
import type { AffectedTableInput } from "./schema-impact.js";
import {
  judgeRelevantTables,
  type JudgeCandidate,
  type TableJudgeOptions,
} from "./table-relevance-judge.js";

/** One project table and its column names (the judge disambiguating signal). */
export interface CatalogTable {
  tableName: string;
  columns: string[];
}

/** Compare key mirroring the crossing table identity: lowercased last dotted segment. */
function tableKey(name: string): string {
  return name.slice(name.lastIndexOf(".") + 1).toLowerCase();
}

/** Modest confidence for a recovered `possible`-tier table (above the #936 secondary cap 0.2). */
export const RECOVERY_CONFIDENCE = 0.5;

/**
 * Recovery runs ONLY when the deterministic crossing surfaced NO primary table (the
 * engine gates it), i.e. exactly the #1029 TOTAL-MISS case a business-vocabulary
 * requirement produces. That gate is what protects table precision: on requirements
 * the crossing already covers, the judge never runs, so it cannot add a tangential
 * table (measured: an ungated judge over-fired `item` on "category management",
 * costing ~0.05 macro precision). With the gate removing the precision pressure,
 * recovery votes with a PERMISSIVE majority-of-5 to maximise recall on the miss it
 * does handle (4-of-5 was too strict — it recovered `account` but lost the
 * weaker-matching `orders` for the loyalty requirement).
 */
export const RECOVERY_SAMPLES = 5;
export const RECOVERY_VOTE_THRESHOLD = 3;

/**
 * Recover genuinely-affected tables the crossing missed. Returns `possible`-tier
 * `AffectedTableInput` rows for the judge picks; empty on passthrough (flag off /
 * provider offline / nothing unsurfaced / judge selects nothing). Never throws.
 */
export async function recoverAffectedTables(args: {
  requirementText: string;
  surfacedTableNames: string[];
  catalog: CatalogTable[];
  provider: AIProvider | null | undefined;
  options?: TableJudgeOptions;
}): Promise<AffectedTableInput[]> {
  const { requirementText, surfacedTableNames, catalog, provider, options } = args;
  try {
    const surfaced = new Set(surfacedTableNames.map(tableKey));
    // Candidates = tables NOT already on screen, each carrying its columns.
    const candidates: JudgeCandidate[] = catalog
      .filter((t) => !surfaced.has(tableKey(t.tableName)))
      .map((t) => ({ tableName: t.tableName, columns: t.columns }));
    if (candidates.length === 0) return [];

    const result = await judgeRelevantTables(requirementText, candidates, provider, {
      samples: RECOVERY_SAMPLES,
      voteThreshold: RECOVERY_VOTE_THRESHOLD,
      ...options,
    });
    if (!result.applied || result.selected.length === 0) return [];

    return result.selected.map((d) => ({
      objectKind: "table" as const,
      tableName: d.tableName,
      columnName: null,
      columnType: null,
      changeKind: "reference" as const,
      suggestedDdl: null,
      source: "llm-recovery" as const,
      reconciliation: null,
      confidence: RECOVERY_CONFIDENCE,
      relevanceTier: "possible" as const,
      relevanceRationale:
        d.rationale && d.rationale.trim().length > 0
          ? d.rationale
          : "Recovered by the column-informed relevance judge: the requirement's data maps to this table's own columns.",
    }));
  } catch {
    // Recovery is a best-effort enrichment; a fault degrades to no recovery.
    return [];
  }
}

/**
 * Load a project table->columns catalog from the schema graph (`code_symbols` rows of
 * kind `table` + `column`), memoized per project so a run over many requirements queries
 * once. A column groups under its parent via `columnQualifiedName` shape (`<table-qn>.<col>`),
 * the same identity the schema-graph writer emits — so schema-qualified names group correctly.
 */
export function buildPrismaTableCatalogLoader(
  prisma: Pick<PrismaClient, "codeSymbol">,
): (projectId: string) => Promise<CatalogTable[]> {
  const cache = new Map<string, Promise<CatalogTable[]>>();
  return (projectId: string) => {
    let pending = cache.get(projectId);
    if (!pending) {
      pending = (async () => {
        const rows = await prisma.codeSymbol.findMany({
          where: { projectId, kind: { in: ["table", "column"] } },
          select: { name: true, qualifiedName: true, kind: true },
        });
        const columnsByTable = new Map<string, string[]>();
        const tableRows: { name: string; qualifiedName: string }[] = [];
        for (const r of rows) {
          if (r.kind === "column") {
            const dot = r.qualifiedName.lastIndexOf(".");
            if (dot <= 0) continue;
            const parent = r.qualifiedName.slice(0, dot);
            const arr = columnsByTable.get(parent) ?? [];
            arr.push(r.name);
            columnsByTable.set(parent, arr);
          } else {
            tableRows.push({ name: r.name, qualifiedName: r.qualifiedName });
          }
        }
        return tableRows.map((t) => ({
          tableName: t.name,
          columns: columnsByTable.get(t.qualifiedName) ?? [],
        }));
      })();
      cache.set(projectId, pending);
    }
    return pending;
  };
}
