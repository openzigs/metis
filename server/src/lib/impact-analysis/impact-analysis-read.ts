/**
 * Read-side projections for impact analyses — Epic #159 (#162/#163).
 *
 * Builds the `ImpactAnalysisSummary` / `ImpactAnalysisDetail` views consumed by
 * the routes and UI. `projectIds` / `projectCount` are derived from the
 * persisted `ImpactItem` rows since one analysis spans many projects.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type {
  DdlRiskClass,
  ImpactAffectedSymbolView,
  ImpactAffectedTableView,
  ImpactAnalysisDetail,
  ImpactAnalysisStatus,
  ImpactAnalysisSummary,
  ImpactConsumerResolution,
  ImpactConsumerUsage,
  ImpactItemView,
  ImpactTableConsumerView,
  ImpactTableFeedbackVerdict,
  ImpactTableFeedbackView,
  SharedTableImpact,
  WritePathCoverageGap,
} from "@metis/shared";
import {
  CHANGE_SEVERITIES,
  CHANGE_TYPES,
  DDL_CHANGE_KINDS,
  DDL_RISK_CLASSES,
  deriveMatchQualityDetailed,
  IMPACT_CONSUMER_RESOLUTIONS,
  IMPACT_CONSUMER_USAGES,
  IMPACT_TABLE_FEEDBACK_VERDICTS,
  SCHEMA_RECONCILIATIONS,
  SCHEMA_SOURCES,
  USAGE_OBJECT_KINDS,
} from "@metis/shared";
import { isTestFilePath } from "../analysis/traceability-matrix.js";
import { prisma as defaultPrisma } from "../prisma.js";

/**
 * #962 — the read path optionally reaches into the code/schema graph
 * (`codeSymbol`/`codeEdge`) to compute write-path coverage gaps. Those tables are
 * OPTIONAL on the injected client: unit tests that stub only `impactAnalysis`
 * simply skip the gap pass (⇒ empty `writePathGaps`), and the default runtime
 * prisma has them.
 */
type ReadPrisma = Pick<PrismaClient, "impactAnalysis"> &
  Partial<Pick<PrismaClient, "codeSymbol" | "codeEdge">>;

/** #962 — the code/schema-graph slice used by the write-path coverage pass. */
type SchemaGraphPrisma = Pick<PrismaClient, "codeSymbol" | "codeEdge">;

function resolvePrisma(prisma?: ReadPrisma): ReadPrisma {
  return prisma ?? (defaultPrisma as unknown as ReadPrisma);
}

const ITEM_INCLUDE = {
  items: {
    include: {
      affectedSymbols: { orderBy: [{ depth: "asc" }, { confidence: "desc" }] },
      affectedTables: {
        // #956 — the cross-project consumer children, stable-sorted for
        // deterministic rendering.
        include: {
          consumers: {
            orderBy: [{ consumerProjectName: "asc" }, { consumerProjectId: "asc" }],
          },
        },
        orderBy: [{ tableName: "asc" }, { columnName: "asc" }],
      },
      // Issue #966 (Epic #960) — accumulated BA relevance feedback, oldest first
      // (stable, deterministic rendering).
      feedback: { orderBy: [{ createdAt: "asc" }] },
      requirement: { select: { title: true } },
    },
    orderBy: [{ projectId: "asc" }, { impactScore: "desc" }],
  },
} satisfies Prisma.ImpactAnalysisInclude;

/**
 * #88 — the detail read additionally loads the run's PERSISTED project selection
 * (`impact_analysis_projects`, written at creation by #70). It is the only thing
 * that names the projects of a run which has not written an item yet, and the
 * detail/export/publish access guard is derived from it.
 */
const DETAIL_INCLUDE = {
  ...ITEM_INCLUDE,
  projects: { select: { projectId: true } },
} satisfies Prisma.ImpactAnalysisInclude;

interface RawAffectedSymbol {
  id: string;
  codeSymbolId: string | null;
  filePath: string;
  qualifiedName: string;
  startLine: number | null;
  endLine: number | null;
  relation: string;
  depth: number;
  confidence: number;
}

interface RawConsumer {
  consumerProjectId: string;
  consumerProjectName: string;
  usage: string;
  objectQualifiedName: string;
}

interface RawAffectedTable {
  id: string;
  objectKind: string;
  tableName: string;
  columnName: string | null;
  columnType: string | null;
  changeKind: string;
  suggestedDdl: string | null;
  source: string;
  reconciliation: string | null;
  confidence: number;
  /** #957 — persisted DDL risk class (breaking|expanding|neutral), else null. */
  riskClass: string | null;
  relevanceTier: string | null;
  relevanceRationale: string | null;
  /** #956 — resolution tier on the representative row (else null). */
  consumerResolution: string | null;
  /** #956 — sibling consumer rows (only on the representative row). */
  consumers: RawConsumer[];
}

/** #956 — a recognised consumer-resolution tier, or null (not computed). */
function toConsumerResolution(v: string | null): ImpactConsumerResolution | null {
  return v && (IMPACT_CONSUMER_RESOLUTIONS as readonly string[]).includes(v)
    ? (v as ImpactConsumerResolution)
    : null;
}

/** #956 — a persisted consumer usage, defaulting to `readBy` for any legacy value. */
function toConsumerUsage(v: string): ImpactConsumerUsage {
  return (IMPACT_CONSUMER_USAGES as readonly string[]).includes(v)
    ? (v as ImpactConsumerUsage)
    : "readBy";
}

