/**
 * Epic #929 / Issue #930 — Impact Analysis recall eval fixture loader.
 *
 * Loads the committed, self-contained JPetStore-6-style manifest
 * (`eval-data/corpus/impact-recall-01-jpetstore/manifest.json`) and assembles the
 * collaborators the REAL impact engine (`computeProjectImpact`) needs, WITHOUT a
 * database, network, or live LLM. As of #939 the manifest is LAYERED — domain →
 * service → web-action → mapper (+ MyBatis statements) — so the assembled fixture
 * reproduces the live-ingested project's BM25 seed pollution and downstream
 * fan-out rather than the pre-#939 artificially-clean mapper-only corpus:
 *
 *   - `searcher`          — the production {@link Bm25CodeSymbolSearcher} over an
 *                           in-memory `codeSymbol.findMany` stub built from ALL
 *                           in-corpus symbols (domain classes, service/web-action/
 *                           mapper methods), so `mapRequirementToCode` runs its
 *                           genuine ranking logic against a realistically-polluted
 *                           corpus (swappable — see runner).
 *   - `codeDataSource`    — an in-memory {@link CodeGraphDataSource} for the
 *                           blast-radius traversal.
 *   - `schemaDataSource`  — an in-memory {@link SchemaImpactDataSource} exposing
 *                           the `executes`/`reads`/`writes` schema edges and the
 *                           `calls`/`executes` downstream-call edges the #928
 *                           crossing walks to reach tables.
 *
 * The same builders back a tiny in-code SYNTHETIC fixture ({@link buildSyntheticFixture})
 * whose crossing outcome is hand-computable, so a unit test can assert the whole
 * harness (engine + crossing + scorer) reports the exact recall/precision.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PrismaClient } from "@prisma/client";
import type { SchemaEdgeKind } from "@metis/shared";
import { SCHEMA_IMPACT_EDGE_KINDS } from "@metis/shared";
import {
  Bm25CodeSymbolSearcher,
  type CodeSymbolSearcher,
} from "../../traceability/requirement-code-mapping.js";
import { InMemoryCodeGraphDataSource } from "../../impact-analysis/impact-analysis-engine.js";
import type {
  CodeGraphDataSource,
  GraphEdge,
  GraphSymbol,
} from "../../code-graph/query-service.js";
import type { SchemaImpactDataSource } from "../../impact-analysis/schema-impact.js";
import {
  buildEntityVocabulary,
  type EntityVocabulary,
} from "../../traceability/requirement-entity-seeds.js";
import { assertCorpusNameConvention } from "./name-convention.js";

// ── Manifest shapes ─────────────────────────────────────────────────────────

/** A code symbol in the fixture (mapper method or MyBatis statement). */
export interface FixtureCodeSymbol {
  id: string;
  name: string;
  qualifiedName: string;
  kind: string;
  filePath: string;
  language: string;
  /** True ⇒ visible to the BM25 corpus (a mapper method); false ⇒ statement-only. */
  inCorpus: boolean;
  /**
   * #959 — the project that owns this symbol in a MULTI-PROJECT (cross-project)
   * corpus. Absent in single-project corpora (corpus-01), where every symbol
   * belongs to `manifest.projectId`. Used to attribute shared-table usage to a
   * project so the cross-project consumer set is derivable ({@link computeSharedTableConsumers}).
   */
  projectId?: string;
}

/**
 * #959 — a project participating in a cross-project corpus. Purely descriptive
 * metadata: the shared-DB scenario models N applications over one physical
 * database, and `role` documents each app's part (e.g. `storefront`,
 * `reporting-batch`). Absent in single-project corpora.
 */
export interface FixtureProject {
  id: string;
  title: string;
  role: string;
}

/** A schema table symbol in the fixture. */
export interface FixtureTable {
  id: string;
  name: string;
  qualifiedName: string;
  kind: "table" | "column" | "procedure" | "function";
  source: string;
}

/** A declared edge, endpoints by qualifiedName. */
export interface FixtureEdge {
  from: string;
  to: string;
  kind: SchemaEdgeKind | "calls";
}

