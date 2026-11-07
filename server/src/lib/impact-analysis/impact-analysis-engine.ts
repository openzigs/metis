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
  impactSeedEvidenceSchema,
  type ImpactAffectedRelation,
  type ImpactNotCheckedReason,
  type ImpactProjectOutcomeKind,
  type ImpactSeedEvidence,
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
  expandDataPathWriters,
  profileDataPathWriters,
  pruneTangentialSchemaSeeds,
  resolveDataPathWriters,
  type DataPathWriter,
  type DataPathWriterProfile,
} from "./data-path-writers.js";
import { assignImpactRoles, tablesGainingColumns } from "./impact-roles.js";
import {
  prismaSeedSymbolLoader,
  prismaStoredLinkDeps,
  prismaWriterIdLoader,
  rankEditCandidatesPerRequest,
  resolveChangeSeeds,
  VERIFY_POOL_FILES,
  type ChangeSeeds,
  type RetrievalMode,
  type SeedPoolFile,
  type StoredLinkDeps,
} from "./change-seeds.js";
import {
  applyEditVerification,
  MAX_PROMOTIONS,
  type EditVerification,
} from "./edit-candidate-verifier.js";
import { applyEditRerank, MAX_RERANK_PICKS, type EditRerank } from "./edit-candidate-reranker.js";
import {
  leadWithAgentCitations,
  prismaAgentCitationDeps,
  type AgentCitationDeps,
} from "./agent-seeder.js";
import { requestGateText, shapeAwareChangeExtractor } from "./change-request.js";
import { resolveStructuralTwins, type CalleeNameSource } from "./structural-twins.js";
import {
  createDefaultCodeSearcher,
  createRunScopedSymbolIndex,
  type CodeSearcherDeps,
} from "../code-graph/project-code-searcher.js";
import {
  gateColumnProposals,
  normalizeProposerOutput,
  type GatedColumnProposal,
  type ProposerOutput,
} from "./column-proposal-gate.js";
import { loadResolvedGoCalls } from "./go-call-resolution.js";
import {
  crossToSchema,
  PrismaSchemaImpactDataSource,
  type AffectedTableInput,
  type CodeSymbolDetail,
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
  detectChangeType,
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
  /**
   * #791 — `add-column` proposals the deterministic gate kept OUT of the result
   * because an existing write path already takes the value as a parameter and
   * nothing asks to store it; each with that writer (file and line) and the
   * reason. Never part of `affectedTables`. Persisted and shown since #1051.
   */
  droppedColumnProposals: GatedColumnProposal[];
  /**
   * #791 — "Optional: settings persistence": `add-column` proposals that would
   * only remember a preferred value for an operation that already exists, or
   * that the proposer itself classed as a user preference. Never part of
   * `affectedTables`, so never part of "migration needed". Persisted and shown
   * since #1051.
   */
  optionalColumnProposals: GatedColumnProposal[];
  /**
   * #791 — `add-column` rows that ARE in `affectedTables` and that the gate did
   * not rule on: describing the write paths failed, the lineage named none, the
   * request has no age or date bound, or no named write path filters on a time.
   * In such a request every proposed column passes; this is the mark that says
   * so, with the reason. Persisted and shown like the two lists above.
   */
  uncheckedColumnProposals: GatedColumnProposal[];
  /**
   * #1036 — how the default seeding searched: `hybrid` (BM25 fused with symbol
   * embeddings), or `bm25-only` when the project's symbols were not embedded yet
   * or the vector search failed. Null when the seeding did not report it (an
   * injected mapper or searcher). A `bm25-only` run is named in the run summary.
   */
  retrievalMode: RetrievalMode | null;
  /**
   * #1754 — how the change was seeded, when a channel beyond the hybrid one ran
   * (the stored-link channel). Absent otherwise: with the flag off the result
   * carries no new key.
   */
  seedEvidence?: ImpactSeedEvidence;
}

/** Why a column passed unchecked when the write paths could not be described. */
export const WRITERS_FAILED_REASON =
  "Not checked: looking up the existing write paths failed, so there was nothing to compare this column with. Review it as an unverified proposal.";

export const DEFAULT_MAX_DEPTH = 2;

type MapRequirementFn = (
  req: { id: string; title: string; body: string },
  projectId: string,
) => Promise<RequirementCodeMatch[]>;

/** #1036 — seed one change into a project. See {@link resolveChangeSeeds}. */
export type SeedChangeFn = (change: ChangedRequirement, projectId: string) => Promise<ChangeSeeds>;

/** #1756 — the edit-candidate check over one change's file pool in one project. */
export type EditCandidateVerifierFn = (input: {
  requirementText: string;
  pool: readonly SeedPoolFile[];
  projectId: string;
}) => Promise<EditVerification>;

/** #1798 — the LLM re-order over one change's file pool in one project. */
export type EditCandidateRerankerFn = (input: {
  requirementText: string;
  pool: readonly SeedPoolFile[];
  projectId: string;
}) => Promise<EditRerank>;

