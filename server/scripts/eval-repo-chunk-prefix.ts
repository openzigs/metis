/**
 * Issue #2193 — `pnpm eval:repo-chunk-prefix`.
 *
 * Measures what the `File: <repository path>` line does to retrieval over a real
 * repository, with no database and no model call. It rebuilds a repository
 * connector's documents the way `ingestSourceAsKnowledge` does (the production
 * walk, file selection, secret redaction, document body, parser and chunker),
 * embeds them with the production `Embedder`, and ranks each query the way
 * `KnowledgeService.search` does in `hybrid` mode: an exact cosine over every chunk
 * for the dense list (the vector store's search, without its index), production's
 * BM25 options (`createInMemoryBM25`), `reciprocalRankFusion` and the
 * `max(4k, 20)` pool. Only the vector-store search is stood in for.
 *
 * Arms (what the embedder sees / what BM25 indexes):
 *   - `before`      — the bare chunk / the bare chunk (pre-#2193).
 *   - `both`        — `File: <path>` + chunk / the same (the first #2193 cut).
 *   - `dense-only`  — `File: <path>` + chunk / the bare chunk.
 *   - `segments`    — `File: <path>` + chunk / path words without label or extension + chunk.
 *   - `shipped`     — whatever production indexes now, from the row a fresh ingest
 *                     stores: `embeddingInputOf(indexedTextOf(row))` / `indexedTextOf(row)`.
 *                     It differs from `dense-only` only in a file's first chunk, which
 *                     already opens with its `# <path>` header and gets no second copy.
 *
 * Reproduce (#2193's numbers):
 *
 *   git clone --depth 1 --branch 2.3.3 https://github.com/miniflux/v2.git .tmp-2193/miniflux
 *   cd server && EMBED_BACKEND=xenova HF_HUB_OFFLINE=1 TRANSFORMERS_CACHE=~/.cache/metis-transformers \
 *     pnpm eval:repo-chunk-prefix --repo ../.tmp-2193/miniflux --cache ../.tmp-2193
 *
 * `--repo` is the checkout; its `README.md` and `miniflux.1` are added as uploaded
 * (non-repository) documents so a keyword probe can see a mixed project. The guard
 * set is the 30 Miniflux items of `eval-data/corpus/localization-0{0,1}-*`, each
 * item's `text` as the query, scored on its `expectedFiles`. `--cache` keeps the
 * vectors between runs (keyed by the embedded text's hash and the model identity).
 * The walkthrough's four Phase 3 uploads are not in the evidence, so absolute ranks
 * differ from #2193's in-app reproduction; the arms are compared with each other.
 */
/* eslint-disable no-console -- a CLI whose output is its report */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// `src/lib/prisma.ts` builds its adapter at module load; nothing here touches it,
// but the import chain reaches it, so it gets a throwaway URL.
process.env.DATABASE_URL ??= `file:${path.join(os.tmpdir(), "eval-repo-chunk-prefix.db")}`;

const { DEFAULT_RAG_CHUNK_OVERLAP, DEFAULT_RAG_CHUNK_SIZE, repoDocumentPath } =
  await import("@metis/shared");
const { collectSourceCandidates, resolveSourceIngestLimits, selectSourceFiles, sourceUnitBody } =
  await import("../src/lib/connectors/connector-ingest.js");
const { redactSecrets } = await import("../src/lib/safety/secret-patterns.js");
const { parseDocument } = await import("../src/lib/documents/parsers.js");
const { chunkMarkdown, resolveChunkParams } = await import("../src/lib/rag/chunker.js");
const { contextPrefixesFor, embeddingInputOf, indexedTextOf, prefixedText, repoFilePrefix } =
  await import("../src/lib/rag/contextual-chunks.js");
const { createInMemoryBM25, reciprocalRankFusion } = await import("../src/lib/rag/bm25-index.js");
const { Embedder } = await import("../src/lib/rag/embedder.js");

interface Row {
  id: string;
  documentId: string;
  filename: string;
  /** Repository path, or the upload's filename. */
  file: string;
  position: number;
  text: string;
  /** The `metadata` a fresh ingest stores (`{contextPrefix}` or none). */
  metadata: Record<string, unknown> | null;
}