function toConsumerView(c: RawConsumer): ImpactTableConsumerView {
  return {
    projectId: c.consumerProjectId,
    projectName: c.consumerProjectName,
    usage: toConsumerUsage(c.usage),
    objectQualifiedName: c.objectQualifiedName,
  };
}

/** #936 — the tier value that demotes a table into the low-confidence secondary bucket. */
const SECONDARY_TIER = "unlikely";
/** #936 — persisted tier values the read path recognises; anything else ⇒ treated as null (primary). */
const RELEVANCE_TIERS = ["likely", "possible", "unlikely"] as const;

/** A recognised relevance tier, or null (legacy / flag-off / unrecognised ⇒ primary). */
type RelevanceTierOrNull = "likely" | "possible" | "unlikely" | null;

function toRelevanceTier(t: string | null): RelevanceTierOrNull {
  return t && (RELEVANCE_TIERS as readonly string[]).includes(t)
    ? (t as "likely" | "possible" | "unlikely")
    : null;
}

/** #957 — a recognised DDL risk class, or null (legacy row / unrecognised value ⇒ no badge). */
function toRiskClass(v: string | null): DdlRiskClass | null {
  return v && (DDL_RISK_CLASSES as readonly string[]).includes(v) ? (v as DdlRiskClass) : null;
}

/** #966 — a recognised feedback verdict, defaulting to `relevant` for any legacy/bad value. */
function toFeedbackVerdict(v: string): ImpactTableFeedbackVerdict {
  return (IMPACT_TABLE_FEEDBACK_VERDICTS as readonly string[]).includes(v)
    ? (v as ImpactTableFeedbackVerdict)
    : "relevant";
}

interface RawFeedback {
  id: string;
  impactItemId: string;
  tableName: string;
  columnName: string | null;
  verdict: string;
  userId: string;
  userDisplayName: string;
  createdAt: Date;
}

function toFeedbackView(f: RawFeedback): ImpactTableFeedbackView {
  return {
    id: f.id,
    impactItemId: f.impactItemId,
    tableName: f.tableName,
    columnName: f.columnName,
    verdict: toFeedbackVerdict(f.verdict),
    userId: f.userId,
    userDisplayName: f.userDisplayName,
    createdAt: f.createdAt.toISOString(),
  };
}

interface RawItem {
  id: string;
  projectId: string;
  requirementId: string | null;
  /**
   * #1013 — the changed requirement's title SNAPSHOTTED on this row at analysis
   * time. Null for rows written before the column existed (and for a titleless
   * change); the tracked-requirement join below still wins when it resolves.
   */
  requirementTitle: string | null;
  changeType: string;
  severity: string;
  impactScore: number;
  confidence: number;
  affectedFileCount: number;
  affectedSymbolCount: number;
  /** #932 — persisted BA-readable per-item narrative (null when not generated). */
  summary: string | null;
  requirement: { title: string } | null;
  affectedSymbols: RawAffectedSymbol[];
  affectedTables: RawAffectedTable[];
  /** #966 — accumulated BA relevance feedback on this item's affected tables. */
  feedback: RawFeedback[];
}

function toAffectedSymbolView(s: RawAffectedSymbol): ImpactAffectedSymbolView {
  return {
    id: s.id,
    codeSymbolId: s.codeSymbolId,
    filePath: s.filePath,
    qualifiedName: s.qualifiedName,
    startLine: s.startLine,
    endLine: s.endLine,
    relation: s.relation as ImpactAffectedSymbolView["relation"],
    depth: s.depth,
    confidence: s.confidence,
  };
}

function toAffectedTableView(t: RawAffectedTable): ImpactAffectedTableView {
  return {
    id: t.id,
    objectKind: (USAGE_OBJECT_KINDS as readonly string[]).includes(t.objectKind)
      ? (t.objectKind as ImpactAffectedTableView["objectKind"])
      : "table",
    tableName: t.tableName,
    columnName: t.columnName,
    columnType: t.columnType,
    changeKind: (DDL_CHANGE_KINDS as readonly string[]).includes(t.changeKind)
      ? (t.changeKind as ImpactAffectedTableView["changeKind"])
      : "reference",
    suggestedDdl: t.suggestedDdl,
    source: (SCHEMA_SOURCES as readonly string[]).includes(t.source)
      ? (t.source as ImpactAffectedTableView["source"])
      : "mybatis",
    reconciliation:
      t.reconciliation && (SCHEMA_RECONCILIATIONS as readonly string[]).includes(t.reconciliation)
        ? (t.reconciliation as NonNullable<ImpactAffectedTableView["reconciliation"]>)
        : null,
    confidence: t.confidence,
    riskClass: toRiskClass(t.riskClass),
    relevanceTier: toRelevanceTier(t.relevanceTier),
    relevanceRationale: t.relevanceRationale,
  };
}

