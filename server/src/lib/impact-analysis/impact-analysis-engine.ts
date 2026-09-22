/**
 * Multi-project requirement-change → code-impact engine — Epic #159 (#162).
 *
 * Orchestrates the headline capability: take a requirements-change document
 * (or pasted text) plus TWO OR MORE projects, and for every changed
 * requirement compute the per-project code impact — the directly affected
 * symbols (via the #161 mapper) plus the transitive blast radius (via #162's
 * graph traversal).
 *
 * The change scorers (`titleSimilarity`, `computeSeverity`,
 * `computeImpactScore`) are reused as-is from the change-analysis engine so
 * behavior stays consistent and that engine's tests stay green.
 *
 * Every collaborator is dependency-injected so the core
 * (`computeProjectImpact`) is unit-testable with no LLM, embeddings, or DB.
 */
import type { PrismaClient } from "@prisma/client";
import {
  deriveMatchQualityDetailed,
  type ImpactAffectedRelation,
  type MatchQuality,
  type MatchQualityReason,
} from "@metis/shared";
import { prisma as defaultPrisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import { jobEvents, genericFailureMessage } from "../socket/job-events.js";
import { computeImpactScore, computeSeverity } from "../change-analysis/change-analysis-engine.js";
import {
  mapRequirementToCode,
  type RequirementCodeMatch,
} from "../traceability/requirement-code-mapping.js";
import type { CodeGraphDataSource, GraphEdge, GraphSymbol } from "../code-graph/query-service.js";
import { randomUUID } from "node:crypto";
import { blastRadius, type RadiusSymbol } from "./blast-radius.js";
import {
  crossToSchema,
  PrismaSchemaImpactDataSource,
  type AffectedTableInput,
  type CrossProjectIdentityResolver,
  type SchemaImpactDataSource,
} from "./schema-impact.js";
import {
  buildImpactIdentityResolver,
  resolveAffectedTableConsumers,
  type AffectedTableConsumers,
} from "./impact-consumers.js";
import type { ConsumersPrisma } from "../analysis/affected-schema-consumers.js";
import { classifyDdlRisk } from "./ddl-risk-classifier.js";
import { enterImpactProjectScope, runInImpactProjectScope } from "./impact-llm-scope.js";
import type { TableRelevanceFilterResult } from "./table-relevance-filter.js";
import type { ClauseCoverageGap } from "./clause-coverage-reconciler.js";
import { rankItemTables } from "./impact-summarizer.js";
import type {
  ImpactSummarizer,
  ImpactItemFacts,
  RunItemFact,
  SummaryTableFact,
} from "./impact-summarizer.js";
import type { LiveSchemaIndex } from "./live-schema-ingest.js";
import {
  heuristicChangeExtractor,
  type ChangedRequirement,
  type ChangeExtractor,
  type ChangeType,
} from "./extract-changes.js";

const log = createChildLogger("impact-analysis");

export class ImpactAnalysisError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ImpactAnalysisError";
  }
}

// ---- Core result shapes ----------------------------------------------------

export interface AffectedSymbolResult {
  codeSymbolId: string | null;
  filePath: string;
  qualifiedName: string;
  startLine: number | null;
  endLine: number | null;
  relation: ImpactAffectedRelation;
  depth: number;
  confidence: number;
}

export interface ProjectImpactResult {
  projectId: string;
  requirementId: string | null;
  changeType: ChangeType;
  severity: "critical" | "high" | "medium" | "low";
  impactScore: number;
  confidence: number;
  /**
   * #961 — deterministic requirement→code match quality (`strong`/`moderate`/
   * `weak`) from the seed-match confidences. Fed into the #932 summarizer facts so
   * a weak match narrates its caveat; the read path re-derives the same value from
   * the persisted direct-symbol confidences (no migration).
   */
  matchQuality: MatchQuality;
  /** #994 — WHY `matchQuality` is `weak` (`null` otherwise). See shared `MatchQualityReason`. */
  matchQualityReason: MatchQualityReason;
  affectedFileCount: number;
  affectedSymbolCount: number;
  affectedSymbols: AffectedSymbolResult[];
  affectedTables: AffectedTableInput[];
  /**
   * #936 — tables the LLM relevance filter judged `unlikely` and PRUNED from the
   * primary `affectedTables` set (precision), retained here at reduced confidence
   * so a BA still sees them (recall safety). Empty when the filter did not run
   * (flag off / provider offline / malformed output ⇒ deterministic passthrough).
   */
  affectedTablesSecondary: AffectedTableInput[];
  /**
   * #1005 — CLAUSE-vs-IMPACT reconciliation advisories: obligations in the
   * requirement that none of the surfaced tables appear to cover, each naming a
   * REAL project table that was not surfaced. ADVISORY ONLY — these never enter
   * `affectedTables`/`affectedTablesSecondary`, so they cannot move table
   * recall/precision. Empty when the reconciler did not run (flag off / provider
   * offline / malformed output ⇒ deterministic passthrough) or found no gap.
   */
  coverageGaps: ClauseCoverageGap[];
}

export const DEFAULT_MAX_DEPTH = 2;

type MapRequirementFn = (
  req: { id: string; title: string; body: string },
  projectId: string,
) => Promise<RequirementCodeMatch[]>;

