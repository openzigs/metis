/**
 * Epic #726 / Issue #738 — self-contained requirement→code mapping eval
 * fixture loader.
 *
 * Loads the synthesized micro-repo committed under
 * `eval-data/corpus/reqmap-01-precision-recall/`, parses every source file with
 * METIS's OWN parser (reusing {@link buildSymbolsFromRepo} from the #717 code-
 * graph eval — no network, no DB, no embedder), and assembles the pieces the
 * B2 mapping path needs:
 *
 *   - `searcher`   — the REAL {@link Bm25CodeSymbolSearcher} (production BM25
 *                    ranker) backed by an in-memory `codeSymbol.findMany` stub,
 *                    so `mapRequirementToCode` runs its genuine ranking logic,
 *   - `dataSource` — an in-memory {@link CodeGraphDataSource} built from the
 *                    parsed symbols + the fixture's declared call edges, so
 *                    `blastRadius` walks real upstream callers,
 *   - `cases`      — the requirement→changed-files ground-truth pairs (replayed
 *                    PRs) the runner scores against.
 *
 * Edges are declared by symbol NAME in `reqmap.json` and resolved to symbol ids
 * here, so the fixture author never has to hand-write generated ids.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PrismaClient } from "@prisma/client";
import { buildSymbolsFromRepo, type EvalCodeSymbol } from "../codegraph/fixture.js";
import {
  ANALYSIS_LINK_SEARCH_OPTIONS,
  Bm25CodeSymbolSearcher,
  MemoizingBm25CodeSymbolSearcher,
  type Bm25SearcherOptions,
  type CodeSymbolSearcher,
} from "../../traceability/requirement-code-mapping.js";
import { formatSymbolForEmbedding, type SymbolKind } from "../../code-graph/symbol-embeddings.js";
import type { EmbeddableSymbol } from "../recorded-vectors.js";
import type {
  CodeGraphDataSource,
  EdgeKind,
  GraphEdge,
  GraphSymbol,
} from "../../code-graph/query-service.js";

/** A declared call edge in the fixture, by symbol name. */
export interface FixtureEdgeSpec {
  from: string;
  to: string;
  kind: EdgeKind;
}

/** One replayed-PR ground-truth case. */
export interface ReqMapCase {
  /** Replayed-PR id (e.g. `PR-101`). */
  id: string;
  /** The requirement / change description fed to the mapper. */
  requirement: string;
  /** Files the real PR actually changed (the relevant set). */
  changedFiles: string[];
}

/** Descriptor committed alongside the synthesized repo (`reqmap.json`). */
export interface ReqMapFixtureSpec {
  id: string;
  title: string;
  kind: string;
  note: string;
  edges: FixtureEdgeSpec[];
  cases: ReqMapCase[];
}

export interface ReqMapFixture {
  spec: ReqMapFixtureSpec;
  projectId: string;
  symbols: EvalCodeSymbol[];
  /** Production BM25 searcher over the in-memory symbols (no DB). */
  searcher: CodeSymbolSearcher;
  /**
   * #1097 — the symbols with the text production embeds for each (kind, name,
   * file and the first body lines, `formatSymbolForEmbedding`), for the hybrid arm.
   */
  embeddable: EmbeddableSymbol[];
  /** In-memory code graph for the blast-radius traversal. */
  dataSource: CodeGraphDataSource;
  cases: ReqMapCase[];
}

/** The canonical fixture project id used for scoping in the eval. */
export const REQMAP_FIXTURE_PROJECT_ID = "reqmap-eval-project";

/** Default absolute directory of the committed fixture. */
export function defaultReqMapFixtureDir(): string {
  // server/src/lib/eval/reqmap → repo root is five levels up.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../../../eval-data/corpus/reqmap-01-precision-recall");
}

async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function recur(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) await recur(abs);
      else out.push(abs);
    }
  }
  await recur(root);
  return out;
}

/**
 * Wrap the parsed fixture symbols in a `codeSymbol.findMany`-shaped stub so the
 * REAL {@link Bm25CodeSymbolSearcher} runs unmodified against them (project-
 * scoped filter included, exactly like the Prisma-backed path).
 */
export function buildBm25Searcher(
  symbols: EvalCodeSymbol[],
  // #1063 — the analysis path's settings, since that is the path this eval
  // replays. Pass `{ minSharedTerms: 1 }` for the pre-#1063 arm, or
  // `{ minSharedTerms: ANALYSIS_LINK_MIN_SHARED_TERMS }` for the arm before the
  // run-9 subject rules.
  options: Bm25SearcherOptions = ANALYSIS_LINK_SEARCH_OPTIONS,
): CodeSymbolSearcher {
  return new Bm25CodeSymbolSearcher(symbolStub(symbols), options);
}

/**
 * #1097 — the memoizing BM25 searcher the hybrid arm turns its hits into
 * candidates with (and falls back to), with the analysis path's options.
 */
export function buildMemoizingBm25Searcher(
  symbols: EvalCodeSymbol[],
  options: Bm25SearcherOptions = ANALYSIS_LINK_SEARCH_OPTIONS,
): MemoizingBm25CodeSymbolSearcher {
  return new MemoizingBm25CodeSymbolSearcher(symbolStub(symbols), options);
}