function toItemView(item: RawItem): ImpactItemView {
  // #936 — split the persisted rows on the `relevanceTier` discriminator. Rows
  // the LLM relevance filter judged `unlikely` go to the low-confidence
  // SECONDARY bucket; everything else (null tier ⇒ legacy/flag-off, likely,
  // possible) stays in the PRIMARY set. NULL tiers read exactly as before this
  // feature — deterministic passthrough.
  //
  // #940 — a COLUMN row inherits its parent TABLE's tier + bucket. The relevance
  // filter judges TABLES, not columns; so the authoritative tier for a column is
  // its table's. Deriving the split from the parent table (rather than the
  // column's own persisted/legacy tier) makes the invariant hold even for rows
  // written before this fix: no `tableName` (nor any of its columns) can ever
  // appear in BOTH the primary and secondary sets.
  const rawTables = item.affectedTables ?? [];
  const tierByTableName = new Map<string, RelevanceTierOrNull>();
  for (const raw of rawTables) {
    if (raw.objectKind === "table")
      tierByTableName.set(raw.tableName, toRelevanceTier(raw.relevanceTier));
  }

  // #956 — the cross-project consumer resolution is persisted on ONE
  // representative row per physical table. Fold it into a per-tableName map so
  // every view row of that table carries the (identical) consumer data and the
  // UI renders it once at the table-group level regardless of which row it treats
  // as the group representative. A row with a non-null resolution wins.
  const consumerByTable = new Map<
    string,
    { resolution: ImpactConsumerResolution | null; consumers: ImpactTableConsumerView[] }
  >();
  for (const raw of rawTables) {
    const resolution = toConsumerResolution(raw.consumerResolution);
    const consumers = (raw.consumers ?? []).map(toConsumerView);
    if (resolution === null && consumers.length === 0) continue;
    const existing = consumerByTable.get(raw.tableName);
    if (!existing || (existing.resolution === null && resolution !== null)) {
      consumerByTable.set(raw.tableName, { resolution, consumers });
    }
  }

  const affectedTables: ImpactAffectedTableView[] = [];
  const affectedTablesSecondary: ImpactAffectedTableView[] = [];
  for (const raw of rawTables) {
    const view = toAffectedTableView(raw);
    // Non-table rows inherit their parent table's tier when that table is present
    // in this item; table rows (and orphan columns) keep their own tier.
    let effectiveTier: RelevanceTierOrNull = view.relevanceTier ?? null;
    if (raw.objectKind !== "table" && tierByTableName.has(raw.tableName)) {
      effectiveTier = tierByTableName.get(raw.tableName) ?? null;
    }
    view.relevanceTier = effectiveTier;
    // #956 — surface the table's consumer resolution on every view row of that
    // table (routines have no cross-project consumer dimension here).
    const consumerInfo = consumerByTable.get(raw.tableName);
    if (consumerInfo && (raw.objectKind === "table" || raw.objectKind === "column")) {
      view.consumerResolution = consumerInfo.resolution;
      view.consumers = consumerInfo.consumers;
    }
    if (effectiveTier === SECONDARY_TIER) affectedTablesSecondary.push(view);
    else affectedTables.push(view);
  }

  const allSymbols = item.affectedSymbols.map(toAffectedSymbolView);

  // #961/#994 — derive the requirement→code match quality (+ WHY, when weak)
  // from the persisted DIRECT (seed) confidences+paths. The direct affected
  // symbols ARE the seed matches, so this reproduces the engine-time
  // computation byte-for-byte with no migration.
  const { quality: matchQuality, reason: matchQualityReason } = deriveMatchQualityDetailed(
    item.affectedSymbols
      .filter((s) => s.relation === "direct")
      .map((s) => ({ confidence: s.confidence, filePath: s.filePath })),
  );

  return {
    id: item.id,
    projectId: item.projectId,
    requirementId: item.requirementId,
    // #1013 — a TRACKED requirement's live title wins (it can be renamed after
    // the run, and the joined row is authoritative); otherwise the per-item
    // snapshot taken at analysis time, which is the only title a pasted-text run
    // has. Null only for pre-#1013 rows and titleless changes.
    requirementTitle: item.requirement?.title ?? item.requirementTitle ?? null,
    changeType: (CHANGE_TYPES as readonly string[]).includes(item.changeType)
      ? (item.changeType as ImpactItemView["changeType"])
      : "modified",
    severity: (CHANGE_SEVERITIES as readonly string[]).includes(item.severity)
      ? (item.severity as ImpactItemView["severity"])
      : "medium",
    impactScore: item.impactScore,
    confidence: item.confidence,
    matchQuality,
    matchQualityReason,
    affectedFileCount: item.affectedFileCount,
    affectedSymbolCount: item.affectedSymbolCount,
    summary: item.summary ?? null,
    // #962 — split the blast radius into PRODUCTION code vs the project's own
    // TEST files (per the shared `isTestFilePath` heuristic). Test files appear
    // in the radius as callers/importers of the changed code; grouping them out
    // keeps the prod symbols a BA scans unpolluted and gives QA a "tests covering
    // the impacted code" list with a count. `writePathGaps` is filled by the
    // async schema-graph pass in `getImpactAnalysisDetail` (empty otherwise).
    affectedSymbols: allSymbols.filter((s) => !isTestFilePath(s.filePath)),
    affectedTests: allSymbols.filter((s) => isTestFilePath(s.filePath)),
    writePathGaps: [],
    affectedTables,
    affectedTablesSecondary,
    feedback: (item.feedback ?? []).map(toFeedbackView),
  };
}

// ── #962 — write-path coverage gaps ─────────────────────────────────────────

/** #962 — schema-edge kinds that MUTATE a table (its "write path"). */
const WRITE_EDGE_KINDS = ["writes", "persists-to"] as const;
/**
 * #962 — code-edge kinds by which a TEST symbol "covers" a writing symbol. Mirrors
 * the traceability-service test-detection pattern (an incoming call/import/ref
 * edge from a test-path file), so both features agree on what "a test reaches X".
 */
const TEST_COVERAGE_EDGE_KINDS = ["calls", "references", "imports"] as const;