export interface ComputeImpactDeps {
  mapRequirement: MapRequirementFn;
  dataSourceFor: (projectId: string) => CodeGraphDataSource;
  maxDepth?: number;
  /** When set (and `includeSchemaImpact` is true), cross the blast radius into the schema graph. */
  schemaDataSourceFor?: (projectId: string) => SchemaImpactDataSource;
  /**
   * #936 — optional OUTPUT relevance filter run AFTER the crossing. Given the
   * requirement text + the crossed `affectedTables`, it prunes tangential
   * (`unlikely`) tables from the primary set into a secondary bucket. Injected so
   * the engine stays LLM-free/deterministic when absent; must never throw (its
   * own contract) and is additionally guarded here.
   */
  tableRelevanceFilter?: (
    requirementText: string,
    tables: AffectedTableInput[],
  ) => Promise<TableRelevanceFilterResult>;
  /**
   * #1001 — optional LLM ADDITIVE-COLUMN proposer run after the crossing (and
   * after the #936 filter, so it only ever proposes on tables that survived into
   * the PRIMARY set). Returns NEW `add-column` rows grounded in those tables;
   * the engine appends them and never lets it rewrite a deterministic row.
   * Injected so the engine stays LLM-free/deterministic when absent; must never
   * throw (its own contract) and is additionally guarded here.
   */
  additiveColumnProposer?: (
    requirementText: string,
    tables: AffectedTableInput[],
  ) => Promise<AffectedTableInput[]>;
  /**
   * #1005 — optional CLAUSE-vs-IMPACT reconciler run LAST, once the surfaced set
   * is final. Given the requirement text plus every table on screen (primary AND
   * the #936 secondary bucket), it names requirement obligations that none of
   * those tables cover, grounded in the project's OTHER real tables. Its output is
   * ADVISORY: the engine puts it on `coverageGaps` and feeds it to the #932
   * summarizer, and never merges it into the affected-table sets. Injected so the
   * engine stays LLM-free/deterministic when absent; must never throw (its own
   * contract) and is additionally guarded here.
   */
  clauseCoverageReconciler?: (
    requirementText: string,
    projectId: string,
    surfacedTableNames: string[],
  ) => Promise<ClauseCoverageGap[]>;
  /**
   * #1029 — optional column-informed table-relevance RECOVERY judge, run after the
   * #936 filter over the FINAL surfaced set. Given the requirement text + every
   * table already on screen (primary + secondary), it returns `possible`-tier rows
   * for genuinely-affected tables the crossing MISSED (recovered because the
   * requirement data maps to their OWN columns). RECOVERY-ONLY: its rows merge into
   * the PRIMARY set and it never removes/demotes a surfaced table, so it can only
   * raise recall. Injected so the engine stays deterministic when absent; must never
   * throw (its own contract) and is guarded here.
   */
  tableRecoveryJudge?: (
    requirementText: string,
    projectId: string,
    surfacedTableNames: string[],
  ) => Promise<AffectedTableInput[]>;
  /** Live schema index (per project) for reconciliation + column types. */
  liveIndexFor?: (projectId: string) => LiveSchemaIndex | null;
  includeSchemaImpact?: boolean;
  /**
   * Epic #954 (#956) — canonical cross-project identity resolver threaded into
   * {@link crossToSchema}. When provided (the analyzed project is linked to a
   * shared {@link DatabaseResource}), each affected row is associated with its
   * {@link SchemaObjectIdentity} id. Null/absent ⇒ no identity linking (the
   * single-project path is unchanged).
   */
  identityResolver?: CrossProjectIdentityResolver | null;
  /**
   * #922 — when true (the default when schema impact runs), an impacted mapper/DAO
   * method also surfaces the tables touched by its SIBLING methods, at reduced
   * confidence. Set false to restrict crossing to method-granular results only.
   */
  expandDaoSiblings?: boolean;
  /**
   * When true, the blast radius also walks downstream dependencies (what the
   * changed code uses). Default false — callers/importers only. See
   * {@link blastRadius}.
   */
  includeDependencies?: boolean;
  /** Confidence floor for emitted blast-radius symbols. Defaults in {@link blastRadius}. */
  minConfidence?: number;
}

/**
 * Compute the impact of a single changed requirement on a single project.
 * Pure orchestration over injected collaborators — no DB writes.
 */
