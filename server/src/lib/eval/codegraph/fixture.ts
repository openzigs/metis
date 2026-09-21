/**
 * Epic #712 / Issue #717 — self-contained code-graph citation eval fixture
 * loader.
 *
 * Loads the synthesized micro-repo committed under
 * `eval-data/corpus/codegraph-01-citation/repo/`, parses every source file with
 * METIS's OWN {@link parseSource} (the deterministic regex fallback when
 * tree-sitter is not booted — no network, no DB, no embedder), and builds:
 *
 *   - `symbols`      — `CodeSymbol`-shaped records for every parsed definition,
 *   - `searcher`     — a {@link FusedCodeSearcher} backed by the REAL
 *                      {@link HybridCodeSearch} (BM25 branch) over an in-memory
 *                      symbol index, i.e. the same #714 production wiring minus
 *                      Prisma,
 *   - `lineLookup`   — a {@link SymbolLineLookup} resolving authoritative spans
 *                      from those records,
 *   - `targetSymbol` — the known symbol the eval question is about.
 *
 * Because the expected citation is DERIVED from `targetSymbol` (never hardcoded)
 * and both the fused block and the search tool render locators from the same
 * records, the whole chain is deterministic and self-contained.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectLanguage, parseSource } from "../../code-graph/parsers.js";
import {
  HybridCodeSearch,
  type SearchableSymbol,
  type SymbolIndex,
  type SymbolVectorStore,
} from "../../code-graph/hybrid-search.js";
import type { EmbedService } from "../../code-graph/symbol-embeddings.js";
import type { EmbeddingResult } from "../../rag/embedder.js";
import type {
  FusedCodeSearcher,
  RawCodeSymbolHit,
  SymbolLineLookup,
} from "../../rag/fused-code-context.js";

/** Descriptor committed alongside the synthesized repo (`codegraph.json`). */
export interface CodegraphFixtureSpec {
  id: string;
  title: string;
  kind: string;
  question: string;
  target: { name: string; filePath: string; language: string; kind: string };
  forbiddenDisclaimers: string[];
  note: string;
}

/** A `CodeSymbol`-shaped record derived from a parsed fixture file. */
export interface EvalCodeSymbol {
  id: string;
  projectId: string;
  kind: string;
  name: string;
  qualifiedName: string;
  filePath: string;
  startLine: number;
  endLine: number;
  language: string;
}

export interface CodegraphFixture {
  spec: CodegraphFixtureSpec;
  projectId: string;
  symbols: EvalCodeSymbol[];
  targetSymbol: EvalCodeSymbol;
  searcher: FusedCodeSearcher;
  lineLookup: SymbolLineLookup;
}

/** The canonical fixture project id used for scoping in the eval. */
export const FIXTURE_PROJECT_ID = "codegraph-eval-project";

/** No-op vector store — forces {@link HybridCodeSearch} onto its BM25 branch. */
const emptyVectorStore: SymbolVectorStore = {
  async search() {
    return [];
  },
};

/** Empty embed service — no vectors ⇒ the hybrid searcher skips vector search. */
const emptyEmbedService: EmbedService = {
  async embed(): Promise<EmbeddingResult> {
    return { vectors: [], model: "none", dimension: 0 };
  },
};

/** Default absolute directory of the committed fixture. */
export function defaultFixtureDir(): string {
  // server/src/lib/eval/codegraph → repo root is five levels up.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../../../eval-data/corpus/codegraph-01-citation");
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
 * Parse the fixture repo into `CodeSymbol` records. Only real definitions are
 * kept (the whole-file `module` symbol is dropped so the target lookup and the
 * symbol index carry meaningful entries).
 */
export function buildSymbolsFromRepo(
  files: Array<{ relPath: string; content: string }>,
  projectId: string,
): EvalCodeSymbol[] {
  const symbols: EvalCodeSymbol[] = [];
  for (const { relPath, content } of files) {
    const language = detectLanguage(relPath);
    if (!language) continue;
    const parsed = parseSource(relPath, content, language);
    for (const sym of parsed.symbols) {
      if (sym.kind === "module") continue;
      symbols.push({
        id: `${relPath}::${sym.qualifiedName}`,
        projectId,
        kind: sym.kind,
        name: sym.name,
        qualifiedName: sym.qualifiedName,
        filePath: relPath,
        startLine: sym.startLine,
        endLine: sym.endLine,
        language,
      });
    }
  }
  return symbols;
}

/** Build the injectable searcher + line lookup from parsed fixture symbols. */
export function buildSearchSeams(symbols: EvalCodeSymbol[]): {
  searcher: FusedCodeSearcher;
  lineLookup: SymbolLineLookup;
} {
  const index: SymbolIndex = {
    async getSymbols(): Promise<SearchableSymbol[]> {
      return symbols.map((s) => ({
        symbolId: s.id,
        name: s.name,
        qualifiedName: s.qualifiedName,
        kind: s.kind,
        filePath: s.filePath,
      }));
    },
  };
  const hybrid = new HybridCodeSearch(emptyVectorStore, index, emptyEmbedService);
  const searcher: FusedCodeSearcher = {
    async search(query, projectId, opts): Promise<RawCodeSymbolHit[]> {
      const results = await hybrid.search(query, projectId, { limit: opts?.limit ?? 20 });
      return results.map((r) => ({
        symbolId: r.symbolId,
        filePath: r.filePath,
        name: r.name,
        kind: r.kind,
        score: r.score,
        snippet: r.snippet,
      }));
    },
  };
  const byId = new Map(symbols.map((s) => [s.id, s]));
  const lineLookup: SymbolLineLookup = {
    async resolve(symbolIds) {
      const map = new Map<string, { filePath: string; startLine: number; endLine: number }>();
      for (const id of symbolIds) {
        const s = byId.get(id);
        if (s) map.set(id, { filePath: s.filePath, startLine: s.startLine, endLine: s.endLine });
      }
      return map;
    },
  };
  return { searcher, lineLookup };
}

/** Load and assemble the full fixture from disk. */
export async function loadCodegraphFixture(dir = defaultFixtureDir()): Promise<CodegraphFixture> {
  const specRaw = await fs.readFile(path.join(dir, "codegraph.json"), "utf8");
  const spec = JSON.parse(specRaw) as CodegraphFixtureSpec;

  const repoRoot = path.join(dir, "repo");
  const absFiles = await walkFiles(repoRoot);
  const files = await Promise.all(
    absFiles.map(async (abs) => ({
      relPath: path.relative(repoRoot, abs).split(path.sep).join("/"),
      content: await fs.readFile(abs, "utf8"),
    })),
  );

  const symbols = buildSymbolsFromRepo(files, FIXTURE_PROJECT_ID);
  const targetSymbol = symbols.find(
    (s) => s.name === spec.target.name && s.filePath === spec.target.filePath,
  );
  if (!targetSymbol) {
    throw new Error(
      `Fixture target symbol not found: ${spec.target.name} in ${spec.target.filePath}`,
    );
  }
  const { searcher, lineLookup } = buildSearchSeams(symbols);
  return { spec, projectId: FIXTURE_PROJECT_ID, symbols, targetSymbol, searcher, lineLookup };
}