/**
 * #1000 — code-edge kinds that bridge the **symbol-identity split** between the
 * symbol a test calls and the symbol that actually writes. In a MyBatis project the
 * writer is the `language=sql` statement symbol (`OrderMapper.xml::insertOrder`)
 * while the test calls the `language=java` mapper method
 * (`OrderMapper.java::insertOrder`) — two different `CodeSymbol` ids joined by an
 * `executes` edge (java → sql). Coverage therefore has to travel FORWARD along this
 * edge or every MyBatis write path is reported as untested (the #1000 false
 * positive), which is the same java↔sql split #928 fixed in `crossToSchema`.
 *
 * Deliberately narrower than #928's `DOWNSTREAM_CALL_EDGE_KINDS` in
 * `schema-impact.ts` (`calls` + `executes`): `executes` is a *delegation*
 * edge — the java facade IS the sql statement — whereas `calls` is an ordinary call.
 * Following `calls` here would silently upgrade "a test reaches the writer" into
 * "some test transitively reaches the writer", suppressing genuine gaps. Only the
 * identity bridge is followed.
 */
const WRITE_PATH_BRIDGE_EDGE_KINDS = ["executes"] as const;

/**
 * #1000 — maximum {@link WRITE_PATH_BRIDGE_EDGE_KINDS} hops coverage travels from a
 * covered symbol. One hop covers the java→sql mapper bridge; the small extra budget
 * absorbs a statement that delegates to another statement. Bounded (like #928's
 * downstream walk) so a pathological or cyclic graph can't blow the walk up.
 */
export const WRITE_PATH_BRIDGE_MAX_DEPTH = 2;

/**
 * #1011 — how many `calls` hops a test may take THROUGH PRODUCTION CODE before it
 * reaches the writer (or the java facade that {@link WRITE_PATH_BRIDGE_EDGE_KINDS}
 * it). Exactly **one**, and deliberately so.
 *
 * The shape being fixed is a single service layer between the test and the mapper:
 * `OrderServiceTest --calls--> OrderService.insertOrder --calls-->
 * OrderMapper.insertOrder --executes--> OrderMapper.xml::insertOrder`. One hop makes
 * the claim "the tested method DIRECTLY invokes the writer" — the same strength of
 * claim #1000 already accepts for a direct mapper test, just one frame down the
 * stack. Two hops would weaken it to "the tested method transitively reaches the
 * writer", where the writer may sit behind an unrelated branch of an unrelated
 * callee — that is a false-NEGATIVE generator (a genuinely untested mutation stops
 * being reported), which is the exact failure #1012 exists to remove. The bound is
 * therefore held at 1 until a real project demonstrates a two-layer need.
 *
 * Note this is NOT a widening of {@link propagateCoverageAcrossBridge}: coverage is
 * never spread forward over `calls` from arbitrary covered symbols. The hop is
 * applied ONCE, only from symbols a test *calls*, and only into symbols already
 * known to be on an impacted table's write path (see {@link ServiceCallEdgeFact}).
 */
export const WRITE_PATH_SERVICE_CALL_MAX_DEPTH = 1;

/**
 * #1011 — the code-edge kind for the service hop and for the test edge that seeds
 * it. Narrower than {@link TEST_COVERAGE_EDGE_KINDS} on purpose: `imports` and
 * `references` from a test file are evidence the test *mentions* a type, not that
 * it invokes the method whose body reaches the writer. Only a real invocation may
 * open the extra hop.
 */
const SERVICE_CALL_EDGE_KIND = "calls";

/** #962 — one `writes`/`persists-to` edge from a code symbol into an affected table. */
interface WriteEdgeFact {
  /** Physical/schema-qualified name of the affected table the edge writes. */
  targetTableName: string;
  fromSymbolId: string;
  fromQualifiedName: string;
  fromFilePath: string;
}

/** #962 — one incoming edge into a writing symbol (candidate test coverage). */
interface CoverageEdgeFact {
  toSymbolId: string;
  fromFilePath: string;
}

/**
 * #1000 — one {@link WRITE_PATH_BRIDGE_EDGE_KINDS} edge, oriented as stored
 * (`from` = the java facade, `to` = the sql statement it executes). Coverage
 * propagates from `fromSymbolId` to `toSymbolId`.
 */
interface BridgeEdgeFact {
  fromSymbolId: string;
  toSymbolId: string;
}

/**
 * #1011 — one `calls` edge INTO a symbol that is already known to be on an impacted
 * table's write path (a writer, or a java facade that `executes` one). `from` is the
 * intermediate — typically a service method; `to` is the writer/facade it invokes.
 *
 * The restriction on `to` is what keeps the hop bounded: these edges are collected
 * by walking BACKWARD from the write path, so the hop can only ever conclude "a test
 * reaches THIS writer", never "everything a covered symbol calls is covered".
 */
interface ServiceCallEdgeFact {
  fromSymbolId: string;
  toSymbolId: string;
}

/**
 * #1011 — the service-layer coverage inputs, kept in one bag so
 * {@link computeWritePathGaps} keeps a readable signature.
 */
interface ServiceLayerFacts {
  /** `calls` edges from an intermediate into a writer/facade (the single hop). */
  callEdges: ServiceCallEdgeFact[];
  /** Incoming edges into those intermediates — a test-file `calls` edge seeds the hop. */
  coverageEdges: ServiceCoverageEdgeFact[];
}

/**
 * #1011 — an incoming edge into a service-layer intermediate. Carries `kind` because,
 * unlike the direct-coverage rule, ONLY {@link SERVICE_CALL_EDGE_KIND} opens the hop.
 */
interface ServiceCoverageEdgeFact extends CoverageEdgeFact {
  kind: string;
}

const EMPTY_SERVICE_LAYER: ServiceLayerFacts = { callEdges: [], coverageEdges: [] };