/** A labeled requirement — `expectedTables` is the primary signal. */
export interface FixtureRequirement {
  id: string;
  text: string;
  expectedTables: string[];
  expectedCodeSymbols?: string[];
  /**
   * #959 — the OTHER project ids an impact run should flag as shared-table
   * consumers. Present (even `[]`) only in cross-project corpora; a present `[]`
   * asserts the affected table is NOT shared (a true-negative that still scores
   * precision). Absent ⇒ not consumer-scored.
   */
  expectedConsumers?: string[];
}

/** The committed manifest. */
export interface ImpactRecallManifest {
  version: number;
  id: string;
  title: string;
  note: string;
  projectId: string;
  tables: FixtureTable[];
  codeSymbols: FixtureCodeSymbol[];
  edges: FixtureEdge[];
  requirements: FixtureRequirement[];
  /**
   * #959 — the participating projects for a cross-project corpus (absent in
   * single-project corpora). Descriptive only; the runnable graph is still the
   * flat `codeSymbols`/`edges`/`tables` pooled under `projectId`.
   */
  projects?: FixtureProject[];
}

/** The assembled, ready-to-run fixture. */
export interface ImpactRecallFixture {
  manifest: ImpactRecallManifest;
  projectId: string;
  /** Production BM25 searcher over the in-corpus symbols (no DB). */
  searcher: CodeSymbolSearcher;
  /** In-memory code graph for the blast-radius traversal. */
  codeDataSource: CodeGraphDataSource;
  /** In-memory schema graph for the #928 code→table crossing. */
  schemaDataSource: SchemaImpactDataSource;
  requirements: FixtureRequirement[];
}

/** The downstream-call edge kinds the #928 crossing walks (mirrors schema-impact.ts). */
const DOWNSTREAM_CALL_EDGE_KINDS: ReadonlySet<string> = new Set(["calls", "executes"]);
const SCHEMA_EDGE_SET: ReadonlySet<string> = new Set(SCHEMA_IMPACT_EDGE_KINDS);

/**
 * The registry of committed impact-recall corpora (#959). Names map 1:1 to the
 * `eval-data/corpus/<name>/manifest.json` directories so the CLI `--corpus <name>`
 * flag can resolve a corpus without a filesystem probe. The first entry is the
 * default single-project (corpus-01) fixture.
 */
export const IMPACT_RECALL_CORPORA = [
  "impact-recall-01-jpetstore",
  "impact-recall-02-shared-db",
] as const;

/** A registered corpus name. */
export type ImpactRecallCorpusName = (typeof IMPACT_RECALL_CORPORA)[number];

/** The default corpus (single-project JPetStore-6). */
export const DEFAULT_IMPACT_RECALL_CORPUS: ImpactRecallCorpusName = "impact-recall-01-jpetstore";

/** Absolute path of the `eval-data/corpus` root (repo-relative to this module). */
function corpusRoot(): string {
  // server/src/lib/eval/impact-recall → repo root is six levels up.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../../../eval-data/corpus");
}

/**
 * Resolve a registered corpus name to its absolute directory (#959). Throws with
 * the known names on an unknown corpus so a typo fails loud rather than silently
 * loading the default.
 */
export function resolveCorpusDir(name: string): string {
  if (!(IMPACT_RECALL_CORPORA as readonly string[]).includes(name)) {
    throw new Error(
      `unknown impact-recall corpus: ${JSON.stringify(name)}. ` +
        `Known corpora: ${IMPACT_RECALL_CORPORA.join(", ")}.`,
    );
  }
  return path.join(corpusRoot(), name);
}

/** Default absolute directory of the committed fixture. */
export function defaultImpactRecallFixtureDir(): string {
  return resolveCorpusDir(DEFAULT_IMPACT_RECALL_CORPUS);
}

/**
 * #959 — derive, for each shared table, the SET of projects that read/write it in
 * a cross-project corpus. A table is a cross-project consumer target when ≥2
 * distinct projects touch it. Pure over the manifest: it resolves each
 * schema-edge source (a MyBatis statement / routine) back to the owning project
 * via the code symbol's `projectId`.
 *
 * This is the GROUND-TRUTH derivation the future identity/string-match wiring
 * (#955/#956) must reproduce at runtime; the harness does NOT call it to seed
 * `foundConsumers` (that would green-wash the baseline — the ENGINE does not yet
 * surface consumers). It is exposed for corpus-integrity checks and reuse.
 */