export interface ComputeImpactDeps {
  mapRequirement: MapRequirementFn;
  /**
   * #1036 — hybrid-search seeding that SPLITS what it retrieves: the symbols in
   * the files the change probably edits, and everything else it found. When set
   * it replaces {@link mapRequirement} for this change. Must never throw (its own
   * contract, `change-seeds.ts`).
   */
  seedChange?: SeedChangeFn;
  /**
   * #1756 — the ADDITIVE LLM edit-candidate check (`IMPACT_LLM_EDIT_VERIFY`),
   * run on a split seeding's file pool. It may append verified promotions and
   * mark candidates doubtful; it never removes or re-scores a deterministic
   * seed. Must never throw (its own contract); guarded here too.
   */
  editCandidateVerifier?: EditCandidateVerifierFn;
  /**
   * #1798 — the LLM RE-ORDER of the edit candidates (`IMPACT_LLM_EDIT_RERANK`),
   * run on a split seeding's file pool after the #1756 check. It may move
   * checked pool files into the head of the edit list; every deterministic
   * candidate stays one. Must never throw (its own contract); guarded here too.
   */
  editCandidateReranker?: EditCandidateRerankerFn;
  /**
   * #1759 — the code agent's stored citations (`IMPACT_AGENT_SEEDS`). For a
   * change about a tracked requirement, run LAST on a split seeding (after the
   * #1756 check and the #1798 re-order), so the cited files lead the files to
   * edit; every other candidate stays one, with its score. Never throws.
   */
  agentSeeds?: AgentCitationDeps;
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
    /**
     * #1003 — the project and its live schema, so the proposer can check each
     * column against everything that already exists, not only the crossed rows.
     */
    context: {
      projectId: string;
      liveIndex: LiveSchemaIndex | null;
      /**
       * #791 — the lineage writers of the data this requirement touches, with
       * what each one does. Empty when the lineage named none.
       */
      writers: DataPathWriterProfile[];
    },
  ) => Promise<ProposerOutput>;
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

  // #1036 — seed with the split retrieval when it is wired: `matches` are then
  // the EDIT CANDIDATES, and `related` is what else was retrieved, for review.
  // Without it (an injected `mapRequirement`), every match is a seed, as before.
  let matches: RequirementCodeMatch[];
  let related: RequirementCodeMatch[] = [];
  let schemaSeeds: RequirementCodeMatch[] = [];
  // #1776 — edit candidates the per-request ranking demoted: still radius seeds.
  let radiusSeeds: RequirementCodeMatch[] = [];
  let retrievalMode: RetrievalMode | null = null;
  let seedEvidence: ImpactSeedEvidence | undefined;
  // #791 — what the request ASKS (primary statement + sub-aspects), without its
  // context sections. Read by the `ALTER TABLE` fast path and by the gate: DDL
  // quoted under "Alternatives considered" is not a request for that column.
  const gateText = requestGateText(change);
  if (deps.seedChange) {
    let seeds = await deps.seedChange(change, projectId);
    // #1756 — the additive LLM check, over the file pool the seeding returned.
    if (deps.editCandidateVerifier && seeds.filePool && seeds.filePool.length > 0) {
      try {
        const verification = await deps.editCandidateVerifier({
          requirementText: gateText.ask,
          pool: seeds.filePool,
          projectId,
        });
        seeds = applyEditVerification(seeds, verification);
      } catch (err) {
        log.warn("edit-candidate check failed; deterministic seeds kept", {
          projectId,
          error: String(err),
        });
      }
    }
    // #1798 — the bounded LLM re-order, over the same pool.
    if (deps.editCandidateReranker && seeds.filePool && seeds.filePool.length > 0) {
      try {
        const rerank = await deps.editCandidateReranker({
          requirementText: gateText.ask,
          pool: seeds.filePool,
          projectId,
        });
        seeds = applyEditRerank(seeds, rerank);
      } catch (err) {
        log.warn("edit re-order failed; deterministic seeds kept", {
          projectId,
          error: String(err),
        });
      }
    }
    // #1759 — the code agent's citations lead the files to edit. Last, so no
    // later stage re-orders them; a reused pass, so no model call here.
    if (deps.agentSeeds && change.requirementId) {
      seeds = await leadWithAgentCitations(seeds, change.requirementId, projectId, deps.agentSeeds);
    }
    matches = seeds.editCandidates;
    related = seeds.related;
    schemaSeeds = seeds.schemaSeeds;
    radiusSeeds = seeds.radiusSeeds ?? [];
    retrievalMode = seeds.retrievalMode ?? null;
    seedEvidence = seeds.evidence;
    // Functions built like a retrieved one are review material too. Best-effort.
    try {
      const twins = await resolveStructuralTwins(deps.dataSourceFor(projectId), [
        ...matches,
        ...related,
      ]);
      related = [...related, ...twins];
    } catch (err) {
      log.warn("structural-twin lookup failed; keeping retrieval", {
        projectId,
        error: String(err),
      });
    }
  } else {
    matches = await deps.mapRequirement(
      { id: change.requirementId ?? "", title: change.title, body: change.body },
      projectId,
    );
  }

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

  // #1036 — a table or column among the best hits is not code to edit, but it is
  // still a seed for the schema crossing and the lineage writers below.
  const schemaRows: AffectedSymbolResult[] = schemaSeeds.map((m) => ({
    codeSymbolId: m.codeSymbolId,
    filePath: m.filePath,
    qualifiedName: m.qualifiedName,
    startLine: m.startLine,
    endLine: m.endLine,
    relation: "related" as const,
    depth: 1,
    confidence: m.confidence,
  }));

  // Transitive blast radius from the resolved seed symbols. #1776 — a demoted
  // edit candidate is still a seed here: the per-request ranking changes which
  // files are named to edit, never which callers are reached.
  const radiusFrom = [...matches, ...radiusSeeds];
  const seedIds = [
    ...new Set(radiusFrom.map((m) => m.codeSymbolId).filter((id): id is string => Boolean(id))),
  ];
  const dataSeedIds = [
    ...seedIds,
    ...schemaSeeds.map((m) => m.codeSymbolId).filter((id): id is string => Boolean(id)),
  ];

  let radius: RadiusSymbol[] = [];
  if (seedIds.length > 0) {
    // #1097 — WHICH callers the radius reaches is structural (edge kind and
    // depth against the radius floor), so it walks from a seed of 1, as it did
    // when every mapper's best hit read 1.0. HOW SURE a caller is follows the
    // seed it was reached through (`seedWeights`; the best one when several
    // reach it at the same depth): a caller is never surer than its link.
    //
    // #1330 — this applies to EVERY seeding, ordinary Impact Analysis included,
    // and it is intended. Its seeds (`resolveChangeSeeds`) are top-normalized,
    // so the best edit candidate is still 1 and its callers read as before; a
    // caller reached only through a weaker candidate is now scaled by it (a
    // caller of a 0.5 candidate reads half what it did). Which callers are
    // reached does not change.
    const seedWeights = new Map<string, number>();
    for (const m of radiusFrom) {
      if (!m.codeSymbolId) continue;
      const c = Number.isFinite(m.confidence) && m.confidence > 0 ? m.confidence : 0;
      seedWeights.set(m.codeSymbolId, Math.max(seedWeights.get(m.codeSymbolId) ?? 0, c));
    }
    radius = await blastRadius(deps.dataSourceFor(projectId), seedIds, {
      maxDepth,
      seedConfidence: 1,
      seedWeights,
      // Callers/importers only by default; downstream deps are opt-in.
      includeDependencies: deps.includeDependencies ?? false,
      // Let blastRadius apply its own default floor when undefined.
      minConfidence: deps.minConfidence,
    });
  }

  // Merge + dedupe (direct wins over radius).
  const byKey = new Map<string, AffectedSymbolResult>();
  for (const d of [...direct, ...schemaRows]) {
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

  let affectedSymbols = [...byKey.values()].sort(
    (a, b) => a.depth - b.depth || b.confidence - a.confidence,
  );

  // #961 — grade how well the requirement SEEDED into code from the DEDUPED
  // direct (depth-0) match confidences. Deriving over the merged/deduped direct
  // set — the exact rows persisted per item — makes the engine and the read path
  // agree byte-for-byte by CONSTRUCTION: the read path re-derives from those same
  // persisted direct symbols (`relation === "direct"`). A mapper emitting
  // duplicate seed ids, or null-id same-`qualifiedName` collisions, can no longer
  // diverge the two derivations (they collapse identically in both places).
  // (Derived below, once #791 has pruned direct schema seeds of tangential tables.)

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
  let droppedColumnProposals: GatedColumnProposal[] = [];
  let optionalColumnProposals: GatedColumnProposal[] = [];
  let uncheckedColumnProposals: GatedColumnProposal[] = [];
  // #791 — true once a writer lookup or its profiling threw: the gate then has
  // no writers because of a FAULT, and its `unchecked` rows say that.
  let writerLookupFailed = false;
  let dataPathWriters: DataPathWriter[] = [];
  let dataModel: CodeSymbolDetail[] = [];
  if (deps.includeSchemaImpact !== false && deps.schemaDataSourceFor) {
    const impactedIds = affectedSymbols
      .map((s) => s.codeSymbolId)
      .filter((id): id is string => Boolean(id));
    const schemaDataSource = deps.schemaDataSourceFor(projectId);
    try {
      affectedTables = await crossToSchema(
        impactedIds,
        schemaDataSource,
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
          // The ASK only: this path is not gated, so it must not read a statement
          // (or a literal `ALTER TABLE`) out of a context section.
          requirementText: gateText.ask,
        },
      );
    } catch (err) {
      log.warn("schema impact crossing failed", { projectId, error: String(err) });
    }

    // #791 — every table the crossing reached, kept as it is HERE: before the
    // #936 filter (a model) sorts it into primary and secondary. The gate's
    // writer lookup below reads this list, never the filtered one, so whether a
    // request is covered does not turn on a model's answer (PR #1090 review 3).
    const crossedTables = affectedTables;
    let relevanceFilterApplied = false;

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
        // #1081 — a passthrough (the judge's answer could not be read, or it
        // was never asked) did not filter anything: do not treat it as if it
        // had. Only an explicit `applied: false` opts out.
        relevanceFilterApplied = filtered.applied !== false;
      } catch (err) {
        log.warn("table relevance filter failed; keeping unfiltered crossing", {
          projectId,
          error: String(err),
        });
      }
    }

    // #791 — a column the mapper matched by name (`api_keys.last_used_at` for
    // "last successful refresh") is no longer a directly affected symbol once the
    // #936 filter has judged its whole table tangential. Best-effort.
    if (affectedTablesSecondary.length > 0) {
      try {
        affectedSymbols = await pruneTangentialSchemaSeeds(
          affectedSymbols,
          affectedTables,
          affectedTablesSecondary,
          schemaDataSource,
        );
      } catch (err) {
        log.warn("tangential schema-seed pruning failed; keeping seeds", {
          projectId,
          error: String(err),
        });
      }
    }

    // #1001 — the tables the additive-column proposer may propose on: the primary
    // set as it stands after the #936 filter, BEFORE the #1029 recovery judge (which
    // only runs when this is empty), so nothing is proposed on a recovered table.
    const proposeOn = affectedTables;

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

    // #791 — the functions that WRITE the data this change touches, found through
    // SQL lineage rather than a word match, plus their callers. Runs on the final
    // primary set so a table the #936 filter judged tangential contributes none
    // TO THE SYMBOLS LISTED. (The gate's coverage decision does not read this
    // list when the filter ran — see `gateWriterProfiles` below.)
    // Best-effort: a failure leaves the code impact as it was.
    try {
      const expanded = await expandDataPathWriters(affectedSymbols, {
        requirementText: `${change.title}\n${change.body}`,
        seedIds: dataSeedIds,
        primaryTables: affectedTables,
        dataSource: schemaDataSource,
        graph: deps.dataSourceFor(projectId),
      });
      affectedSymbols = expanded.symbols;
      dataPathWriters = expanded.writers;
    } catch (err) {
      writerLookupFailed = true;
      log.warn("data-path writer expansion failed; keeping code impact", {
        projectId,
        error: String(err),
      });
    }

    // #1001 — ADDITIVE-COLUMN proposals. The #923 regex fast path only fires for a
    // developer imperative ("add a status flag to account"); a business analyst
    // writes obligations ("a cancelled order must record who cancelled it and
    // when") and got only `-- Verify column …` noise. The proposer asks the model
    // which NEW columns the requirement implies, grounded in the tables ALREADY in
    // this result — so it can only ever APPEND `add-column` rows to tables the
    // deterministic crossing surfaced. Runs after the #936 filter so nothing is
    // proposed on a table judged tangential.
    //
    // #791 — it runs ONCE per request (an issue is one change since #1036), AFTER
    // the lineage writers are known, and is handed them with what each one does
    // (parameters, written tables, predicate columns, SQL): the model sees the
    // existing write paths before it proposes new state. Best-effort throughout —
    // a profiling fault means the proposer sees no writers, and the gate below
    // then cannot tell whether the request is covered: its columns pass, marked
    // `unchecked` with the fault as the reason.
    if (deps.additiveColumnProposer && proposeOn.length > 0) {
      let writerProfiles: DataPathWriterProfile[] = [];
      try {
        writerProfiles = await profileDataPathWriters(dataPathWriters, schemaDataSource);
      } catch (err) {
        writerLookupFailed = true;
        log.warn("data-path writer profiling failed; proposing without write paths", {
          projectId,
          error: String(err),
        });
      }

      // #791 — the writers the GATE decides coverage from. `dataPathWriters` above
      // was looked up on the primary set, which the #936 filter shaped: demote
      // `entries` and `MarkAllAsReadBeforeDate` is never found, #4478 is
      // "uncovered", and its `users` column is core on one model answer (PR #1090
      // review 3). So when the filter ran, the gate gets its own lookup over
      // every table the crossing reached. The symbols listed for review and the
      // writers shown to the proposer stay scoped to the primary set. Without the
      // filter the two lists are the same list, and nothing is looked up twice.
      // A fault here is a failed lookup like any other: the gate says so.
      let gateWriterProfiles = writerProfiles;
      if (relevanceFilterApplied && !writerLookupFailed) {
        try {
          gateWriterProfiles = await profileDataPathWriters(
            await resolveDataPathWriters({
              requirementText: `${change.title}\n${change.body}`,
              seedIds: dataSeedIds,
              primaryTables: crossedTables,
              dataSource: schemaDataSource,
              excludeIds: new Set(),
            }),
            schemaDataSource,
          );
        } catch (err) {
          writerLookupFailed = true;
          gateWriterProfiles = [];
          log.warn("gate writer lookup failed; proposed columns pass unchecked", {
            projectId,
            error: String(err),
          });
        }
      }
      let proposed: ReturnType<typeof normalizeProposerOutput> = {
        proposals: [],
        coveringWriterIds: [],
      };
      try {
        proposed = normalizeProposerOutput(
          await deps.additiveColumnProposer(`${change.title}\n${change.body}`, proposeOn, {
            projectId,
            liveIndex: deps.liveIndexFor?.(projectId) ?? null,
            writers: writerProfiles,
          }),
        );
      } catch (err) {
        log.warn("additive column proposer failed; keeping crossing output", {
          projectId,
          error: String(err),
        });
      }

      // #791 — the deterministic gate (`column-proposal-gate.ts`). In a request an
      // existing write path covers — bounded by an age or a date, with a lineage
      // writer that filters on a time column — no column the model proposed is a
      // core migration, whatever it answered: each is "Optional: settings
      // persistence" or not proposed, with the covering writer and the reason,
      // and neither list touches `affectedTables`. In any other request the gate
      // does not rule: the columns pass, each marked `unchecked` with why — bar a
      // column the proposer itself labelled a preference, which is optional there
      // too (a demotion only; it can never add to `affectedTables`).
      if (proposed.proposals.length > 0) {
        const gated = gateColumnProposals({
          request: gateText,
          proposals: proposed.proposals,
          coveringWriterIds: proposed.coveringWriterIds,
          writers: writerLookupFailed ? [] : gateWriterProfiles,
          writersUnavailableReason: writerLookupFailed ? WRITERS_FAILED_REASON : null,
        });
        droppedColumnProposals = gated.rejected;
        optionalColumnProposals = gated.optional;
        uncheckedColumnProposals = gated.unchecked;
        for (const [outcome, list] of [
          ["not proposed", gated.rejected],
          ["optional", gated.optional],
          ["unchecked", gated.unchecked],
        ] as const) {
          for (const g of list) {
            log.info("gated a proposed column", {
              projectId,
              outcome,
              column: `${g.row.tableName}.${g.row.columnName}`,
              writer: g.writer?.qualifiedName ?? null,
            });
          }
        }
        // Same ordering the crossing itself emits (table, then column), so the
        // proposals interleave with their table's existing rows.
        if (gated.core.length > 0) {
          affectedTables = [...affectedTables, ...gated.core].sort(
            (a, b) =>
              a.tableName.localeCompare(b.tableName) ||
              (a.columnName ?? "").localeCompare(b.columnName ?? ""),
          );
        }
      }
    }

    // #1036 — a table that gains a column has two more places to edit that no
    // search finds from the request's wording: where the table is defined, and
    // the types named for it. Best-effort.
    const growingTables = tablesGainingColumns(affectedTables);
    if (growingTables.length > 0 && schemaDataSource.getDataModelSymbols) {
      try {
        dataModel = await schemaDataSource.getDataModelSymbols(growingTables);
      } catch (err) {
        log.warn("data-model lookup failed; keeping code impact", {
          projectId,
          error: String(err),
        });
      }
    }
  }

  // #1036 — settle which symbols are EDIT CANDIDATES (depth 0) and which are
  // BLAST RADIUS, then add what the seeding retrieved but did not select.
  affectedSymbols = assignImpactRoles(affectedSymbols, {
    writers: dataPathWriters,
    growingTables: tablesGainingColumns(affectedTables),
    dataModel,
    related,
  });
  const fileSet = new Set(affectedSymbols.map((s) => s.filePath));
  const { quality: matchQuality, reason: matchQualityReason } = deriveMatchQualityDetailed(
    affectedSymbols
      .filter((s) => s.relation === "direct")
      .map((s) => ({ confidence: s.confidence, filePath: s.filePath })),
  );

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
    droppedColumnProposals,
    optionalColumnProposals,
    uncheckedColumnProposals,
    retrievalMode,
    ...(seedEvidence ? { seedEvidence } : {}),
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
export class InMemoryCodeGraphDataSource implements CodeGraphDataSource, CalleeNameSource {
  private readonly byId: Map<string, GraphSymbol>;
  private readonly edgesFrom: Map<string, GraphEdge[]>;
  private readonly edgesTo: Map<string, GraphEdge[]>;
  private readonly byFile: Map<string, GraphSymbol[]>;