/**
 * #962 — pure write-path coverage-gap classifier. Given the `writes`/`persists-to`
 * edges into an item's affected tables and the incoming edges into their writing
 * symbols, return one gap per table whose write path NO test reaches. Reuses the
 * shared {@link isTestFilePath} heuristic for BOTH sides: a test-authored write is
 * NOT a prod write path (skipped), and a test-file caller of a writing symbol IS
 * coverage. A table with a covered write path — or no prod write path at all —
 * yields no gap. Pure + deterministic — no I/O.
 *
 * #1000 — `bridgeEdges` carries the {@link WRITE_PATH_BRIDGE_EDGE_KINDS} identity
 * bridge so coverage of a java mapper method also covers the sql statement it
 * `executes`. Omit it (default `[]`) for the pre-#1000 exact-id intersection.
 *
 * #1012 — the verdict is per WRITING SYMBOL, not per table: a table is reported
 * whenever ANY of its writers is uncovered, listing exactly which ones.
 *
 * #1011 — `serviceLayer` allows a test to reach the writer through ONE `calls` hop
 * (a service method), so a service-layer test is not a false gap. Omit it (default
 * empty) to require the test to reach the writer or its facade directly.
 */
export function computeWritePathGaps(
  writeEdges: WriteEdgeFact[],
  coverageEdges: CoverageEdgeFact[],
  bridgeEdges: BridgeEdgeFact[] = [],
  serviceLayer: ServiceLayerFacts = EMPTY_SERVICE_LAYER,
): WritePathCoverageGap[] {
  // A writing symbol is COVERED when some TEST-path symbol has an edge into it.
  const coveredSymbolIds = new Set<string>();
  for (const e of coverageEdges) {
    if (isTestFilePath(e.fromFilePath)) coveredSymbolIds.add(e.toSymbolId);
  }
  // #1011 — take the ONE permitted `calls` hop through a service-layer intermediate
  // BEFORE the bridge spread, so `OrderServiceTest -> OrderService.insertOrder ->
  // OrderMapper.insertOrder` lands on the facade and the bridge carries it the rest
  // of the way. See WRITE_PATH_SERVICE_CALL_MAX_DEPTH for why the bound is 1.
  applyServiceLayerCoverage(coveredSymbolIds, serviceLayer);
  // #1000 — spread that coverage FORWARD across the identity bridge (bounded BFS,
  // mirroring #928's downstream walk): a test on `OrderMapper.java::insertOrder`
  // covers `OrderMapper.xml::insertOrder`, which is the symbol that writes.
  propagateCoverageAcrossBridge(coveredSymbolIds, bridgeEdges);
  // Group the PROD writing symbols per affected table (test-authored writes are
  // setup, not the production write path — excluded via the same heuristic).
  const byTable = new Map<string, Map<string, string>>();
  for (const e of writeEdges) {
    if (isTestFilePath(e.fromFilePath)) continue;
    const g = byTable.get(e.targetTableName) ?? new Map<string, string>();
    g.set(e.fromSymbolId, e.fromQualifiedName);
    byTable.set(e.targetTableName, g);
  }
  const gaps: WritePathCoverageGap[] = [];
  for (const [tableName, writers] of byTable) {
    // #1012 — partition PER WRITER. The pre-#1012 rule cleared the whole table as
    // soon as ONE writer was covered, so a table with a tested `insert` and an
    // untested `update` reported no gap at all — a silent false negative. Only the
    // uncovered writers are the gap; the covered ones are reported alongside so the
    // reader can tell "nothing tested" from "partially tested".
    const uncovered = new Set<string>();
    const covered = new Set<string>();
    for (const [id, name] of writers) {
      (coveredSymbolIds.has(id) ? covered : uncovered).add(name);
    }
    if (uncovered.size === 0) continue;
    gaps.push({
      tableName,
      writingSymbols: sortedNames(uncovered),
      // A writer may appear under BOTH ids if the graph carries duplicate symbols
      // for one qualified name; the uncovered listing wins so nothing is hidden.
      coveredWritingSymbols: sortedNames(covered).filter((n) => !uncovered.has(n)),
    });
  }
  return gaps.sort((a, b) => a.tableName.localeCompare(b.tableName));
}

/** Deterministic rendering order for a set of qualified names. */
function sortedNames(names: Set<string>): string[] {
  return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * #1011 — expand `coveredSymbolIds` IN PLACE with each writer/facade that is invoked
 * by an intermediate a TEST directly calls. Exactly {@link
 * WRITE_PATH_SERVICE_CALL_MAX_DEPTH} hop, applied once — NOT a fixpoint — and only
 * into `serviceLayer.callEdges` targets, which the loader restricts to symbols
 * already on an impacted table's write path. That containment is what stops this
 * from degrading into "everything a covered symbol transitively calls is covered".
 *
 * The seed is narrowed to {@link SERVICE_CALL_EDGE_KIND}: a test that merely imports
 * or references the service does not exercise its body. Pure, deterministic, O(edges).
 */
function applyServiceLayerCoverage(
  coveredSymbolIds: Set<string>,
  serviceLayer: ServiceLayerFacts,
): void {
  if (serviceLayer.callEdges.length === 0) return;
  const testCalledIds = new Set<string>();
  for (const e of serviceLayer.coverageEdges) {
    if (e.kind !== SERVICE_CALL_EDGE_KIND) continue;
    if (isTestFilePath(e.fromFilePath)) testCalledIds.add(e.toSymbolId);
  }
  if (testCalledIds.size === 0) return;
  for (const e of serviceLayer.callEdges) {
    if (testCalledIds.has(e.fromSymbolId)) coveredSymbolIds.add(e.toSymbolId);
  }
}

/**
 * #1000 — expand `coveredSymbolIds` IN PLACE with every symbol reachable from an
 * already-covered symbol over at most {@link WRITE_PATH_BRIDGE_MAX_DEPTH}
 * {@link WRITE_PATH_BRIDGE_EDGE_KINDS} hops. The visited set doubles as the result,
 * so cycles terminate. Pure (no I/O), deterministic, and bounded by the hop budget.
 */
function propagateCoverageAcrossBridge(
  coveredSymbolIds: Set<string>,
  bridgeEdges: BridgeEdgeFact[],
): void {
  if (bridgeEdges.length === 0 || coveredSymbolIds.size === 0) return;
  const targetsBySource = new Map<string, string[]>();
  for (const e of bridgeEdges) {
    const targets = targetsBySource.get(e.fromSymbolId);
    if (targets) targets.push(e.toSymbolId);
    else targetsBySource.set(e.fromSymbolId, [e.toSymbolId]);
  }
  let frontier = [...coveredSymbolIds];
  for (let hop = 0; hop < WRITE_PATH_BRIDGE_MAX_DEPTH && frontier.length > 0; hop++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const target of targetsBySource.get(id) ?? []) {
        if (coveredSymbolIds.has(target)) continue;
        coveredSymbolIds.add(target);
        next.push(target);
      }
    }
    frontier = next;
  }
}