export async function computeProjectImpact(
  change: ChangedRequirement,
  projectId: string,
  deps: ComputeImpactDeps,
): Promise<ProjectImpactResult> {
  const maxDepth = deps.maxDepth ?? DEFAULT_MAX_DEPTH;

  const matches = await deps.mapRequirement(
    { id: change.requirementId ?? "", title: change.title, body: change.body },
    projectId,
  );

  const topConfidence = matches.reduce((m, c) => Math.max(m, c.confidence), 0);

  // Direct hits (depth 0).
  const direct: AffectedSymbolResult[] = matches.map((m) => ({
    codeSymbolId: m.codeSymbolId,
    filePath: m.filePath,
    qualifiedName: m.qualifiedName,
    startLine: m.startLine,
    endLine: m.endLine,
    relation: "direct" as const,
    depth: 0,
    confidence: m.confidence,
  }));

  // Transitive blast radius from the resolved seed symbols.
  const seedIds = matches.map((m) => m.codeSymbolId).filter((id): id is string => Boolean(id));

  let radius: RadiusSymbol[] = [];
  if (seedIds.length > 0) {
    radius = await blastRadius(deps.dataSourceFor(projectId), seedIds, {
      maxDepth,
      seedConfidence: topConfidence || 1,
      // Callers/importers only by default; downstream deps are opt-in.
      includeDependencies: deps.includeDependencies ?? false,
      // Let blastRadius apply its own default floor when undefined.
      minConfidence: deps.minConfidence,
    });
  }

  // Merge + dedupe (direct wins over radius).
  const byKey = new Map<string, AffectedSymbolResult>();
  for (const d of direct) {
    byKey.set(d.codeSymbolId ?? `path:${d.qualifiedName}`, d);
  }
  for (const r of radius) {
    if (!byKey.has(r.codeSymbolId)) {
      byKey.set(r.codeSymbolId, {
        codeSymbolId: r.codeSymbolId,
        filePath: r.filePath,
        qualifiedName: r.qualifiedName,
        startLine: r.startLine,
        endLine: r.endLine,
        relation: r.relation,
        depth: r.depth,
        confidence: r.confidence,
      });
    }
  }

  const affectedSymbols = [...byKey.values()].sort(
    (a, b) => a.depth - b.depth || b.confidence - a.confidence,
  );
  const fileSet = new Set(affectedSymbols.map((s) => s.filePath));

  // #961 — grade how well the requirement SEEDED into code from the DEDUPED
  // direct (depth-0) match confidences. Deriving over the merged/deduped direct
  // set — the exact rows persisted per item — makes the engine and the read path
  // agree byte-for-byte by CONSTRUCTION: the read path re-derives from those same
  // persisted direct symbols (`relation === "direct"`). A mapper emitting
  // duplicate seed ids, or null-id same-`qualifiedName` collisions, can no longer
  // diverge the two derivations (they collapse identically in both places).
  const { quality: matchQuality, reason: matchQualityReason } = deriveMatchQualityDetailed(
    affectedSymbols
      .filter((s) => s.relation === "direct")
      .map((s) => ({ confidence: s.confidence, filePath: s.filePath })),
  );

  const severity = computeSeverity(
    change.changeType,
    change.bodyDelta,
    Boolean(change.priorityChanged),
    Boolean(change.typeChanged),
  );
  const impactScore = computeImpactScore(
    change.changeType,
    severity,
    Boolean(change.hasChildren),
    change.bodyDelta,
  );

  // Cross the blast radius into the schema graph (opt-in, best-effort — a
  // schema-graph failure must never sink the code-impact result).
  let affectedTables: AffectedTableInput[] = [];
  let affectedTablesSecondary: AffectedTableInput[] = [];
  if (deps.includeSchemaImpact !== false && deps.schemaDataSourceFor) {
    const impactedIds = affectedSymbols
      .map((s) => s.codeSymbolId)
      .filter((id): id is string => Boolean(id));
    try {
      affectedTables = await crossToSchema(
        impactedIds,
        deps.schemaDataSourceFor(projectId),
        deps.liveIndexFor?.(projectId) ?? null,
        // Epic #954 (#956) — link affected rows to their canonical cross-project
        // identity when the analyzed project is linked to a shared resource.
        deps.identityResolver ?? null,
        {
          // #922 — DAO/mapper sibling expansion is on by default when crossing runs
          // (reduced-confidence, marked rows); callers can opt out explicitly.
          expandDaoSiblings: deps.expandDaoSiblings ?? true,
          // #923 — feed the requirement text so an add-a-field requirement yields a
          // TEXT-ONLY ADD COLUMN suggestion even for source-only projects (no live DB).
          requirementText: `${change.title}\n${change.body}`,
        },
      );
    } catch (err) {
      log.warn("schema impact crossing failed", { projectId, error: String(err) });
    }

    // #936 — OUTPUT relevance filter: prune tangential (`unlikely`) tables into a
    // secondary bucket to raise precision without destroying the #928 recall win.
    // Best-effort: the filter never throws (its own contract), but guard anyway so
    // a filter fault degrades to the un-filtered crossing, never sinks the result.
    if (deps.tableRelevanceFilter && affectedTables.length > 0) {
      try {
        const filtered = await deps.tableRelevanceFilter(
          `${change.title}\n${change.body}`,
          affectedTables,
        );
        affectedTables = filtered.primary;
        affectedTablesSecondary = filtered.secondary;
      } catch (err) {
        log.warn("table relevance filter failed; keeping unfiltered crossing", {
          projectId,
          error: String(err),
        });
      }
    }

    // #1001 — ADDITIVE-COLUMN proposals. The #923 regex fast path only fires for a
    // developer imperative ("add a status flag to account"); a business analyst
    // writes obligations ("a cancelled order must record who cancelled it and
    // when") and got only `-- Verify column …` noise. The proposer asks the model
    // which NEW columns the requirement implies, grounded in the tables ALREADY in
    // this result — so it can only ever APPEND `add-column` rows to tables the
    // deterministic crossing surfaced. Runs after the #936 filter so nothing is
    // proposed on a table judged tangential. Best-effort: the proposer never
    // throws (its own contract), but guard anyway.
    if (deps.additiveColumnProposer && affectedTables.length > 0) {
      try {
        const proposed = await deps.additiveColumnProposer(
          `${change.title}\n${change.body}`,
          affectedTables,
        );
        if (proposed.length > 0) {
          // Same ordering the crossing itself emits (table, then column), so the
          // proposals interleave with their table's existing rows.
          affectedTables = [...affectedTables, ...proposed].sort(
            (a, b) =>
              a.tableName.localeCompare(b.tableName) ||
              (a.columnName ?? "").localeCompare(b.columnName ?? ""),
          );
        }
      } catch (err) {
        log.warn("additive column proposer failed; keeping crossing output", {
          projectId,
          error: String(err),
        });
      }
    }

    // #1029 — column-informed RECOVERY judge, GATED to the total-miss case: it runs
    // ONLY when the crossing + #936 filter surfaced NO primary table, which is exactly
    // the business-vocabulary requirement it exists for (a loyalty requirement naming
    // `account` only as "saved billing and delivery details"). Confining it to that
    // case is what protects precision — on an already-covered requirement the judge
    // would occasionally recover a tangential table. Its `possible`-tier picks merge
    // into the primary set. Best-effort: the recovery never throws, but guard anyway.
    if (deps.tableRecoveryJudge && affectedTables.length === 0) {
      try {
        const recovered = await deps.tableRecoveryJudge(
          `${change.title}\n${change.body}`,
          projectId,
          [...affectedTables, ...affectedTablesSecondary].map((t) => t.tableName),
        );
        if (recovered.length > 0) {
          affectedTables = [...affectedTables, ...recovered].sort(
            (a, b) =>
              a.tableName.localeCompare(b.tableName) ||
              (a.columnName ?? "").localeCompare(b.columnName ?? ""),
          );
        }
      } catch (err) {
        log.warn("table recovery judge failed; no recovery", {
          projectId,
          error: String(err),
        });
      }
    }
  }

  // #1005 — CLAUSE-vs-IMPACT reconciliation. Runs LAST, over the FINAL surfaced
  // set (primary + the #936 secondary bucket: a demoted table is still on screen,
  // so flagging it as a gap would be noise). Deliberately OUTSIDE the schema-impact
  // branch's table mutations: its result is an ADVISORY list that never touches
  // `affectedTables`, which is what makes it incapable of moving table
  // recall/precision. Best-effort: the reconciler never throws (its own contract),
  // but guard anyway.
  let coverageGaps: ClauseCoverageGap[] = [];
  if (deps.clauseCoverageReconciler) {
    try {
      coverageGaps = await deps.clauseCoverageReconciler(
        `${change.title}\n${change.body}`,
        projectId,
        [...affectedTables, ...affectedTablesSecondary].map((t) => t.tableName),
      );
    } catch (err) {
      log.warn("clause coverage reconciliation failed; no gap advisories", {
        projectId,
        error: String(err),
      });
    }
  }

  return {
    projectId,
    requirementId: change.requirementId,
    changeType: change.changeType,
    severity,
    impactScore,
    confidence: topConfidence,
    matchQuality,
    matchQualityReason,
    affectedFileCount: fileSet.size,
    affectedSymbolCount: affectedSymbols.length,
    affectedSymbols,
    affectedTables,
    affectedTablesSecondary,
    coverageGaps,
  };
}

// ---- Prisma-backed code graph data source ----------------------------------

function toGraphSymbol(r: {
  id: string;
  qualifiedName: string;
  kind: string;
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
}): GraphSymbol {
  return {
    id: r.id,
    qualifiedName: r.qualifiedName,
    kind: r.kind,
    filePath: r.filePath,
    language: r.language,
    startLine: r.startLine,
    endLine: r.endLine,
  };
}

const SYMBOL_SELECT = {
  id: true,
  qualifiedName: true,
  kind: true,
  filePath: true,
  language: true,
  startLine: true,
  endLine: true,
} as const;

/** Code-graph edge kinds — excludes the schema kinds (reads/writes/persists-to). */
const CODE_EDGE_KINDS = ["calls", "imports", "defines", "references"] as const;

/** A `CodeGraphDataSource` scoped to one project, backed by Prisma. */
export class PrismaCodeGraphDataSource implements CodeGraphDataSource {
  constructor(
    private readonly prisma: Pick<PrismaClient, "codeSymbol" | "codeEdge">,
    private readonly projectId: string,
  ) {}

  async getSymbol(symbolId: string): Promise<GraphSymbol | null> {
    const r = await this.prisma.codeSymbol.findFirst({
      where: { id: symbolId, projectId: this.projectId },
      select: SYMBOL_SELECT,
    });
    return r ? toGraphSymbol(r) : null;
  }

  async getEdgesFrom(symbolId: string): Promise<GraphEdge[]> {
    return this.getEdgesFromMany([symbolId]);
  }

  async getEdgesTo(symbolId: string): Promise<GraphEdge[]> {
    return this.getEdgesToMany([symbolId]);
  }