interface Arm {
  name: string;
  dense: (r: Row) => string;
  bm25: (r: Row) => string;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const CONNECTOR = "mf";

async function buildRows(repo: string): Promise<Row[]> {
  const limits = resolveSourceIngestLimits();
  const { candidates } = await collectSourceCandidates(repo, undefined);
  const { selected } = selectSourceFiles(candidates, limits);
  const chunkOptions = resolveChunkParams({
    chunkSize: DEFAULT_RAG_CHUNK_SIZE,
    overlap: DEFAULT_RAG_CHUNK_OVERLAP,
  });
  const docs: Array<{ filename: string; body: string; mimeType: string }> = [];
  for (const file of selected) {
    const content = await readFile(file.absPath, "utf8");
    const ext = path.extname(file.relPath).toLowerCase();
    docs.push({
      filename: `connector:repo:${CONNECTOR}:src/${file.relPath}`,
      body: sourceUnitBody(file.relPath, ext, redactSecrets(content).text),
      mimeType: "text/markdown",
    });
  }
  for (const upload of ["README.md", "miniflux.1"]) {
    const p = path.join(repo, upload);
    if (existsSync(p)) {
      docs.push({ filename: upload, body: readFileSync(p, "utf8"), mimeType: "text/plain" });
    }
  }
  const rows: Row[] = [];
  for (const [d, doc] of docs.entries()) {
    const parsed = await parseDocument({
      buffer: Buffer.from(doc.body, "utf8"),
      mimeType: doc.mimeType,
      filename: doc.filename,
    });
    if (!parsed.ok) continue;
    const chunks = chunkMarkdown(parsed.text, chunkOptions);
    // The prefix production's ingest persists, in the shipped default mode.
    const prefixes = await contextPrefixesFor({
      mode: "off",
      projectId: "eval",
      filename: doc.filename,
      documentText: parsed.text,
      chunks,
    });
    for (const [i, c] of chunks.entries()) {
      const prefix = prefixes[i]?.prefix ?? "";
      rows.push({
        id: `${d}#${c.position}`,
        documentId: String(d),
        filename: doc.filename,
        file: repoDocumentPath(doc.filename) ?? doc.filename,
        position: c.position,
        text: c.text,
        metadata: prefix ? { contextPrefix: prefix } : null,
      });
    }
  }
  return rows;
}

/** The path words, without the `File:` label or the extension. */
function pathWords(r: Row): string {
  const p = repoDocumentPath(r.filename);
  return p ? p.replace(/\.[A-Za-z0-9]+$/, "") : "";
}

const fileLine = (r: Row) => repoFilePrefix(r.filename);
const ARMS: Arm[] = [
  { name: "before", dense: (r) => r.text, bm25: (r) => r.text },
  {
    name: "both",
    dense: (r) => prefixedText(r.text, fileLine(r)),
    bm25: (r) => prefixedText(r.text, fileLine(r)),
  },
  {
    name: "segments",
    dense: (r) => prefixedText(r.text, fileLine(r)),
    bm25: (r) => prefixedText(r.text, pathWords(r)),
  },
  {
    name: "dense-only",
    dense: (r) => prefixedText(r.text, fileLine(r)),
    bm25: (r) => r.text,
  },
  {
    name: "shipped",
    dense: (r) => embeddingInputOf(indexedTextOf(r.text, r.metadata), r.filename),
    bm25: (r) => indexedTextOf(r.text, r.metadata),
  },
];

async function embedAll(
  embedder: InstanceType<typeof Embedder>,
  texts: string[],
  cacheDir: string | undefined,
): Promise<number[][]> {
  const identity = await embedder.currentIdentity();
  const key = (t: string) => createHash("sha256").update(`${identity}\0${t}`).digest("hex");
  const cacheFile = cacheDir ? path.join(cacheDir, "vectors-2193.json") : undefined;
  const cache: Record<string, number[]> =
    cacheFile && existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, "utf8")) : {};
  const todo = [...new Set(texts.filter((t) => !cache[key(t)]))];
  for (let i = 0; i < todo.length; i += 32) {
    const batch = todo.slice(i, i + 32);
    const { vectors } = await embedder.embed(batch);
    batch.forEach((t, j) => {
      cache[key(t)] = vectors[j] as number[];
    });
    process.stderr.write(`\rembedded ${Math.min(i + 32, todo.length)}/${todo.length}`);
  }
  if (todo.length > 0) process.stderr.write("\n");
  if (cacheFile && todo.length > 0) {
    mkdirSync(path.dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(cache));
  }
  return texts.map((t) => cache[key(t)] as number[]);
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] as number) * (b[i] as number);
    na += (a[i] as number) ** 2;
    nb += (b[i] as number) ** 2;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

interface Ranker {
  rank(query: string, queryVector: number[], k: number): Row[];
  denseRank(queryVector: number[], id: string): number;
  bm25Rank(query: string, id: string): number;
}