/**
 * #962 — load the write-path coverage facts for ONE item, scoped to its project.
 * Resolves the item's affected relational tables/columns to schema-symbol ids,
 * reads their inbound `writes`/`persists-to` edges (the write path) and, for those
 * writing symbols, their inbound call/import/reference edges (candidate test
 * coverage). Read-only + project-scoped. Returns empty facts (⇒ no gaps) when the
 * item has no relational tables or the schema graph has no matching symbols/edges.
 *
 * #1000 — also walks the inbound {@link WRITE_PATH_BRIDGE_EDGE_KINDS} edges of the
 * writing symbols (bounded by {@link WRITE_PATH_BRIDGE_MAX_DEPTH}) so the java
 * mapper facades that `executes` them join the coverage lookup. The traversal stays
 * here; {@link computeWritePathGaps} remains pure.
 *
 * #1011 — additionally returns the SERVICE-LAYER facts: the non-test `calls` edges
 * INTO the write path (the candidate intermediates) plus the incoming edges of those
 * intermediates. Both are collected by walking backward FROM the write path, so the
 * extra hop can never reach a writer that this item does not already impact.
 */
async function loadWritePathFacts(
  prisma: SchemaGraphPrisma,
  projectId: string,
  affectedTables: ImpactAffectedTableView[],
): Promise<{
  writeEdges: WriteEdgeFact[];
  coverageEdges: CoverageEdgeFact[];
  bridgeEdges: BridgeEdgeFact[];
  serviceLayer: ServiceLayerFacts;
}> {
  const empty = {
    writeEdges: [],
    coverageEdges: [],
    bridgeEdges: [],
    serviceLayer: EMPTY_SERVICE_LAYER,
  };

  // Candidate schema-object qualified names → the physical table they belong to.
  const physicalByQn = new Map<string, string>();
  for (const t of affectedTables) {
    if (t.objectKind !== "table" && t.objectKind !== "column") continue;
    physicalByQn.set(t.tableName, t.tableName); // the table symbol itself
    if (t.objectKind === "column" && t.columnName) {
      physicalByQn.set(`${t.tableName}.${t.columnName}`, t.tableName); // a column symbol
    }
  }
  if (physicalByQn.size === 0) return empty;

  const symbols = await prisma.codeSymbol.findMany({
    where: {
      projectId,
      kind: { in: ["table", "column"] },
      qualifiedName: { in: [...physicalByQn.keys()] },
    },
    select: { id: true, qualifiedName: true },
  });
  const physicalBySymbolId = new Map<string, string>();
  for (const s of symbols) {
    const physical = physicalByQn.get(s.qualifiedName);
    if (physical) physicalBySymbolId.set(s.id, physical);
  }
  if (physicalBySymbolId.size === 0) return empty;

  const writeRows = await prisma.codeEdge.findMany({
    where: {
      projectId,
      kind: { in: [...WRITE_EDGE_KINDS] },
      toSymbolId: { in: [...physicalBySymbolId.keys()] },
    },
    select: {
      fromSymbolId: true,
      toSymbolId: true,
      fromSymbol: { select: { qualifiedName: true, filePath: true } },
    },
  });
  const writeEdges: WriteEdgeFact[] = [];
  for (const r of writeRows) {
    const targetTableName = r.toSymbolId ? physicalBySymbolId.get(r.toSymbolId) : undefined;
    if (!targetTableName || !r.fromSymbol) continue;
    writeEdges.push({
      targetTableName,
      fromSymbolId: r.fromSymbolId,
      fromQualifiedName: r.fromSymbol.qualifiedName,
      fromFilePath: r.fromSymbol.filePath,
    });
  }
  if (writeEdges.length === 0) return empty;

  const writingSymbolIds = [...new Set(writeEdges.map((e) => e.fromSymbolId))];

  // #1000 — walk UPSTREAM from each writing symbol over the identity bridge to
  // collect the java facades that `executes` it. Bounded to
  // WRITE_PATH_BRIDGE_MAX_DEPTH round-trips; `seen` keeps cycles finite.
  const bridgeEdges: BridgeEdgeFact[] = [];
  const seen = new Set(writingSymbolIds);
  const bridgeSourceIds: string[] = [];
  let frontier = writingSymbolIds;
  for (let hop = 0; hop < WRITE_PATH_BRIDGE_MAX_DEPTH && frontier.length > 0; hop++) {
    const bridgeRows = await prisma.codeEdge.findMany({
      where: {
        projectId,
        kind: { in: [...WRITE_PATH_BRIDGE_EDGE_KINDS] },
        toSymbolId: { in: frontier },
      },
      select: { fromSymbolId: true, toSymbolId: true },
    });
    const next: string[] = [];
    for (const r of bridgeRows) {
      if (!r.toSymbolId) continue;
      bridgeEdges.push({ fromSymbolId: r.fromSymbolId, toSymbolId: r.toSymbolId });
      if (seen.has(r.fromSymbolId)) continue;
      seen.add(r.fromSymbolId);
      bridgeSourceIds.push(r.fromSymbolId);
      next.push(r.fromSymbolId);
    }
    frontier = next;
  }

  // #1000 — coverage may land on the writer itself OR on a bridged java facade.
  const writePathIds = [...writingSymbolIds, ...bridgeSourceIds];
  const coverageRows = await prisma.codeEdge.findMany({
    where: {
      projectId,
      kind: { in: [...TEST_COVERAGE_EDGE_KINDS] },
      toSymbolId: { in: writePathIds },
    },
    select: {
      toSymbolId: true,
      kind: true,
      fromSymbolId: true,
      fromSymbol: { select: { filePath: true } },
    },
  });
  const coverageEdges: CoverageEdgeFact[] = [];
  // #1011 — the same rows also expose the SERVICE-LAYER intermediates: a `calls`
  // edge into the write path whose source is NOT a test file is a candidate hop
  // (`OrderService.insertOrder -> OrderMapper.insertOrder`). Collecting them here
  // rather than by a forward walk is what keeps the hop anchored to THIS write path.
  const serviceCallEdges: ServiceCallEdgeFact[] = [];
  const intermediateIds = new Set<string>();
  for (const r of coverageRows) {
    if (!r.toSymbolId || !r.fromSymbol) continue;
    coverageEdges.push({ toSymbolId: r.toSymbolId, fromFilePath: r.fromSymbol.filePath });
    if (r.kind !== SERVICE_CALL_EDGE_KIND || isTestFilePath(r.fromSymbol.filePath)) continue;
    serviceCallEdges.push({ fromSymbolId: r.fromSymbolId, toSymbolId: r.toSymbolId });
    intermediateIds.add(r.fromSymbolId);
  }

  // #1011 — one lookup for the tests that reach those intermediates. The `calls`-only
  // narrowing is enforced in the pure classifier (all TEST_COVERAGE_EDGE_KINDS are
  // fetched so that filter is exercised on real data, not assumed by the query).
  const serviceCoverageEdges: ServiceCoverageEdgeFact[] = [];
  if (intermediateIds.size > 0) {
    const rows = await prisma.codeEdge.findMany({
      where: {
        projectId,
        kind: { in: [...TEST_COVERAGE_EDGE_KINDS] },
        toSymbolId: { in: [...intermediateIds] },
      },
      select: { toSymbolId: true, kind: true, fromSymbol: { select: { filePath: true } } },
    });
    for (const r of rows) {
      if (!r.toSymbolId || !r.fromSymbol) continue;
      serviceCoverageEdges.push({
        toSymbolId: r.toSymbolId,
        kind: r.kind,
        fromFilePath: r.fromSymbol.filePath,
      });
    }
  }

  return {
    writeEdges,
    coverageEdges,
    bridgeEdges,
    serviceLayer: { callEdges: serviceCallEdges, coverageEdges: serviceCoverageEdges },
  };
}