  /** Batched incoming edges for many nodes (#849/#872) — one query per chunk. */
  async getEdgesToMany(symbolIds: string[]): Promise<GraphEdge[]> {
    if (symbolIds.length === 0) return [];
    const CHUNK = 500;
    const all: GraphEdge[] = [];
    for (let i = 0; i < symbolIds.length; i += CHUNK) {
      const rows = await this.prisma.codeEdge.findMany({
        where: {
          toSymbolId: { in: symbolIds.slice(i, i + CHUNK) },
          projectId: this.projectId,
          kind: { in: [...CODE_EDGE_KINDS] },
        },
        select: { id: true, fromSymbolId: true, toSymbolId: true, kind: true },
      });
      for (const e of rows) {
        all.push({
          id: e.id,
          fromSymbolId: e.fromSymbolId,
          toSymbolId: e.toSymbolId as string,
          kind: e.kind as GraphEdge["kind"],
        });
      }
    }
    return all;
  }

  /** Batched outgoing edges for many nodes (#849/#872) — one query per chunk. */
  async getEdgesFromMany(symbolIds: string[]): Promise<GraphEdge[]> {
    if (symbolIds.length === 0) return [];
    const CHUNK = 500;
    const all: GraphEdge[] = [];
    for (let i = 0; i < symbolIds.length; i += CHUNK) {
      const rows = await this.prisma.codeEdge.findMany({
        where: {
          fromSymbolId: { in: symbolIds.slice(i, i + CHUNK) },
          projectId: this.projectId,
          toSymbolId: { not: null },
          kind: { in: [...CODE_EDGE_KINDS] },
        },
        select: { id: true, fromSymbolId: true, toSymbolId: true, kind: true },
      });
      for (const e of rows) {
        all.push({
          id: e.id,
          fromSymbolId: e.fromSymbolId,
          toSymbolId: e.toSymbolId as string,
          kind: e.kind as GraphEdge["kind"],
        });
      }
    }
    return all;
  }

  async getSymbolsByFile(filePath: string): Promise<GraphSymbol[]> {
    const rows = await this.prisma.codeSymbol.findMany({
      where: { filePath, projectId: this.projectId },
      select: SYMBOL_SELECT,
    });
    return rows.map(toGraphSymbol);
  }

  async getSymbolsByIds(ids: string[]): Promise<GraphSymbol[]> {
    if (ids.length === 0) return [];
    // SQLite's parameter limit (32k) can be exceeded for large graphs — batch.
    const CHUNK = 500;
    const all: GraphSymbol[] = [];
    for (let i = 0; i < ids.length; i += CHUNK) {
      const batch = ids.slice(i, i + CHUNK);
      const rows = await this.prisma.codeSymbol.findMany({
        where: { id: { in: batch }, projectId: this.projectId },
        select: SYMBOL_SELECT,
      });
      all.push(...rows.map(toGraphSymbol));
    }
    return all;
  }
}

/**
 * In-memory `CodeGraphDataSource` built from a single bulk load of a project's
 * symbols and edges. All graph lookups become O(1) Map operations — eliminates
 * the N×changes×depth Prisma round-trips that make BFS slow on large graphs.
 */
export class InMemoryCodeGraphDataSource implements CodeGraphDataSource {
  private readonly byId: Map<string, GraphSymbol>;
  private readonly edgesFrom: Map<string, GraphEdge[]>;
  private readonly edgesTo: Map<string, GraphEdge[]>;
  private readonly byFile: Map<string, GraphSymbol[]>;

  constructor(symbols: GraphSymbol[], edges: GraphEdge[]) {
    this.byId = new Map(symbols.map((s) => [s.id, s]));
    this.byFile = new Map();
    for (const s of symbols) {
      const bucket = this.byFile.get(s.filePath);
      if (bucket) bucket.push(s);
      else this.byFile.set(s.filePath, [s]);
    }
    this.edgesFrom = new Map();
    this.edgesTo = new Map();
    for (const e of edges) {
      const from = this.edgesFrom.get(e.fromSymbolId);
      if (from) from.push(e);
      else this.edgesFrom.set(e.fromSymbolId, [e]);
      const to = this.edgesTo.get(e.toSymbolId);
      if (to) to.push(e);
      else this.edgesTo.set(e.toSymbolId, [e]);
    }
  }

  async getSymbol(symbolId: string): Promise<GraphSymbol | null> {
    return this.byId.get(symbolId) ?? null;
  }
  async getEdgesFrom(symbolId: string): Promise<GraphEdge[]> {
    return this.edgesFrom.get(symbolId) ?? [];
  }
  async getEdgesTo(symbolId: string): Promise<GraphEdge[]> {
    return this.edgesTo.get(symbolId) ?? [];
  }
  async getSymbolsByFile(filePath: string): Promise<GraphSymbol[]> {
    return this.byFile.get(filePath) ?? [];
  }
  async getSymbolsByIds(ids: string[]): Promise<GraphSymbol[]> {
    return ids.flatMap((id) => {
      const s = this.byId.get(id);
      return s ? [s] : [];
    });
  }
}

/**
 * Bulk-load all symbols and code-graph edges for a project into an
 * `InMemoryCodeGraphDataSource`. Two Prisma queries replace the thousands of
 * per-hop queries that the BFS would otherwise issue.
 */
async function loadProjectGraph(
  prisma: Pick<PrismaClient, "codeSymbol" | "codeEdge">,
  projectId: string,
): Promise<InMemoryCodeGraphDataSource> {
  const [symbolRows, edgeRows] = await Promise.all([
    prisma.codeSymbol.findMany({ where: { projectId }, select: SYMBOL_SELECT }),
    prisma.codeEdge.findMany({
      where: { projectId, kind: { in: [...CODE_EDGE_KINDS] }, toSymbolId: { not: null } },
      select: { id: true, fromSymbolId: true, toSymbolId: true, kind: true },
    }),
  ]);
  const symbols = symbolRows.map(toGraphSymbol);
  const edges: GraphEdge[] = edgeRows.map((e) => ({
    id: e.id,
    fromSymbolId: e.fromSymbolId,
    toSymbolId: e.toSymbolId as string,
    kind: e.kind as GraphEdge["kind"],
  }));
  log.debug("loaded project graph into memory", {
    projectId,
    symbols: symbols.length,
    edges: edges.length,
  });
  return new InMemoryCodeGraphDataSource(symbols, edges);
}

// ---- Service API -----------------------------------------------------------

type ImpactPrisma = Pick<
  PrismaClient,
  | "impactAnalysis"
  | "impactItem"
  | "impactAffectedSymbol"
  | "impactAffectedTable"
  | "impactAffectedTableConsumer"
  | "document"
  | "knowledgeChunk"
  | "quarantineChunk"
  | "codeSymbol"
  | "codeEdge"
>;