export function computeSharedTableConsumers(
  manifest: ImpactRecallManifest,
): Map<string, Set<string>> {
  const projectBySymbolQn = new Map<string, string>();
  for (const s of manifest.codeSymbols) {
    projectBySymbolQn.set(s.qualifiedName, s.projectId ?? manifest.projectId);
  }
  const tableQnToName = new Map(manifest.tables.map((t) => [t.qualifiedName, t.name]));

  const byTable = new Map<string, Set<string>>();
  for (const e of manifest.edges) {
    if (e.kind !== "reads" && e.kind !== "writes" && e.kind !== "persists-to") continue;
    const tableName = tableQnToName.get(e.to);
    if (!tableName) continue;
    const project = projectBySymbolQn.get(e.from);
    if (!project) continue;
    const set = byTable.get(tableName) ?? new Set<string>();
    set.add(project);
    byTable.set(tableName, set);
  }
  return byTable;
}

/**
 * #956 — the runtime cross-project CONSUMER resolver the harness wires for a
 * cross-project corpus (the #955/#956 seam). Given the tables + code symbols the
 * REAL engine surfaced for a requirement, return the OTHER project ids that also
 * read/write those shared tables — the harness analogue of the production
 * identity/string-match wiring.
 *
 * HONEST — not green-washing:
 *   - The consumer set is derived from the fixture GRAPH via
 *     {@link computeSharedTableConsumers} (edges + `codeSymbol.projectId`), NEVER
 *     from the manifest's `expectedConsumers` labels.
 *   - It is keyed on the ENGINE's own output: `foundTables` (which tables the
 *     crossing surfaced) and `foundCodeSymbols` (which project's code the run
 *     seeded, to identify + exclude the SOURCE project). So a run that fails to
 *     surface the shared table surfaces no consumer either — the recall lift is
 *     real, measured off the engine, not asserted from the answer key.
 *
 * Deterministic + stable-sorted.
 */
export function resolveFixtureConsumers(args: {
  foundTables: string[];
  foundCodeSymbols: string[];
  fixture: ImpactRecallFixture;
}): string[] {
  const { manifest } = args.fixture;
  const projectByQn = new Map<string, string>();
  for (const s of manifest.codeSymbols) {
    projectByQn.set(s.qualifiedName, s.projectId ?? manifest.projectId);
  }
  // The SOURCE project(s): the owners of the code symbols the run seeded. These
  // are excluded from the consumer set (an impact run reports OTHER apps).
  const sourceProjects = new Set<string>();
  for (const qn of args.foundCodeSymbols) {
    const p = projectByQn.get(qn);
    if (p) sourceProjects.add(p);
  }

  const consumersByTable = computeSharedTableConsumers(manifest);
  const consumers = new Set<string>();
  for (const table of args.foundTables) {
    const projects = consumersByTable.get(table);
    if (!projects) continue;
    for (const p of projects) if (!sourceProjects.has(p)) consumers.add(p);
  }
  return [...consumers].sort((a, b) => a.localeCompare(b));
}

/**
 * #959 — the names of tables touched by ≥2 projects in a cross-project corpus.
 * Empty for a single-project corpus.
 */
export function sharedTablesOf(manifest: ImpactRecallManifest): string[] {
  const consumers = computeSharedTableConsumers(manifest);
  return [...consumers.entries()]
    .filter(([, projects]) => projects.size >= 2)
    .map(([table]) => table)
    .sort((a, b) => a.localeCompare(b));
}

/** Enclosing type of a fully-qualified name — everything up to the last `.`. */
function enclosingTypeOf(qualifiedName: string): string | null {
  const i = qualifiedName.lastIndexOf(".");
  return i <= 0 ? null : qualifiedName.slice(0, i);
}