/** Bare physical table name — strip an optional `schema.` prefix for grouping. */
function bareTableName(name: string): string {
  const i = name.lastIndexOf(".");
  return i === -1 ? name : name.slice(i + 1);
}

/**
 * Epic #954 (#956) — the run-level "shared impact" rollup: physical tables
 * impacted in TWO OR MORE of the run's projects. Pure + deterministic — derived
 * from the per-item affected tables, no persistence. Only relational objects
 * (`table`/`column`, collapsed to their physical table) participate; a table
 * touched by a single project is NOT shared and is omitted.
 */
export function computeSharedTableImpacts(items: ImpactItemView[]): SharedTableImpact[] {
  const projectsByTable = new Map<string, Set<string>>();
  for (const item of items) {
    for (const t of item.affectedTables) {
      if (t.objectKind !== "table" && t.objectKind !== "column") continue;
      const name = bareTableName(t.tableName);
      const set = projectsByTable.get(name) ?? new Set<string>();
      set.add(item.projectId);
      projectsByTable.set(name, set);
    }
  }
  const out: SharedTableImpact[] = [];
  for (const [tableName, projects] of projectsByTable) {
    if (projects.size < 2) continue;
    out.push({ tableName, projectIds: [...projects].sort((a, b) => a.localeCompare(b)) });
  }
  return out.sort((a, b) => a.tableName.localeCompare(b.tableName));
}

/**
 * List impact analyses, optionally scoped to those touching accessible projects.
 *
 * #61 — `projectId` narrows the list to runs that include that project, in the
 * query itself, so a project's runs are not lost behind the `limit` newest runs
 * of other projects. Each row names only the run's projects the caller can
 * access; `projectCount` still counts them all, exactly as before.
 */