function symbolStub(symbols: EvalCodeSymbol[]): Pick<PrismaClient, "codeSymbol"> {
  const stub = {
    codeSymbol: {
      async findMany(args: { where?: { projectId?: string } }) {
        const projectId = args?.where?.projectId;
        return symbols
          .filter((s) => projectId == null || s.projectId === projectId)
          .map((s) => ({
            id: s.id,
            name: s.name,
            qualifiedName: s.qualifiedName,
            kind: s.kind,
            filePath: s.filePath,
            startLine: s.startLine,
            endLine: s.endLine,
          }));
      },
    },
  } as unknown as Pick<PrismaClient, "codeSymbol">;
  return stub;
}

/** #1097 — the text production would embed for each symbol (no context lines: the fixture has none). */
export function embeddableSymbols(
  symbols: EvalCodeSymbol[],
  files: ReadonlyArray<{ relPath: string; content: string }>,
): EmbeddableSymbol[] {
  const lines = new Map(files.map((f) => [f.relPath, f.content.split("\n")]));
  return symbols.map((s) => ({
    symbolId: s.id,
    name: s.name,
    qualifiedName: s.qualifiedName,
    kind: s.kind,
    filePath: s.filePath,
    embeddingText: formatSymbolForEmbedding({
      kind: s.kind as SymbolKind,
      name: s.name,
      filePath: s.filePath,
      bodyLines: (lines.get(s.filePath) ?? []).slice(s.startLine - 1, s.endLine),
    } as Parameters<typeof formatSymbolForEmbedding>[0]),
  }));
}

/** #1097 — the committed recorded vectors of the fixture (`recorded-vectors.ts`). */
export function defaultReqMapVectorsFile(dir = defaultReqMapFixtureDir()): string {
  return path.join(dir, "vectors.gte-modernbert-base.json");
}

/**
 * Build an in-memory {@link CodeGraphDataSource} from the parsed symbols and the
 * fixture's name-declared edges. Edge endpoints are resolved to symbol ids;
 * a name that resolves to zero or multiple symbols is a fixture authoring error
 * and throws (keeping the fixture honest).
 */
export function buildInMemoryDataSource(
  symbols: EvalCodeSymbol[],
  edgeSpecs: FixtureEdgeSpec[],
): CodeGraphDataSource {
  const byId = new Map(symbols.map((s) => [s.id, s]));
  const idByName = new Map<string, string[]>();
  for (const s of symbols) {
    const list = idByName.get(s.name) ?? [];
    list.push(s.id);
    idByName.set(s.name, list);
  }
  const resolve = (name: string): string => {
    const ids = idByName.get(name);
    if (!ids || ids.length === 0)
      throw new Error(`Fixture edge references unknown symbol: ${name}`);
    if (ids.length > 1) throw new Error(`Fixture edge symbol name is ambiguous: ${name}`);
    return ids[0];
  };

  const edges: GraphEdge[] = edgeSpecs.map((e, i) => ({
    id: `edge-${i}`,
    fromSymbolId: resolve(e.from),
    toSymbolId: resolve(e.to),
    kind: e.kind,
  }));

  const toGraphSymbol = (s: EvalCodeSymbol): GraphSymbol => ({
    id: s.id,
    qualifiedName: s.qualifiedName,
    kind: s.kind,
    filePath: s.filePath,
    language: s.language,
    startLine: s.startLine,
    endLine: s.endLine,
  });

  return {
    async getSymbol(symbolId) {
      const s = byId.get(symbolId);
      return s ? toGraphSymbol(s) : null;
    },
    async getEdgesFrom(symbolId) {
      return edges.filter((e) => e.fromSymbolId === symbolId);
    },
    async getEdgesTo(symbolId) {
      return edges.filter((e) => e.toSymbolId === symbolId);
    },
    async getSymbolsByFile(filePath) {
      return symbols.filter((s) => s.filePath === filePath).map(toGraphSymbol);
    },
    async getSymbolsByIds(ids) {
      const want = new Set(ids);
      return symbols.filter((s) => want.has(s.id)).map(toGraphSymbol);
    },
  };
}

/** Load and assemble the full fixture from disk. */
export async function loadReqMapFixture(dir = defaultReqMapFixtureDir()): Promise<ReqMapFixture> {
  const specRaw = await fs.readFile(path.join(dir, "reqmap.json"), "utf8");
  const spec = JSON.parse(specRaw) as ReqMapFixtureSpec;

  const repoRoot = path.join(dir, "repo");
  const absFiles = await walkFiles(repoRoot);
  const files = await Promise.all(
    absFiles.map(async (abs) => ({
      relPath: path.relative(repoRoot, abs).split(path.sep).join("/"),
      content: await fs.readFile(abs, "utf8"),
    })),
  );

  const symbols = buildSymbolsFromRepo(files, REQMAP_FIXTURE_PROJECT_ID);
  if (symbols.length === 0) throw new Error("reqmap fixture parsed no symbols");

  const searcher = buildBm25Searcher(symbols);
  const dataSource = buildInMemoryDataSource(symbols, spec.edges);

  return {
    spec,
    projectId: REQMAP_FIXTURE_PROJECT_ID,
    symbols,
    searcher,
    embeddable: embeddableSymbols(symbols, files),
    dataSource,
    cases: spec.cases,
  };
}