  constructor(
    symbols: GraphSymbol[],
    edges: GraphEdge[],
    /** #1036 — per function, the names it calls (resolved or not). */
    private readonly calleeNames: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
  ) {
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

  calleeNameSets(): ReadonlyMap<string, ReadonlySet<string>> {
    return this.calleeNames;
  }

  /** #1609 — how many symbols the graph holds; zero means the project has no index. */
  get symbolCount(): number {
    return this.byId.size;
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
export async function loadProjectGraph(
  prisma: Pick<PrismaClient, "codeSymbol" | "codeEdge">,
  projectId: string,
): Promise<InMemoryCodeGraphDataSource> {
  const [symbolRows, edgeRows, callRows] = await Promise.all([
    prisma.codeSymbol.findMany({ where: { projectId }, select: SYMBOL_SELECT }),
    prisma.codeEdge.findMany({
      where: { projectId, kind: { in: [...CODE_EDGE_KINDS] }, toSymbolId: { not: null } },
      select: { id: true, fromSymbolId: true, toSymbolId: true, kind: true },
    }),
    // #1036 — every call by NAME, resolved or not, for structural twins. A Go
    // `h.store.X()` has no target symbol, but it does have a name.
    prisma.codeEdge.findMany({
      where: { projectId, kind: "calls", toQualifiedName: { not: null } },
      select: { fromSymbolId: true, toQualifiedName: true },
    }),
  ]);
  const calleeNames = new Map<string, Set<string>>();
  for (const c of callRows) {
    const names = calleeNames.get(c.fromSymbolId) ?? new Set<string>();
    names.add(c.toQualifiedName as string);
    calleeNames.set(c.fromSymbolId, names);
  }
  const symbols = symbolRows.map(toGraphSymbol);
  const edges: GraphEdge[] = edgeRows.map((e) => ({
    id: e.id,
    fromSymbolId: e.fromSymbolId,
    toSymbolId: e.toSymbolId as string,
    kind: e.kind as GraphEdge["kind"],
  }));
  // #791 — a Go handler's `h.store.X()` call is stored unresolved, so without
  // this its callers never enter the blast radius. Bound on package visibility
  // only; an ambiguous name stays unresolved (see go-call-resolution.ts).
  const goCalls = await loadResolvedGoCalls(prisma, projectId);
  goCalls.forEach((c, i) =>
    edges.push({
      id: `go-call:${i}`,
      fromSymbolId: c.fromSymbolId,
      toSymbolId: c.toSymbolId,
      kind: "calls",
    }),
  );
  log.debug("loaded project graph into memory", {
    projectId,
    symbols: symbols.length,
    edges: edges.length,
  });
  return new InMemoryCodeGraphDataSource(symbols, edges, calleeNames);
}

// ---- Service API -----------------------------------------------------------

type ImpactPrisma = Pick<
  PrismaClient,
  | "impactAnalysis"
  | "impactItem"
  | "impactAffectedSymbol"
  | "impactAffectedTable"
  | "impactAffectedTableConsumer"
  | "impactColumnProposal"
  | "document"
  | "knowledgeChunk"
  | "quarantineChunk"
  | "codeSymbol"
  | "codeEdge"
  | "requirement"
  | "requirementCodeMapping"
>;

export interface ImpactServiceDeps {
  prisma?: ImpactPrisma;
  /**
   * #1754 — seed a change about a tracked requirement from its stored code
   * links too (`IMPACT_STORED_LINK_SEEDS`, read by the route). Applies to the
   * default hybrid seeding only: an injected `mapRequirement` or `seedChange`
   * is used as-is.
   */
  storedLinkSeeds?: boolean;
  /**
   * #1759 — let the Analysis code agent's stored citations of a tracked
   * requirement lead its files to edit (`IMPACT_AGENT_SEEDS`, read by the
   * route). Applies to the split seeding only (the default, or an injected
   * `seedChange`); an injected `mapRequirement` is used as-is.
   */
  agentSeeds?: boolean;
  /**
   * #1939 — with `agentSeeds`, run #1832's demotion of stale citations
   * (`IMPACT_DEMOTE_STALE_CITATIONS`, read by the route; off by default).
   */
  demoteStaleCitations?: boolean;
  /**
   * #1756 — the LLM edit-candidate check (`IMPACT_LLM_EDIT_VERIFY`, wired by the
   * route through the impact LLM runtime). When set, the default seeding also
   * returns its file pool ({@link VERIFY_POOL_FILES} files).
   */
  editCandidateVerifier?: EditCandidateVerifierFn;
  /**
   * #1798 — the LLM re-order of the edit candidates (`IMPACT_LLM_EDIT_RERANK`,
   * wired by the route through the impact LLM runtime). When set, the default
   * seeding also returns its file pool.
   */
  editCandidateReranker?: EditCandidateRerankerFn;
  /**
   * #1776 — rank edit candidates once per request, across every change and
   * project (`IMPACT_REQUEST_EDIT_RANKING`, read by the route). Every change is
   * seeded in every accessible project first; then
   * {@link rankEditCandidatesPerRequest} keeps the request's best files on the
   * cross-search cosine score (#1784) and moves the rest to related, still
   * seeding the blast radius. Absent: each
   * change is ranked on its own in each project, as before.
   */
  requestEditRanking?: boolean;
  extractor?: ChangeExtractor;
  mapRequirement?: MapRequirementFn;
  /**
   * #1036 — split hybrid seeding. Defaults to {@link defaultSeedChange} when no
   * `mapRequirement` is injected; an injected `mapRequirement` is used as-is.
   */
  seedChange?: SeedChangeFn;
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
  /**
   * #1609 — whether the run's starter may still open `projectId` once the run
   * is executing. The run executes after the route answered, so access can
   * change in between. Anything but `accessible` is recorded `not-checked` with
   * that reason and the project is never searched: `restricted` when the
   * starter cannot open it, `deleted` (#1636) when it was soft-deleted. The
   * production check (`executionAccessCheck`) reads access ONCE, when the run
   * reaches its first project, and answers every project from that read.
   * Absent ⇒ every project is searched.
   */
  projectAccess?: (projectId: string) => Promise<ProjectExecutionAccess>;
}

/**
 * #1636 — the answer of {@link ImpactServiceDeps.projectAccess}: searchable, or
 * the `not-checked` reason to record instead.
 */
export type ProjectExecutionAccess = "accessible" | "restricted" | "deleted";

/** #1609 — one project's outcome, as the engine records it on the run. */
interface ProjectOutcomeRecord {
  outcome: ImpactProjectOutcomeKind;
  reason: ImpactNotCheckedReason | null;
}

/**
 * #1609 — the nested write that stores each recorded outcome on the run's
 * persisted project rows (`impact_analysis_projects`, created with the run).
 * `updateMany` touches only rows that exist, so a project deleted mid-run
 * (its row cascades away) cannot fail the run's final write.
 */
function projectOutcomeWrites(outcomes: ReadonlyMap<string, ProjectOutcomeRecord>) {
  return {
    updateMany: [...outcomes].map(([projectId, o]) => ({
      where: { projectId },
      data: { outcome: o.outcome, outcomeReason: o.reason },
    })),
  };
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
  /**
   * #1754 — stored requirements to analyse, each as one change carrying its
   * `requirementId`. The route has checked the caller may read every one.
   */
  requirementIds?: readonly string[] | null;
  includeSchemaImpact?: boolean;
  /** #922 — expand mapper/DAO sibling tables (reduced confidence). Default true when crossing runs. */
  expandDaoSiblings?: boolean;
  /** When true, the blast radius also walks downstream dependencies. Default false. */
  includeDependencies?: boolean;
}

/**
 * #1036 — the production seeding: {@link resolveChangeSeeds} over the SAME fused
 * searcher chat's `search_code_symbols` uses (`HybridCodeSearch`: BM25 fused with
 * symbol embeddings). One searcher per run, so its lexical index is built once.
 * A project whose symbols are not embedded yet degrades to BM25 inside the
 * searcher; nothing here throws, and the seeds carry `retrievalMode` so the run
 * can say so.
 *
 * The lexical index reads the SAME client the hits are hydrated from. The
 * production client keeps the shared, fingerprinted index (and its BM25 cache);
 * any other client — a test's, a script's — gets an index of its own, so a
 * caller that injects `deps.prisma` no longer searches one database and
 * hydrates from another.
 */
export function defaultSeedChange(
  prisma: Pick<PrismaClient, "codeSymbol" | "codeEdge">,
  searcherDeps: CodeSearcherDeps = {},
  /** #1754 — the stored-link channel; absent (the flag off) for hybrid seeding only. */
  storedLinks?: StoredLinkDeps,
  /** #1756 — return the hybrid file pool this size, for the edit-candidate check. */
  filePoolSize?: number,
  /** #1776 — return each edit file's score, for the per-request ranking. */
  editFileScores?: boolean,
): SeedChangeFn {
  const sameClient = (prisma as unknown) === (defaultPrisma as unknown);
  const searcher = createDefaultCodeSearcher({
    // Seeding reads a hit's id and score, never its snippet: without this each
    // query also read up to 120 stored embedding texts (#1072 review).
    snippetLookup: null,
    ...(sameClient ? {} : { symbolIndex: createRunScopedSymbolIndex(prisma) }),
    ...searcherDeps,
  });
  const loadSymbols = prismaSeedSymbolLoader(prisma);
  // #1135 — on a read-path bug, table writers are not files to edit.
  const loadWriterIds = prismaWriterIdLoader(prisma);
  return (change, projectId) =>
    resolveChangeSeeds(change, projectId, {
      searcher,
      loadSymbols,
      loadWriterIds,
      ...(storedLinks ? { storedLinks } : {}),
      ...(filePoolSize ? { filePoolSize } : {}),
      ...(editFileScores ? { editFileScores } : {}),
    });
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
  const requirementIds = [...new Set(input.requirementIds ?? [])];
  if (!input.documentId && !input.text && requirementIds.length === 0) {
    throw new ImpactAnalysisError(
      400,
      "NO_SOURCE",
      "One of documentId, text or requirementIds is required",
    );
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
      // #1754 — the stored requirements asked about, read back by the run and a re-run.
      ...(requirementIds.length > 0 ? { requirementIds: JSON.stringify(requirementIds) } : {}),
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

/**
 * #1754 — the stored requirement ids a run was asked about, from the row's JSON.
 * Anything but an array of strings reads as none.
 */
export function parseRequirementIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * #1754 — one change per stored requirement, in the order asked, with its own
 * title, body and `requirementId`. A requirement deleted since the run was
 * started is skipped.
 */
export async function loadRequirementChanges(
  prisma: Pick<PrismaClient, "requirement">,
  requirementIds: readonly string[],
): Promise<ChangedRequirement[]> {
  if (requirementIds.length === 0) return [];
  const rows = await prisma.requirement.findMany({
    where: { id: { in: [...requirementIds] }, deletedAt: null },
    select: { id: true, title: true, body: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return requirementIds.flatMap((id) => {
    const r = byId.get(id);
    if (!r) return [];
    return [
      {
        requirementId: r.id,
        title: r.title,
        body: r.body,
        changeType: detectChangeType(`${r.title} ${r.body}`),
        bodyDelta: r.body.length,
      },
    ];
  });
}

/**
 * #1754 — the sentence a run's summary gains when the stored-link channel ran:
 * how many stored links seeded the run, and how many were dropped because their
 * file has left the code graph.
 */
export function storedLinkNotice(used: number, stale: number): string {
  const links = (n: number) => `${n} stored requirement link${n === 1 ? "" : "s"}`;
  const head = `${links(used)} seeded the files to edit.`;
  return stale === 0
    ? head
    : `${head} ${links(stale)} ${stale === 1 ? "was" : "were"} dropped: the linked file is no longer in the code graph.`;
}

/**
 * #1759 — the sentence a run's summary gains when the code agent's stored
 * citations were read: how many seeded the run, how many files they put at the
 * head of the files to edit, and how many were dropped because their file has
 * left the code graph.
 */
export function agentCitationNotice(t: {
  used: number;
  stale: number;
  led: number;
  /** #1832 — citations re-validation found out of date, set aside. */
  demoted?: number;
  /**
   * #1939 — citations re-validation found out of date, set aside or not. Those
   * not set aside (the demotion flag off) still seeded, and are said so.
   */
  outOfDate?: number;
}): string {
  const citations = (n: number) => `${n} code-agent citation${n === 1 ? "" : "s"}`;
  const files = (n: number) => `${n} file${n === 1 ? "" : "s"}`;
  const were = (n: number) => (n === 1 ? "was" : "were");
  const head =
    t.used === 0
      ? `No code-agent citation from "Evaluate new requirements" seeded the files to edit.`
      : `${citations(t.used)} from "Evaluate new requirements" put ${files(t.led)} at the top of the files to edit; every file the search picked is still listed.`;
  const dropped =
    t.stale === 0
      ? ""
      : ` ${citations(t.stale)} ${were(t.stale)} dropped: the cited file is no longer in the code graph.`;
  const demoted = t.demoted ?? 0;
  const setAside =
    demoted === 0
      ? ""
      : ` ${citations(demoted)} ${were(demoted)} set aside: the code ${demoted === 1 ? "it cites" : "they cite"} changed since the analysis.`;
  const kept = Math.max(0, (t.outOfDate ?? 0) - demoted);
  const keptNote =
    kept === 0
      ? ""
      : ` ${citations(kept)} ${kept === 1 ? "cites" : "cite"} code that changed since the analysis; ${kept === 1 ? "it was" : "they were"} still used.`;
  return `${head}${dropped}${setAside}${keptNote}`;
}

/**
 * #1756 — the sentence a run's summary gains when the edit-candidate check
 * answered: what it promoted (each at a line checked against the code graph),
 * what it marked doubtful (still listed), and how many promotions it dropped.
 */
export function editVerifierNotice(t: {
  promoted: number;
  doubtful: number;
  dropped: number;
}): string {
  const files = (n: number) => (n === 0 ? "no files" : `${n} file${n === 1 ? "" : "s"}`);
  const added =
    t.promoted === 0
      ? "The AI edit check added no files to the files to edit"
      : `The AI edit check added ${files(t.promoted)} to the files to edit, each at a line checked against the code`;
  const head = `${added}, and marked ${files(t.doubtful)} as doubtful (still listed).`;
  // #1781 — a drop is not always a bad line: the index, the entry or the limit can be the reason.
  return t.dropped === 0
    ? head
    : `${head} ${t.dropped} suggestion${t.dropped === 1 ? " was" : "s were"} dropped because ${t.dropped === 1 ? "it" : "they"} could not be checked: a line outside every function or type of that file, a file not in the list, an unreadable entry, or more than ${MAX_PROMOTIONS} suggestions.`;
}

/**
 * #1798 — the sentence a run's summary gains when the edit re-order answered:
 * how many files it ranked higher in the order of the files to edit (#1762
 * shows the files in that order), how many of
 * those the search had not picked (each at a line checked against the code),
 * and how many of its picks it dropped. Every file the search picked stays
 * listed.
 */
export function editRerankNotice(t: { moved: number; promoted: number; dropped: number }): string {
  const files = (n: number) => (n === 0 ? "no files" : `${n} file${n === 1 ? "" : "s"}`);
  const head =
    t.moved === 0
      ? "The AI re-order changed no file's place in the order of the files to edit; every file the search picked is still listed."
      : `The AI re-order ranked ${files(t.moved)} higher in the order of the files to edit` +
        (t.promoted === 0
          ? ""
          : `, ${t.promoted} of them not picked by the search (each at a line checked against the code)`) +
        "; the impact page shows the files to edit in this order, and every file the search picked is still listed.";
  return t.dropped === 0
    ? head
    : `${head} ${t.dropped} suggestion${t.dropped === 1 ? " was" : "s were"} dropped because ${t.dropped === 1 ? "it" : "they"} could not be checked: a line outside every function or type of that file, a file not in the list, an unreadable entry, or more than ${MAX_RERANK_PICKS} suggestions.`;
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

/**
 * #1036 — the sentence appended to a run's summary when its code search ran on
 * keywords only. Names how many projects, not which: a project id means nothing
 * to the reader, and the per-project results sit right below.
 */
export function bm25OnlyNotice(affected: number, total: number): string {
  const scope =
    total <= 1
      ? "this project"
      : affected === total
        ? `all ${total} projects`
        : `${affected} of ${total} projects`;
  return `Code search ran on keywords only (BM25) for ${scope}: symbol embeddings were missing or still building, so the files to edit and the blast radius were chosen without semantic search. Re-run once embedding has finished to compare.`;
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
 * #1776 — seed every change in every accessible project, rank the edit
 * candidates once over the whole request ({@link rankEditCandidatesPerRequest},
 * on the #1784 cross-search score),
 * and return a {@link SeedChangeFn} that answers from those seeds. A project the
 * starter cannot open is never searched (#1609). Each project's searches run in
 * its own attribution scope, as they do in the per-project loop (#1021).
 */
async function seedRequestOnce(
  changes: readonly ChangedRequirement[],
  projectIds: readonly string[],
  seedChange: SeedChangeFn,
  accessOf: (projectId: string) => Promise<ProjectExecutionAccess>,
): Promise<SeedChangeFn> {
  const seedings: Array<{ change: ChangedRequirement; projectId: string; seeds: ChangeSeeds }> = [];
  for (const projectId of projectIds) {
    enterImpactProjectScope(projectId);
    if ((await accessOf(projectId)) !== "accessible") continue;
    for (const change of changes) {
      seedings.push({ change, projectId, seeds: await seedChange(change, projectId) });
    }
  }
  // #1784 — on the cross-search (cosine) score: fused RRF scores of separate
  // searches are near-ties, and ranking on them lowered Recall@5 (#1776).
  const ranked = rankEditCandidatesPerRequest(seedings, "cosine");
  const byChange = new Map<ChangedRequirement, Map<string, ChangeSeeds>>();
  seedings.forEach(({ change, projectId }, i) => {
    const forChange = byChange.get(change) ?? new Map<string, ChangeSeeds>();
    forChange.set(projectId, ranked[i]!);
    byChange.set(change, forChange);
  });
  return async (change, projectId) =>
    byChange.get(change)?.get(projectId) ?? seedChange(change, projectId);
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
  // #1036 — an issue is read as ONE change with sub-aspects; anything else keeps
  // the heuristic splitter (the shape-aware extractor falls back to it).
  const extractor = deps.extractor ?? shapeAwareChangeExtractor;
  const mapRequirement: MapRequirementFn =
    deps.mapRequirement ?? ((req, projectId) => mapRequirementToCode(req, projectId));
  // #1036 — seed with the chat path's hybrid search unless the caller chose a
  // mapper of its own (the opt-in LLM seeding flags, and tests).
  let seedChange: SeedChangeFn | undefined =
    deps.seedChange ??
    (deps.mapRequirement
      ? undefined
      : defaultSeedChange(
          prisma,
          {},
          deps.storedLinkSeeds ? prismaStoredLinkDeps(prisma) : undefined,
          deps.editCandidateVerifier || deps.editCandidateReranker ? VERIFY_POOL_FILES : undefined,
          deps.requestEditRanking,
        ));
  // #1609 — the starter's access, read once per project and reused.
  const accessByProject = new Map<string, Promise<ProjectExecutionAccess>>();
  const accessOf = (projectId: string): Promise<ProjectExecutionAccess> => {
    if (!deps.projectAccess) return Promise.resolve("accessible");
    let access = accessByProject.get(projectId);
    if (!access) {
      access = deps.projectAccess(projectId);
      accessByProject.set(projectId, access);
    }
    return access;
  };
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

  // #1609 — what the run found for each project, including the ones it found
  // nothing in or skipped. Written onto the run's project rows at the end.
  const outcomes = new Map<string, ProjectOutcomeRecord>();
  // The project being worked on, so a failure can be pinned to it as `error`.
  let currentProjectId: string | null = null;

  try {
    const text = await resolveSourceText(prisma, row);
    // #1754 — a run about stored requirements: one change per requirement, after
    // any pasted text's or document's own changes.
    const requirementIds = parseRequirementIds(row.requirementIds);
    const changes = [
      ...(requirementIds.length === 0 || text.trim().length > 0
        ? await extractor.extract(text)
        : []),
      ...(await loadRequirementChanges(prisma, requirementIds)),
    ];

    // #1776 — seed every change in every accessible project first, and rank the
    // edit candidates once over all of them; the loop below reads these seeds.
    if (deps.requestEditRanking && seedChange) {
      seedChange = await seedRequestOnce(changes, projectIds, seedChange, accessOf);
    }

    let totalImpactedSymbols = 0;
    // #1036 — projects whose code search ran on keywords only, for the summary.
    const bm25OnlyProjects = new Set<string>();
    // #1754 — the stored-link channel's totals, for the summary.
    const storedLinkTotals = { ran: false, used: 0, stale: 0 };
    // #1756 — the edit-candidate check's totals, for the summary.
    const verifierTotals = { ran: false, promoted: 0, doubtful: 0, dropped: 0 };
    // #1798 — the edit re-order's totals, for the summary.
    const rerankTotals = { ran: false, moved: 0, promoted: 0, dropped: 0 };
    // #1759 — the code agent's citations' totals, for the summary.
    const agentTotals = { ran: false, used: 0, stale: 0, led: 0, demoted: 0, outOfDate: 0 };
    const agentSeeds = deps.agentSeeds
      ? prismaAgentCitationDeps(prisma, deps.demoteStaleCitations === true)
      : undefined;
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
      currentProjectId = projectId;
      // #1609 — the starter's access as of execution. A project they can no
      // longer open (or one deleted since the trigger, #1636) is recorded and
      // skipped: nothing is searched, so no symbol of it can reach the result.
      const access = await accessOf(projectId);
      if (access !== "accessible") {
        outcomes.set(projectId, { outcome: "not-checked", reason: access });
        continue;
      }
      // Pre-load the entire code graph for this project into memory once.
      // This replaces N×changes×depth individual Prisma queries with 2 bulk
      // loads + O(1) Map lookups for every BFS hop across all changes.
      let projectGraph: CodeGraphDataSource;
      if (deps.dataSourceFor) {
        projectGraph = deps.dataSourceFor(projectId);
      } else {
        const loaded = await loadProjectGraph(prisma, projectId);
        // #1609 — a project with no indexed symbols has nothing to search. Say
        // so rather than report it as checked, and skip the seeding stages.
        if (loaded.symbolCount === 0) {
          outcomes.set(projectId, { outcome: "not-checked", reason: "no-index" });
          continue;
        }
        projectGraph = loaded;
      }
      const dataSourceForProject = (_id: string) => projectGraph;
      let projectAffected = false;

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
          seedChange,
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
          editCandidateVerifier: deps.editCandidateVerifier,
          editCandidateReranker: deps.editCandidateReranker,
          ...(agentSeeds ? { agentSeeds } : {}),
        });

        if (result.retrievalMode === "bm25-only") bm25OnlyProjects.add(projectId);
        // Counted before the zero-hit skip: a change whose every link went stale
        // writes no item, and its stale links must still reach the summary.
        const stored = result.seedEvidence?.storedLinks;
        if (stored) {
          storedLinkTotals.ran = true;
          storedLinkTotals.used += stored.used;
          storedLinkTotals.stale += stored.stale;
        }
        const verified = result.seedEvidence?.verifier;
        if (verified) {
          verifierTotals.ran = true;
          verifierTotals.promoted += verified.promoted;
          verifierTotals.doubtful += verified.doubtful;
          verifierTotals.dropped += verified.droppedPromotions;
        }
        const reranked = result.seedEvidence?.reranker;
        if (reranked) {
          rerankTotals.ran = true;
          rerankTotals.moved += reranked.moved;
          rerankTotals.promoted += reranked.promoted;
          rerankTotals.dropped += reranked.droppedPicks;
        }
        const agent = result.seedEvidence?.agentCitations;
        if (agent) {
          agentTotals.ran = true;
          agentTotals.used += agent.used;
          agentTotals.stale += agent.stale;
          agentTotals.led += agent.led;
          agentTotals.demoted += agent.demotedStaleCitations ?? 0;
          agentTotals.outOfDate += agent.outOfDateCitations ?? 0;
        }

        // Skip empty (no code hits) results to keep the report focused: a change
        // with no hits writes no item. #1609 — the project is still recorded,
        // as `checked-none-affected` when none of its changes hit (below).
        if (result.affectedSymbolCount === 0) continue;
        projectAffected = true;

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
            // #1754 — only when a channel beyond the hybrid one ran.
            ...(result.seedEvidence
              ? {
                  seedEvidence: JSON.stringify(impactSeedEvidenceSchema.parse(result.seedEvidence)),
                }
              : {}),
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

        // #1051 — the proposed columns the #791 gate kept OUT of the affected
        // tables, each with the covering write path (file and line) and the
        // reason. Stored in their own table: before this they lived only on the
        // in-memory result and in a log line, so a reviewer could not see what
        // was ruled out. Nothing is written when the gate ruled nothing out.
        // `unchecked` rows are different in kind: the column IS among the affected
        // tables, and the row records why the gate did not rule on it.
        const ruledOut = [
          ...result.droppedColumnProposals.map((g) => ({ disposition: "rejected", g })),
          ...result.optionalColumnProposals.map((g) => ({ disposition: "optional", g })),
          ...result.uncheckedColumnProposals.map((g) => ({ disposition: "unchecked", g })),
        ];
        if (ruledOut.length > 0) {
          await prisma.impactColumnProposal.createMany({
            data: ruledOut.map(({ disposition, g }) => ({
              impactItemId: item.id,
              disposition,
              tableName: g.row.tableName,
              columnName: g.row.columnName ?? "",
              columnType: g.row.columnType,
              suggestedDdl: g.row.suggestedDdl,
              reason: g.reason,
              writerQualifiedName: g.writer?.qualifiedName ?? null,
              writerFilePath: g.writer?.filePath ?? null,
              writerStartLine: g.writer?.startLine ?? null,
              writerEndLine: g.writer?.endLine ?? null,
            })),
          });
        }

        totalImpactedSymbols += result.affectedSymbolCount;
      }
      outcomes.set(projectId, {
        outcome: projectAffected ? "affected" : "checked-none-affected",
        reason: null,
      });
    }
    currentProjectId = null;

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
    // #1036 — the same honesty for retrieval. Seeding degrades to BM25 when a
    // project's symbols are not embedded yet (or the vector search faults), which
    // is a sound fallback and a different result: say so on the run, where the
    // page and the export both show it.
    if (bm25OnlyProjects.size > 0) {
      summary = `${summary}\n\n${bm25OnlyNotice(bm25OnlyProjects.size, projectIds.length)}`;
    }
    if (storedLinkTotals.ran) {
      summary = `${summary}\n\n${storedLinkNotice(storedLinkTotals.used, storedLinkTotals.stale)}`;
    }
    if (verifierTotals.ran) {
      summary = `${summary}\n\n${editVerifierNotice(verifierTotals)}`;
    }
    if (rerankTotals.ran) {
      summary = `${summary}\n\n${editRerankNotice(rerankTotals)}`;
    }
    if (agentTotals.ran) {
      summary = `${summary}\n\n${agentCitationNotice(agentTotals)}`;
    }
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
        // #1609 — in the same write as the completion, so a completed run is
        // never read without its outcomes.
        projects: projectOutcomeWrites(outcomes),
      },
    });
    jobEvents.completed("impact-analysis", id, null, summary);
  } catch (err) {
    // #1609 — keep what the run settled before it failed, and pin the failure
    // to the project it was working on. Projects it never reached stay
    // unrecorded.
    if (currentProjectId !== null && !outcomes.has(currentProjectId)) {
      outcomes.set(currentProjectId, { outcome: "error", reason: null });
    }
    await prisma.impactAnalysis.update({
      where: { id },
      data: {
        status: "failed",
        completedAt: new Date(),
        errorMessage: err instanceof Error ? err.message : String(err),
        projects: projectOutcomeWrites(outcomes),
      },
    });
    log.error("impact analysis failed", { id, error: String(err) });
    // #254 — emit a generic, user-safe message to clients; the raw error stays
    // in the server log above (log.error) only, never on the socket payload.
    jobEvents.failed("impact-analysis", id, null, genericFailureMessage("impact-analysis"));
  }
}