export async function listImpactAnalyses(
  opts: {
    accessibleProjectIds?: string[] | null;
    limit?: number;
    projectId?: string;
    /**
     * #88 — the calling actor. A run with NO recoverable projects (pre-#70, no
     * items) is not attributable to any project, so #70 correctly hides it from
     * every non-admin — including the person who started it. Naming the actor
     * lets that one principal keep seeing their own run without reopening the
     * hatch for anybody else. Omitted ⇒ nobody sees such a run (fail closed).
     */
    actorId?: string;
  } = {},
  prisma?: ReadPrisma,
): Promise<ImpactAnalysisSummary[]> {
  const db = resolvePrisma(prisma);
  const rows = await db.impactAnalysis.findMany({
    // #70 — a run belongs to the projects it was STARTED for (`projects`, written
    // with the run) as well as those its items name. The `items` arm is kept for
    // runs created before that table existed, whose selection was never recorded.
    ...(opts.projectId
      ? {
          where: {
            OR: [
              { projects: { some: { projectId: opts.projectId } } },
              { items: { some: { projectId: opts.projectId } } },
            ],
          },
        }
      : {}),
    orderBy: { startedAt: "desc" },
    take: opts.limit ?? 100,
    include: {
      items: { select: { projectId: true } },
      projects: { select: { projectId: true } },
    },
  });

  const accessible = opts.accessibleProjectIds ? new Set(opts.accessibleProjectIds) : null;

  return rows
    .map((row) => {
      // #70 — started-for projects first, so a run in flight names them in the
      // order they were selected; item-derived ones follow.
      const projectIds = [
        ...new Set([
          ...(row.projects ?? []).map((p) => p.projectId),
          ...row.items.map((i) => i.projectId),
        ]),
      ];
      return { row, projectIds };
    })
    .filter(({ row, projectIds }) => {
      if (!accessible) return true;
      // #70 — no `projectIds.length === 0` escape hatch. It was written for runs
      // whose projects could not be derived from their items, and it showed every
      // such run — another member's in-progress run included — to EVERY caller.
      //
      // #88 — with one bounded exception, which is NOT that hatch: a run whose
      // projects are unrecoverable stays visible to the actor who STARTED it.
      // It admits at most that actor, and only for a run nothing else can
      // attribute; a run with known projects is still judged on those alone, so
      // starting a run never buys back access to a project you have lost.
      if (projectIds.length === 0) {
        return opts.actorId !== undefined && row.startedById === opts.actorId;
      }
      return projectIds.some((id) => accessible.has(id));
    })
    .map(({ row, projectIds }) => ({
      id: row.id,
      status: row.status as ImpactAnalysisStatus,
      documentId: row.documentId,
      summary: row.summary,
      projectCount: projectIds.length,
      projectIds: accessible ? projectIds.filter((id) => accessible.has(id)) : projectIds,
      totalImpactedSymbols: row.totalImpactedSymbols,
      startedAt: row.startedAt.toISOString(),
      completedAt: row.completedAt ? row.completedAt.toISOString() : null,
      // #965 — drift lineage: null for originals, the parent run id for re-runs.
      rerunOfId: row.rerunOfId ?? null,
    }));
}

/** Fetch the full per-project breakdown for one analysis, or null if missing. */
export async function getImpactAnalysisDetail(
  id: string,
  prisma?: ReadPrisma,
): Promise<ImpactAnalysisDetail | null> {
  const db = resolvePrisma(prisma);
  const row = await db.impactAnalysis.findFirst({
    where: { id },
    include: DETAIL_INCLUDE,
  });
  if (!row) return null;

  const items = (row.items as unknown as RawItem[]).map(toItemView);

  // #962 — best-effort write-path coverage gaps. Needs the code/schema graph
  // (`codeSymbol`/`codeEdge`); skipped (⇒ empty gaps) when the injected prisma
  // does not expose them. Additive + read-only — a failure NEVER breaks the
  // detail read.
  if (db.codeSymbol && db.codeEdge) {
    const schemaPrisma = db as SchemaGraphPrisma;
    await Promise.all(
      items.map(async (item) => {
        try {
          const { writeEdges, coverageEdges, bridgeEdges, serviceLayer } = await loadWritePathFacts(
            schemaPrisma,
            item.projectId,
            item.affectedTables,
          );
          item.writePathGaps = computeWritePathGaps(
            writeEdges,
            coverageEdges,
            bridgeEdges,
            serviceLayer,
          );
        } catch {
          item.writePathGaps = [];
        }
      }),
    );
  }

  // #88 — the run's projects are its PERSISTED selection (#70) first, then any
  // further project its items name. Deriving them from `items` alone reported a
  // run with no items yet as belonging to no project at all, and the read routes'
  // access guard skipped itself on that empty list (OWASP A01 / BOLA).
  const persistedProjectIds = (row.projects ?? []).map((p) => p.projectId);
  const projectIds = [...new Set([...persistedProjectIds, ...items.map((i) => i.projectId)])];

  return {
    id: row.id,
    status: row.status as ImpactAnalysisStatus,
    documentId: row.documentId,
    sourceText: row.sourceText,
    summary: row.summary,
    errorMessage: row.errorMessage,
    totalImpactedSymbols: row.totalImpactedSymbols,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    projectIds,
    // #88 — carried so the route layer can keep an unattributable legacy run
    // visible to its own starter without a second query.
    startedById: row.startedById,
    items,
    // #956 — physical tables impacted across ≥2 of the run's projects.
    sharedTableImpacts: computeSharedTableImpacts(items),
    // #965 — drift lineage: the original run this run re-executes (null for originals).
    rerunOfId: (row as { rerunOfId?: string | null }).rerunOfId ?? null,
  };
}