/**
 * Wrap the fixture's in-corpus symbols in a `codeSymbol.findMany`-shaped stub so
 * the REAL {@link Bm25CodeSymbolSearcher} runs unmodified against them (project-
 * scoped filter included, exactly like the Prisma-backed path).
 */
export function buildBm25Searcher(symbols: FixtureCodeSymbol[]): CodeSymbolSearcher {
  const corpus = symbols.filter((s) => s.inCorpus);
  const stub = {
    codeSymbol: {
      async findMany(args: { where?: { projectId?: string } }) {
        // Project scoping is a no-op here (single-project fixture) but mirrors the
        // real query shape; the searcher only reads the returned rows.
        void args?.where?.projectId;
        return corpus.map((s) => ({
          id: s.id,
          name: s.name,
          qualifiedName: s.qualifiedName,
          kind: s.kind,
          filePath: s.filePath,
          startLine: 1,
          endLine: 2,
        }));
      },
    },
  } as unknown as Pick<PrismaClient, "codeSymbol">;
  return new Bm25CodeSymbolSearcher(stub);
}

function toGraphSymbol(s: FixtureCodeSymbol): GraphSymbol {
  return {
    id: s.id,
    qualifiedName: s.qualifiedName,
    kind: s.kind,
    filePath: s.filePath,
    language: s.language,
    startLine: 1,
    endLine: 2,
  };
}

/**
 * Build an in-memory {@link CodeGraphDataSource} for the blast-radius walk. Only
 * the code-graph edge kinds (`calls`/`imports`/`defines`/`references`) are fed
 * in; the schema/executes edges live in the schema data source.
 */
export function buildCodeDataSource(
  symbols: FixtureCodeSymbol[],
  edges: FixtureEdge[],
  idByQn: Map<string, string>,
): CodeGraphDataSource {
  const graphSymbols = symbols.map(toGraphSymbol);
  const codeEdges: GraphEdge[] = edges
    .filter((e) => e.kind === "calls")
    .map((e, i) => ({
      id: `code-edge-${i}`,
      fromSymbolId: idByQn.get(e.from) ?? e.from,
      toSymbolId: idByQn.get(e.to) ?? e.to,
      kind: "calls" as const,
    }));
  return new InMemoryCodeGraphDataSource(graphSymbols, codeEdges);
}

/**
 * Build an in-memory {@link SchemaImpactDataSource} that mirrors
 * `PrismaSchemaImpactDataSource` semantics: schema edges (`reads`/`writes`/
 * `persists-to`/`executes`), the downstream `calls`/`executes` reachability
 * edges, table/column resolution, and the DAO/mapper sibling hooks (#922).
 */
export function buildSchemaDataSource(
  symbols: FixtureCodeSymbol[],
  tables: FixtureTable[],
  edges: FixtureEdge[],
  idByQn: Map<string, string>,
): SchemaImpactDataSource {
  const resolvedEdges = edges.map((e) => ({
    fromSymbolId: idByQn.get(e.from) ?? e.from,
    toSymbolId: idByQn.get(e.to) ?? e.to,
    kind: e.kind,
  }));
  const tableById = new Map(tables.map((t) => [t.id, t]));
  const codeById = new Map(symbols.map((s) => [s.id, s]));

  return {
    async getSchemaEdgesFrom(symbolIds) {
      const want = new Set(symbolIds);
      return resolvedEdges
        .filter((e) => want.has(e.fromSymbolId) && SCHEMA_EDGE_SET.has(e.kind))
        .map((e) => ({
          fromSymbolId: e.fromSymbolId,
          toSymbolId: e.toSymbolId,
          kind: e.kind as SchemaEdgeKind,
        }));
    },
    async getDownstreamCallEdgesFrom(symbolIds) {
      const want = new Set(symbolIds);
      return resolvedEdges
        .filter((e) => want.has(e.fromSymbolId) && DOWNSTREAM_CALL_EDGE_KINDS.has(e.kind))
        .map((e) => ({ fromSymbolId: e.fromSymbolId, toSymbolId: e.toSymbolId }));
    },
    async getSchemaSymbolsByIds(ids) {
      const want = new Set(ids);
      const out = [];
      for (const id of want) {
        const t = tableById.get(id);
        if (t)
          out.push({
            id: t.id,
            kind: t.kind,
            name: t.name,
            qualifiedName: t.qualifiedName,
            source: t.source as never,
          });
      }
      return out;
    },
    async getCodeSymbolsByIds(ids) {
      const want = new Set(ids);
      const out = [];
      for (const id of want) {
        const s = codeById.get(id);
        if (s) out.push({ id: s.id, kind: s.kind, qualifiedName: s.qualifiedName });
      }
      return out;
    },
    async getSiblingMethodIds(enclosingTypes) {
      const want = new Set(enclosingTypes);
      return symbols
        .filter(
          (s) =>
            s.kind === "method" &&
            s.language !== "sql" &&
            (enclosingTypeOf(s.qualifiedName) ?? "") !== "" &&
            want.has(enclosingTypeOf(s.qualifiedName) as string),
        )
        .map((s) => ({ id: s.id, kind: s.kind, qualifiedName: s.qualifiedName }));
    },
  };
}