function ranker(rows: Row[], arm: Arm, vectors: number[][]): Ranker {
  const bm25 = createInMemoryBM25(
    rows.map((r) => ({
      id: r.id,
      documentId: r.documentId,
      position: r.position,
      filename: r.filename,
      text: arm.bm25(r),
    })),
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const dense = (qv: number[]) =>
    rows
      .map((r, i) => ({ chunkId: r.id, score: cosine(qv, vectors[i] as number[]) }))
      .sort((a, b) => b.score - a.score);
  return {
    rank(query, qv, k) {
      const pool = Math.min(Math.max(k * 4, 20), 200);
      const fused = reciprocalRankFusion([dense(qv).slice(0, pool), bm25.search(query, pool)], {
        topK: pool,
      });
      return fused.slice(0, k).map((h) => byId.get(h.chunkId) as Row);
    },
    denseRank: (qv, id) => dense(qv).findIndex((h) => h.chunkId === id) + 1,
    bm25Rank: (query, id) => bm25.search(query, 200).findIndex((h) => h.chunkId === id) + 1,
  };
}

interface GuardItem {
  id: string;
  text: string;
  expectedFiles: string[];
}

function guardSet(): GuardItem[] {
  const items: GuardItem[] = [];
  for (const id of ["localization-00-miniflux-run7-insample", "localization-01-miniflux-heldout"]) {
    const manifest = JSON.parse(
      readFileSync(path.join(ROOT, "eval-data/corpus", id, "manifest.json"), "utf8"),
    ) as { items: Array<{ id: string; text: string; expectedFiles?: string[] }> };
    for (const it of manifest.items) {
      const expected = (it.expectedFiles ?? []).map((f) => f.replace(/^miniflux:/, ""));
      if (expected.length > 0) items.push({ id: it.id, text: it.text, expectedFiles: expected });
    }
  }
  return items;
}

const ISSUE_QUERY = "how often are feeds refreshed?";
/** #717's concern: words a path line adds ("file", "go", "md") also appear in questions. */
const KEYWORD_PROBES = [
  "Which Go version do I need to build Miniflux?",
  "How do I import my subscriptions from an OPML file?",
  "Which file holds the configuration options?",
  "How is a file served from the static assets?",
  "Can I export my feeds to a file?",
];

async function main(): Promise<void> {
  const repo = arg("repo");
  if (!repo) throw new Error("--repo <checkout> is required");
  const cacheDir = arg("cache");
  const rows = await buildRows(path.resolve(repo));
  const target = rows.find(
    (r) => r.file === "internal/model/feed.go" && r.text.includes("ScheduleNextCheck("),
  );
  const repoRows = rows.filter((r) => repoDocumentPath(r.filename) !== undefined).length;
  console.log(`chunks: ${rows.length} (repository: ${repoRows})`);
  console.log(`target: ${target ? `${target.file}#${target.position}` : "NOT FOUND"}`);

  const embedder = new Embedder();
  const guard = guardSet();
  const queries = [ISSUE_QUERY, ...guard.map((g) => g.text), ...KEYWORD_PROBES];
  const queryVectors = await embedAll(embedder, queries, cacheDir);
  const qv = new Map(queries.map((q, i) => [q, queryVectors[i] as number[]]));

  for (const arm of ARMS) {
    const vectors = await embedAll(embedder, rows.map(arm.dense), cacheDir);
    const r = ranker(rows, arm, vectors);
    console.log(`\n## ${arm.name}`);
    if (target) {
      const v = qv.get(ISSUE_QUERY) as number[];
      const at10 = r.rank(ISSUE_QUERY, v, 10).findIndex((x) => x.id === target.id) + 1;
      const at5 = r.rank(ISSUE_QUERY, v, 5).findIndex((x) => x.id === target.id) + 1;
      console.log(
        `issue query: k5 rank ${at5 || "-"}, k10 rank ${at10 || "-"}, dense rank ${r.denseRank(v, target.id)}, bm25 rank ${r.bm25Rank(ISSUE_QUERY, target.id) || "-"}`,
      );
      const top = r.rank(ISSUE_QUERY, v, 10).map((x) => `${x.file}#${x.position}`);
      console.log(`issue query top 10: ${top.join(", ")}`);
    }
    for (const k of [10, 5]) {
      let top5 = 0;
      let mrr = 0;
      let recall = 0;
      for (const g of guard) {
        const files = r.rank(g.text, qv.get(g.text) as number[], k).map((x) => x.file);
        const first = files.findIndex((f) => g.expectedFiles.includes(f)) + 1;
        if (first > 0 && first <= 5) top5 += 1;
        if (first > 0) mrr += 1 / first;
        recall += g.expectedFiles.filter((f) => files.includes(f)).length / g.expectedFiles.length;
      }
      const n = guard.length;
      console.log(
        `guard k${k} (n ${n}): expected file in top 5 ${top5}/${n}, MRR ${(mrr / n).toFixed(3)}, file recall ${(recall / n).toFixed(3)}`,
      );
    }
    for (const q of KEYWORD_PROBES) {
      const top = r.rank(q, qv.get(q) as number[], 5).map((x) => `${x.file}#${x.position}`);
      console.log(`probe "${q}": ${top.join(", ")}`);
    }
  }
}

await main();
// The embed worker thread would otherwise keep the process alive.
process.exit(0);