export interface ImpactServiceDeps {
  prisma?: ImpactPrisma;
  extractor?: ChangeExtractor;
  mapRequirement?: MapRequirementFn;
  dataSourceFor?: (projectId: string) => CodeGraphDataSource;
  maxDepth?: number;
  schemaDataSourceFor?: (projectId: string) => SchemaImpactDataSource;
  liveIndexFor?: (projectId: string) => LiveSchemaIndex | null;
  /**
   * Issue #958 — async per-project LIVE-SCHEMA introspector for reconciliation.
   * Resolved ONCE per project (immediately before that project's change loop,
   * mirroring {@link identityResolverFor}'s once-per-project preload below) so a
   * run with many changed requirements against the same project never
   * re-introspects. Best-effort: a rejection degrades to no reconciliation
   * (`liveIndexFor` resolves `null` for that project), never blocks or fails the
   * run. Ignored when `liveIndexFor` is ALSO supplied directly — callers that
   * already hand the engine a synchronous index (dogfood/test callers) keep
   * working unchanged and skip the introspection round trip entirely. Only
   * invoked when the schema-impact dimension is actually running.
   */
  liveIndexIntrospectorFor?: (projectId: string) => Promise<LiveSchemaIndex | null>;
  includeSchemaImpact?: boolean;
  /** #922 — expand mapper/DAO sibling tables (reduced confidence). Default true when crossing runs. */
  expandDaoSiblings?: boolean;
  /** When true, the blast radius also walks downstream dependencies. Default false. */
  includeDependencies?: boolean;
  /** Confidence floor for emitted blast-radius symbols. Defaults in {@link blastRadius}. */
  minConfidence?: number;
  /** #936 — optional LLM output relevance filter (flag-gated). See {@link ComputeImpactDeps.tableRelevanceFilter}. */
  tableRelevanceFilter?: ComputeImpactDeps["tableRelevanceFilter"];
  /** #1001 — optional LLM additive-column proposer (flag-gated). See {@link ComputeImpactDeps.additiveColumnProposer}. */
  additiveColumnProposer?: ComputeImpactDeps["additiveColumnProposer"];
  /** #1005 — optional LLM clause-vs-impact reconciler (flag-gated). See {@link ComputeImpactDeps.clauseCoverageReconciler}. */
  clauseCoverageReconciler?: ComputeImpactDeps["clauseCoverageReconciler"];
  /** #1029 — optional LLM column-informed table-relevance recovery judge (flag-gated). See {@link ComputeImpactDeps.tableRecoveryJudge}. */
  tableRecoveryJudge?: ComputeImpactDeps["tableRecoveryJudge"];
  /**
   * #932 — optional LLM impact summarizer (flag-gated). When injected, the engine
   * generates a BA-readable per-item narrative + a run-level overview POST-HOC,
   * after the impact computation + #936 relevance filter. Strictly non-blocking:
   * the summarizer never throws (its own contract) and is additionally guarded
   * here so a summary fault never sinks the deterministic result.
   */
  impactSummarizer?: ImpactSummarizer;
  /**
   * Epic #954 (#956) — per-project factory for the cross-project identity
   * resolver threaded into {@link crossToSchema}. Defaults to
   * {@link buildImpactIdentityResolver} over the engine's Prisma. Returning null
   * (no linked resource) leaves affected rows unlinked (unchanged behaviour).
   * Injectable so tests drive identity linking without a live workspace.
   */
  identityResolverFor?: (projectId: string) => Promise<CrossProjectIdentityResolver | null>;
  /**
   * Epic #954 (#956) — resolve the cross-project shared-table CONSUMER set for an
   * item's affected tables (identity → string-match → could-not-verify).
   * Defaults to {@link resolveAffectedTableConsumers} over the engine's Prisma.
   * Best-effort: guarded so a consumer-resolution fault never sinks the
   * deterministic result. Injectable for tests.
   */
  consumerResolver?: (input: {
    projectId: string;
    affected: AffectedTableInput[];
  }) => Promise<AffectedTableConsumers[]>;
  /**
   * #1024 — end-of-run disclosure hook. Returns one plain sentence when the LLM
   * stages were requested but produced nothing (no provider configured, provider
   * error, provider timeout), or `null` when there is nothing to disclose. The
   * engine appends it to the persisted `summary` so a BA can never mistake an
   * un-enriched deterministic result for an enriched one. Absent ⇒ no notice
   * (every existing caller and test is unchanged).
   */
  llmDegradationNotice?: () => string | null;
}

export interface TriggerImpactAnalysisInput {
  projectIds: string[];
  documentId?: string | null;
  text?: string | null;
  actorId: string;
  /**
   * Issue #965 (Epic #960) — when set, this run is a DRIFT re-run of the referenced
   * original run: it reuses that run's source verbatim and links back via
   * `rerunOfId` so the differ can compare the two. Null/absent ⇒ an original run.
   * The referenced run is NEVER mutated (originals are immutable).
   */
  rerunOfId?: string | null;
  includeSchemaImpact?: boolean;
  /** #922 — expand mapper/DAO sibling tables (reduced confidence). Default true when crossing runs. */
  expandDaoSiblings?: boolean;
  /** When true, the blast radius also walks downstream dependencies. Default false. */
  includeDependencies?: boolean;
}

function resolvePrisma(deps: ImpactServiceDeps): ImpactPrisma {
  return (deps.prisma ?? (defaultPrisma as unknown as ImpactPrisma)) as ImpactPrisma;
}

/**
 * Create a pending `ImpactAnalysis` and kick off async execution. Returns the
 * pending row immediately so the route can answer 202 and the UI can poll.
 */
export async function triggerImpactAnalysis(
  input: TriggerImpactAnalysisInput,
  deps: ImpactServiceDeps = {},
): Promise<{ id: string; status: string }> {
  const prisma = resolvePrisma(deps);
  if (input.projectIds.length === 0) {
    throw new ImpactAnalysisError(400, "NO_PROJECTS", "At least one projectId is required");
  }
  if (!input.documentId && !input.text) {
    throw new ImpactAnalysisError(400, "NO_SOURCE", "Either documentId or text is required");
  }

  const projectIds = [...new Set(input.projectIds)];

  const row = await prisma.impactAnalysis.create({
    data: {
      status: "pending",
      documentId: input.documentId ?? null,
      sourceText: input.text ?? null,
      startedById: input.actorId,
      // #965 — drift lineage: point back at the original run (null for originals).
      rerunOfId: input.rerunOfId ?? null,
      // #70 — record the selection HERE, in the same write as the run. The
      // executor below is fire-and-forget and `ImpactItem` rows arrive much
      // later (or never), so a run whose projects were only passed to the
      // executor belonged to no project for the whole time it was running.
      projects: { create: projectIds.map((projectId) => ({ projectId })) },
    },
  });

  void executeImpactAnalysis(row.id, projectIds, {
    ...deps,
    includeSchemaImpact: input.includeSchemaImpact ?? deps.includeSchemaImpact,
    expandDaoSiblings: input.expandDaoSiblings ?? deps.expandDaoSiblings,
    includeDependencies: input.includeDependencies ?? deps.includeDependencies,
  }).catch((err) => {
    log.error("impact analysis execution failed", { id: row.id, error: String(err) });
  });

  return { id: row.id, status: row.status };
}