/**
 * #1002 — the GROUNDING vocabulary for the entity-seed recall union, derived from
 * the fixture's own graph via the SAME pure builder the production Prisma loader
 * uses. The eval therefore grounds against exactly what a real project would offer,
 * including the #1003 exclusion of `src/site/**` documentation rows: a union that
 * re-seeds those noise rows is a measurable code-precision regression, not a silent
 * one.
 */
export function fixtureEntityVocabulary(manifest: ImpactRecallManifest): EntityVocabulary {
  return buildEntityVocabulary([
    ...manifest.tables.map((t) => ({
      name: t.name,
      qualifiedName: t.qualifiedName,
      kind: t.kind,
      filePath: null,
    })),
    ...manifest.codeSymbols
      .filter((s) => s.inCorpus)
      .map((s) => ({
        name: s.name,
        qualifiedName: s.qualifiedName,
        kind: s.kind,
        filePath: s.filePath,
        language: s.language,
      })),
  ]);
}

/**
 * #1029 — the project table->columns catalog derived from the manifest, for the
 * column-informed table-relevance recovery judge. Table rows supply the names;
 * `kind:"column"` rows (qualifiedName `<table>.<column>`) supply each table columns.
 * Pure over the manifest.
 */
export function fixtureTableCatalog(
  manifest: ImpactRecallManifest,
): { tableName: string; columns: string[] }[] {
  const columnsByTable = new Map<string, string[]>();
  for (const row of manifest.tables) {
    if (row.kind !== "column") continue;
    const dot = row.qualifiedName.lastIndexOf(".");
    if (dot <= 0) continue;
    const table = row.qualifiedName.slice(0, dot);
    const arr = columnsByTable.get(table) ?? [];
    arr.push(row.name);
    columnsByTable.set(table, arr);
  }
  return manifest.tables
    .filter((t) => t.kind === "table")
    .map((t) => ({ tableName: t.name, columns: columnsByTable.get(t.qualifiedName) ?? [] }));
}

/** Assemble a ready-to-run fixture from a parsed manifest. */
export function assembleFixture(manifest: ImpactRecallManifest): ImpactRecallFixture {
  const idByQn = new Map<string, string>();
  for (const s of manifest.codeSymbols) idByQn.set(s.qualifiedName, s.id);
  for (const t of manifest.tables) idByQn.set(t.qualifiedName, t.id);

  return {
    manifest,
    projectId: manifest.projectId,
    searcher: buildBm25Searcher(manifest.codeSymbols),
    codeDataSource: buildCodeDataSource(manifest.codeSymbols, manifest.edges, idByQn),
    schemaDataSource: buildSchemaDataSource(
      manifest.codeSymbols,
      manifest.tables,
      manifest.edges,
      idByQn,
    ),
    requirements: manifest.requirements,
  };
}