/** Resolve the change source text from the row (inline text or document chunks). */
async function resolveSourceText(
  prisma: ImpactPrisma,
  row: { sourceText: string | null; documentId: string | null },
): Promise<string> {
  if (row.sourceText && row.sourceText.trim().length > 0) return row.sourceText;
  if (row.documentId) {
    const chunks = await prisma.knowledgeChunk.findMany({
      where: { documentId: row.documentId },
      orderBy: { position: "asc" },
      select: { text: true },
    });
    if (chunks.length > 0) return chunks.map((c) => c.text).join("\n\n");
    // Fall back to quarantined chunks: a user-selected document drives impact
    // analysis regardless of RAG approval state (quarantine governs knowledge-
    // base searchability, not whether the user may analyze a chosen document).
    const quarantined = await prisma.quarantineChunk.findMany({
      where: { documentId: row.documentId, ord: { gte: 0 } },
      orderBy: { ord: "asc" },
      select: { text: true },
    });
    return quarantined.map((c) => c.text).join("\n\n");
  }
  return "";
}

/** #932 — project a crossed affected-table row into a summarizer fact. */
function toSummaryTableFact(t: AffectedTableInput): SummaryTableFact {
  return {
    tableName: t.tableName,
    columnName: t.columnName,
    changeKind: t.changeKind,
    suggestedDdl: t.suggestedDdl,
    source: t.source,
    confidence: t.confidence,
    relevanceTier: t.relevanceTier ?? null,
    relevanceRationale: t.relevanceRationale ?? null,
  };
}

/**
 * Execute an impact-analysis run: extract changes, map each to code in every
 * requested project, expand the blast radius, and persist per-project results.
 */
export async function executeImpactAnalysis(
  id: string,
  projectIds: string[],
  deps: ImpactServiceDeps = {},
): Promise<void> {
  // #1021 — open ONE attribution scope for the whole run. The per-project
  // transitions inside `runImpactAnalysis` use `enterImpactProjectScope`, which
  // only re-points the store that this call established; wrapping here is what
  // stops those transitions escaping into the caller's async context.
  return runInImpactProjectScope(null, () => runImpactAnalysis(id, projectIds, deps));
}