/** Load and assemble the committed JPetStore-6 fixture from disk. */
export async function loadImpactRecallFixture(
  dir = defaultImpactRecallFixtureDir(),
): Promise<ImpactRecallFixture> {
  const raw = await fs.readFile(path.join(dir, "manifest.json"), "utf8");
  const manifest = JSON.parse(raw) as ImpactRecallManifest;
  if (!manifest.codeSymbols?.length) throw new Error("impact-recall fixture has no code symbols");
  if (!manifest.requirements?.length) throw new Error("impact-recall fixture has no requirements");
  // #1016 — a corpus whose qualified names are shaped differently from what ingest
  // emits measures a world that does not ship, and does so SILENTLY. Fail before
  // producing a single number.
  assertCorpusNameConvention(manifest);
  return assembleFixture(manifest);
}

/**
 * A tiny SYNTHETIC fixture with a hand-computable crossing outcome, used to
 * assert the harness's own metric math end-to-end (engine + crossing + scorer):
 *
 *   DataMapper.readAlpha →(executes)→ statement →(reads)→ alpha
 *   DataMapper.readBeta  →(executes)→ statement →(reads)→ beta
 *
 * The mapper/method names are deliberately entity-neutral (`DataMapper`,
 * `readAlpha`/`readBeta`) so the BM25 token `alpha` seeds ONLY `readAlpha` — no
 * cross-pollution — while both methods still share the `DataMapper` enclosing
 * type so DAO sibling expansion is exercised. Requirement "alpha" seeds
 * `readAlpha`, crosses to `alpha`. With DAO sibling expansion ON, `readBeta` (a
 * sibling of the same mapper) additionally surfaces `beta` at reduced confidence
 * — the exact over-broad behaviour that lowers precision. Both outcomes are
 * asserted in the unit test.
 */
export function buildSyntheticFixture(): ImpactRecallFixture {
  const manifest: ImpactRecallManifest = {
    version: 1,
    id: "impact-recall-synthetic",
    title: "Synthetic self-test fixture",
    note: "Hand-computable crossing outcome for metric-math self-test.",
    projectId: "impact-recall-synthetic-project",
    tables: [
      { id: "t_alpha", name: "alpha", qualifiedName: "alpha", kind: "table", source: "mybatis" },
      { id: "t_beta", name: "beta", qualifiedName: "beta", kind: "table", source: "mybatis" },
    ],
    codeSymbols: [
      {
        id: "m_readalpha",
        name: "readAlpha",
        qualifiedName: "DataMapper.java::DataMapper::readAlpha",
        kind: "method",
        filePath: "DataMapper.java",
        language: "java",
        inCorpus: true,
      },
      {
        id: "s_readalpha",
        name: "readAlpha.statement",
        qualifiedName: "syn.DataMapper.readAlpha.statement",
        kind: "method",
        filePath: "DataMapper.xml",
        language: "sql",
        inCorpus: false,
      },
      {
        id: "m_readbeta",
        name: "readBeta",
        qualifiedName: "DataMapper.java::DataMapper::readBeta",
        kind: "method",
        filePath: "DataMapper.java",
        language: "java",
        inCorpus: true,
      },
      {
        id: "s_readbeta",
        name: "readBeta.statement",
        qualifiedName: "syn.DataMapper.readBeta.statement",
        kind: "method",
        filePath: "DataMapper.xml",
        language: "sql",
        inCorpus: false,
      },
    ],
    edges: [
      {
        from: "DataMapper.java::DataMapper::readAlpha",
        to: "syn.DataMapper.readAlpha.statement",
        kind: "executes",
      },
      { from: "syn.DataMapper.readAlpha.statement", to: "alpha", kind: "reads" },
      {
        from: "DataMapper.java::DataMapper::readBeta",
        to: "syn.DataMapper.readBeta.statement",
        kind: "executes",
      },
      { from: "syn.DataMapper.readBeta.statement", to: "beta", kind: "reads" },
    ],
    requirements: [
      {
        id: "S1",
        text: "alpha",
        expectedTables: ["alpha"],
        expectedCodeSymbols: ["readAlpha"],
      },
      {
        id: "S2",
        text: "beta",
        expectedTables: ["beta", "gamma"],
        expectedCodeSymbols: ["readBeta"],
      },
    ],
  };
  return assembleFixture(manifest);
}