async function runImpactAnalysis(
  id: string,
  projectIds: string[],
  deps: ImpactServiceDeps = {},
): Promise<void> {
  const prisma = resolvePrisma(deps);
  const extractor = deps.extractor ?? heuristicChangeExtractor;
  const mapRequirement: MapRequirementFn =
    deps.mapRequirement ?? ((req, projectId) => mapRequirementToCode(req, projectId));
  const schemaDataSourceFor =
    deps.includeSchemaImpact === false
      ? undefined
      : (deps.schemaDataSourceFor ??
        ((projectId: string) => new PrismaSchemaImpactDataSource(prisma, projectId)));

  // Epic #954 (#956) — cross-project identity linking + consumer resolution.
  // Both default to the Prisma-backed implementations ONLY when the schema
  // dimension runs; a schema-impact-off run neither links identities nor resolves
  // consumers (behaviour unchanged). Tests inject their own to drive the two
  // tiers without a live workspace.
  const schemaImpactOn = deps.includeSchemaImpact !== false && schemaDataSourceFor !== undefined;
  const consumersPrisma = prisma as unknown as ConsumersPrisma;
  const identityResolverFor =
    deps.identityResolverFor ??
    (schemaImpactOn
      ? (projectId: string) => buildImpactIdentityResolver(projectId, consumersPrisma)
      : undefined);
  const consumerResolver =
    deps.consumerResolver ??
    (schemaImpactOn
      ? (input: { projectId: string; affected: AffectedTableInput[] }) =>
          resolveAffectedTableConsumers(input, consumersPrisma)
      : undefined);

  const row = await prisma.impactAnalysis.findFirst({ where: { id } });
  if (!row) throw new ImpactAnalysisError(404, "NOT_FOUND", "Impact analysis not found");

  await prisma.impactAnalysis.update({ where: { id }, data: { status: "running" } });
  // #239 — impact analysis spans many projects, so the job event carries a null
  // projectId and is delivered only on the `job:{id}` room.
  jobEvents.started("impact-analysis", id, null, "Analyzing impact");

  try {
    const text = await resolveSourceText(prisma, row);
    const changes = await extractor.extract(text);

    let totalImpactedSymbols = 0;
    // #932 — per-item roll-ups fed into the run-level BA overview (best-effort).
    const runItems: RunItemFact[] = [];

    for (let pIdx = 0; pIdx < projectIds.length; pIdx++) {
      const projectId = projectIds[pIdx];
      // #1021 — every LLM stage invoked below (seeder, table filter, additive-DDL
      // proposer, clause reconciler, per-item narrative) bills its tokens to THIS
      // project. The stages receive no projectId argument, so the scope is how the
      // metering decorator learns it.
      enterImpactProjectScope(projectId);
      jobEvents.progress(
        "impact-analysis",
        id,
        null,
        Math.round((pIdx / Math.max(projectIds.length, 1)) * 100),
        `Project ${pIdx + 1}/${projectIds.length}`,
      );
      // Pre-load the entire code graph for this project into memory once.
      // This replaces N×changes×depth individual Prisma queries with 2 bulk
      // loads + O(1) Map lookups for every BFS hop across all changes.
      const projectGraph = deps.dataSourceFor
        ? deps.dataSourceFor(projectId)
        : await loadProjectGraph(prisma, projectId);
      const dataSourceForProject = (_id: string) => projectGraph;

      // Epic #954 (#956) — build the identity resolver ONCE per project (a single
      // preload of the project's resource identities). Best-effort: a build fault
      // degrades to no identity linking, never sinks the run.
      let identityResolver: CrossProjectIdentityResolver | null = null;
      if (identityResolverFor) {
        try {
          identityResolver = await identityResolverFor(projectId);
        } catch (err) {
          log.warn("impact identity resolver build failed; no identity linking", {
            projectId,
            error: String(err),
          });
        }
      }

      // Issue #958 — resolve the live-schema reconciliation index ONCE per
      // project (same once-per-project preload pattern as the identity resolver
      // above), so a run with many changed requirements against this project
      // never re-introspects the connector. Only introspects when the schema
      // dimension is actually running and no synchronous `liveIndexFor` was
      // injected directly (that path is for callers — dogfood/tests — that
      // already hold a ready-built index and want zero introspection). Best-
      // effort: an introspection fault degrades to no reconciliation, never
      // blocks or sinks the run.
      let liveIndex: LiveSchemaIndex | null = null;
      if (schemaImpactOn && deps.liveIndexIntrospectorFor && !deps.liveIndexFor) {
        try {
          liveIndex = await deps.liveIndexIntrospectorFor(projectId);
        } catch (err) {
          log.warn("live schema index introspection failed; proceeding without reconciliation", {
            projectId,
            error: String(err),
          });
        }
      }
      const liveIndexForProject = deps.liveIndexFor ?? (() => liveIndex);

      for (const change of changes) {
        const result = await computeProjectImpact(change, projectId, {
          mapRequirement,
          dataSourceFor: dataSourceForProject,
          maxDepth: deps.maxDepth,
          schemaDataSourceFor,
          liveIndexFor: liveIndexForProject,
          identityResolver,
          includeSchemaImpact: deps.includeSchemaImpact,
          expandDaoSiblings: deps.expandDaoSiblings,
          includeDependencies: deps.includeDependencies,
          minConfidence: deps.minConfidence,
          tableRelevanceFilter: deps.tableRelevanceFilter,
          additiveColumnProposer: deps.additiveColumnProposer,
          clauseCoverageReconciler: deps.clauseCoverageReconciler,
          tableRecoveryJudge: deps.tableRecoveryJudge,
        });

        // Skip empty (no code hits) results to keep the report focused.
        if (result.affectedSymbolCount === 0) continue;

        // #1005 — the reconciliation advisories are not persisted in their own
        // right (see docs/IMPACT_ANALYSIS_LLM_STAGES.md); they reach a BA through
        // the #932 narrative. Log them so a live run is measurable without a
        // schema change.
        if (result.coverageGaps.length > 0) {
          log.info("clause-vs-impact coverage gaps", {
            id,
            projectId,
            requirement: change.title,
            gaps: result.coverageGaps.map((g) => g.tableName),
          });
        }

        // Epic #954 (#956) — resolve the cross-project shared-table CONSUMER set
        // ONCE per item (identity → string-match → could-not-verify), reused by
        // BOTH the #932 summarizer (grounded facts) and the persistence below.
        // Best-effort: a resolution fault degrades to no consumer data.
        const allAffectedTables = [...result.affectedTables, ...result.affectedTablesSecondary];
        const consumersByTable = new Map<string, AffectedTableConsumers>();
        if (consumerResolver && allAffectedTables.length > 0) {
          try {
            const resolved = await consumerResolver({ projectId, affected: allAffectedTables });
            for (const r of resolved) consumersByTable.set(r.tableName, r);
          } catch (err) {
            log.warn("cross-project consumer resolution failed; omitting consumers", {
              id,
              projectId,
              error: String(err),
            });
          }
        }
        // #956 — flatten the resolved consumers into grounded summarizer facts (a
        // per-item list of "<project> reads/writes <table>"). Empty ⇒ the
        // narrative mentions no cross-project impact.
        const consumerFacts = [...consumersByTable.values()].flatMap((r) =>
          r.consumers.map((c) => ({
            tableName: r.tableName,
            projectName: c.projectName,
            usage: c.usage,
          })),
        );

        // #932 — POST-HOC BA-readable per-item narrative from the DETERMINISTIC
        // facts (symbols + primary/secondary tables + #936 tiers + #956 consumers).
        // Best-effort: the summarizer never throws (its own contract), but guard
        // anyway so a summary fault degrades to no narrative — never sinks the item.
        let itemSummary: string | null = null;
        if (deps.impactSummarizer) {
          try {
            const facts: ImpactItemFacts = {
              requirementTitle: change.title,
              requirementBody: change.body,
              changeType: result.changeType,
              severity: result.severity,
              impactScore: result.impactScore,
              confidence: result.confidence,
              matchQuality: result.matchQuality,
              matchQualityReason: result.matchQualityReason,
              affectedFileCount: result.affectedFileCount,
              affectedSymbolCount: result.affectedSymbolCount,
              affectedSymbols: result.affectedSymbols.map((s) => ({
                qualifiedName: s.qualifiedName,
                filePath: s.filePath,
                relation: s.relation,
                depth: s.depth,
              })),
              affectedTablesPrimary: result.affectedTables.map(toSummaryTableFact),
              affectedTablesSecondary: result.affectedTablesSecondary.map(toSummaryTableFact),
              consumers: consumerFacts,
              // #1005 — the reconciliation advisories are ENGINE facts (each table
              // name comes from this project's code graph), so the narrative may
              // state the possible incompleteness and the grounding allowlist
              // accepts those names. Empty ⇒ the prompt is byte-identical to
              // pre-#1005, which is the default (flag off).
              coverageGaps: result.coverageGaps,
            };
            const res = await deps.impactSummarizer.summarizeItem(facts);
            itemSummary = res.summary;
          } catch (err) {
            log.warn("impact item summarization failed; no narrative", {
              id,
              error: String(err),
            });
          }
        }

        runItems.push({
          requirementTitle: change.title,
          severity: result.severity,
          changeType: result.changeType,
          affectedSymbolCount: result.affectedSymbolCount,
          // #984 — hand the run-level summarizer TABLE-granular facts ranked by
          // #936 relevance tier, not the raw per-column rows: a tangential table
          // with many referenced columns must not lead the executive overview
          // while the per-table view (#950) sorts it last.
          primaryTables: rankItemTables(result.affectedTables.map(toSummaryTableFact)),
        });

        const item = await prisma.impactItem.create({
          data: {
            impactAnalysisId: id,
            projectId,
            requirementId: change.requirementId,
            // #1013 — SNAPSHOT this change's own title on the row it produced.
            // A pasted-text run has `requirementId === null`, so there is no
            // Requirement to join a title from; without this the export had to
            // re-derive one from the run's source text, which cannot be pinned to
            // the right item because zero-hit changes are dropped above (`continue`)
            // and item ordinals stop matching paste ordinals. Empty ⇒ NULL, so a
            // titleless change degrades to the neutral numbered label.
            requirementTitle: change.title.trim() || null,
            changeType: result.changeType,
            severity: result.severity,
            impactScore: result.impactScore,
            confidence: result.confidence,
            affectedFileCount: result.affectedFileCount,
            affectedSymbolCount: result.affectedSymbolCount,
            // #932 — persisted BA narrative; NULL when the summarizer did not run
            // (flag off / offline / malformed / ungrounded) — deterministic passthrough.
            summary: itemSummary,
          },
        });

        if (result.affectedSymbols.length > 0) {
          await prisma.impactAffectedSymbol.createMany({
            data: result.affectedSymbols.map((s) => ({
              impactItemId: item.id,
              codeSymbolId: s.codeSymbolId,
              filePath: s.filePath,
              qualifiedName: s.qualifiedName,
              startLine: s.startLine,
              endLine: s.endLine,
              relation: s.relation,
              depth: s.depth,
              confidence: s.confidence,
            })),
          });
        }

        // #936 — persist the primary set AND the relevance filter's secondary
        // (`unlikely`) bucket into the SAME table, tagged with a PERSISTED
        // `relevanceTier` discriminator so the read path can split primary
        // (null/likely/possible) from the low-confidence secondary (`unlikely`)
        // set. When the filter did not run (flag off / offline / malformed) the
        // rows carry `relevanceTier === undefined` and persist as NULL — read
        // back into the primary set exactly as legacy rows. Empty secondary ⇒
        // no secondary rows written.
        const tablesToPersist = allAffectedTables;
        if (tablesToPersist.length > 0) {
          // Epic #954 (#956) — the CONSUMER set was resolved once above
          // (`consumersByTable`), reused here for persistence. Empty when the
          // project has no workspace ⇒ single-project runs persist NO consumer
          // rows and read exactly as before.

          // Attach the resolution + consumers to ONE representative row per
          // physical table (the table-level row when present, else the first
          // relational row for that name) — mirrors the UI's table grouping.
          const repIdxByTable = new Map<string, number>();
          tablesToPersist.forEach((t, idx) => {
            if (t.objectKind !== "table" && t.objectKind !== "column") return;
            const cur = repIdxByTable.get(t.tableName);
            if (cur === undefined) repIdxByTable.set(t.tableName, idx);
            else if (t.objectKind === "table" && tablesToPersist[cur].objectKind !== "table") {
              repIdxByTable.set(t.tableName, idx);
            }
          });

          // Explicit ids so the consumer children can FK to the representative row
          // (createMany returns no ids on SQLite).
          const rowIds = tablesToPersist.map(() => randomUUID());
          await prisma.impactAffectedTable.createMany({
            data: tablesToPersist.map((t, idx) => ({
              id: rowIds[idx],
              impactItemId: item.id,
              objectKind: t.objectKind,
              tableName: t.tableName,
              columnName: t.columnName,
              columnType: t.columnType,
              changeKind: t.changeKind,
              suggestedDdl: t.suggestedDdl,
              source: t.source,
              reconciliation: t.reconciliation,
              confidence: t.confidence,
              // #936 — persisted relevance tier + rationale. NULL when the filter
              // did not run (deterministic passthrough) so legacy/flag-off rows
              // read identically to today.
              relevanceTier: t.relevanceTier ?? null,
              relevanceRationale: t.relevanceRationale ?? null,
              // Issue #957 (Epic #954) — deterministic expand/contract triage over
              // this row's TEXT-ONLY suggested DDL, computed at crossing time by the
              // PURE classifier (reused untouched). Mirrors the gap-report's call
              // (columnType is the post-change type for an additive add-column;
              // alter/drop with no before/after classify conservatively). Advisory
              // only — NEVER gates any execution path.
              riskClass: classifyDdlRisk({
                changeKind: t.changeKind,
                reconciliation: t.reconciliation,
                suggestedDdl: t.suggestedDdl,
                columnTypeAfter: t.columnType,
              }),
              // Epic #295 Phase 4 (#308) — canonical cross-project identity FK,
              // populated only when crossToSchema ran with an identity resolver
              // (workspace/resource context). Nullable: unchanged otherwise.
              schemaObjectIdentityId: t.schemaObjectIdentityId ?? null,
              // #956 — resolution tier on the representative row only (else NULL).
              consumerResolution:
                repIdxByTable.get(t.tableName) === idx
                  ? (consumersByTable.get(t.tableName)?.resolution ?? null)
                  : null,
            })),
          });

          // #956 — persist the consumer child rows against each representative row.
          const consumerRows: {
            affectedTableId: string;
            consumerProjectId: string;
            consumerProjectName: string;
            usage: string;
            objectQualifiedName: string;
          }[] = [];
          for (const [tableName, idx] of repIdxByTable) {
            const resolved = consumersByTable.get(tableName);
            if (!resolved) continue;
            for (const c of resolved.consumers) {
              consumerRows.push({
                affectedTableId: rowIds[idx],
                consumerProjectId: c.projectId,
                consumerProjectName: c.projectName,
                usage: c.usage,
                objectQualifiedName: c.objectQualifiedName,
              });
            }
          }
          if (consumerRows.length > 0) {
            await prisma.impactAffectedTableConsumer.createMany({ data: consumerRows });
          }
        }

        totalImpactedSymbols += result.affectedSymbolCount;
      }
    }

    // Deterministic run-level overview (always available). #932 — when the LLM
    // summarizer is wired and produces a GROUNDED overview, prefer it; otherwise
    // fall back to this deterministic sentence (non-blocking, never throws).
    const deterministicSummary = `Impacted ${totalImpactedSymbols} symbol(s) across ${projectIds.length} project(s) from ${changes.length} change(s).`;
    let summary = deterministicSummary;
    // #1021 — the run overview spans every project, so it belongs to a single
    // project only when the run has exactly one. Otherwise its tokens are billed
    // to the run's first project rather than being dropped: an un-billed row is
    // the bug this issue exists to fix.
    enterImpactProjectScope(projectIds[0] ?? null);
    if (deps.impactSummarizer && runItems.length > 0) {
      try {
        const runRes = await deps.impactSummarizer.summarizeRun({
          projectCount: projectIds.length,
          changeCount: changes.length,
          totalImpactedSymbols,
          items: runItems,
        });
        if (runRes.summary) summary = runRes.summary;
      } catch (err) {
        log.warn("impact run summarization failed; keeping deterministic summary", {
          id,
          error: String(err),
        });
      }
    }
    // #1024 — honest degradation. When AI enrichment was requested but produced
    // nothing (no provider, provider error, provider timeout), say so ON the
    // result the analyst reads, rather than serving a deterministic baseline that
    // is indistinguishable from an enriched one. Best-effort: a notice fault must
    // never sink a completed run.
    if (deps.llmDegradationNotice) {
      try {
        const notice = deps.llmDegradationNotice();
        if (notice) summary = `${summary}\n\n${notice}`;
      } catch (err) {
        log.warn("impact LLM degradation notice failed; omitting", { id, error: String(err) });
      }
    }
    await prisma.impactAnalysis.update({
      where: { id },
      data: {
        status: "completed",
        completedAt: new Date(),
        totalImpactedSymbols,
        summary,
      },
    });
    jobEvents.completed("impact-analysis", id, null, summary);
  } catch (err) {
    await prisma.impactAnalysis.update({
      where: { id },
      data: {
        status: "failed",
        completedAt: new Date(),
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    });
    log.error("impact analysis failed", { id, error: String(err) });
    // #254 — emit a generic, user-safe message to clients; the raw error stays
    // in the server log above (log.error) only, never on the socket payload.
    jobEvents.failed("impact-analysis", id, null, genericFailureMessage("impact-analysis"));
  }
}
