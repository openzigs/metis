// Issue #307 (Dependabot #11) — embed a FIXED set of strings through the production
// in-process embedder, from the BUILT `dist`, under plain `node`, and print the
// vectors (and the cross-encoder's logits) on one `PROBE_RESULT <json>` line.
//
// `tests/embed-parity-real-model.test.ts` compares that output with vectors
// RECORDED under @huggingface/transformers 3.8.1
// (`fixtures/embed-parity-v3-gte-modernbert-q8.json`). A library upgrade that moves
// a stored vector makes every project's index silently inconsistent with its new
// queries, so the upgrade is only acceptable if this output does not move.
//
// argv[2] is the mode — one ONNX runtime per process, never two (#201/#222:
// onnxruntime-node aborts the process when sessions live on two threads at once):
//   embed   the default embedder (worker runtime, the production default)
//   rerank  the in-process cross-encoder (inline runtime, as #222 requires)
//
// Re-record (only ever against the library version the fixture names):
//   node tests/fixtures/embed-parity-probe.mjs embed  > embed.out
//   node tests/fixtures/embed-parity-probe.mjs rerank > rerank.out
// then assemble the fixture from the two PROBE_RESULT lines.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export const PARITY_TEXTS = [
  "Users must be locked out after five failed login attempts.",
  "Block the account once someone enters a wrong password too many times.",
  "Preheat the oven and fold the bananas into the batter.",
  "export async function reserveIdempotencyKey(scope: string, key: string): Promise<boolean> { " +
    "const existing = await store.get(scope, key); if (existing) return false; " +
    "await store.put(scope, key, Date.now()); return true; }",
  "SELECT o.id, c.email FROM orders o JOIN customers c ON c.id = o.customer_id " +
    "WHERE o.status = 'OVERDUE' AND o.due_date < CURRENT_DATE;",
  "| Column | Type | Notes |\n|---|---|---|\n| id | uuid | primary key |\n| created_at | timestamptz | set by trigger |",
  "検索拡張生成は文書の内容を理解するための仕組みです。",
  "Deploy 🚀 finished — all checks ✅, one flaky test 🧪 retried.",
  "a",
  // Longer than MAX_EMBED_SEQUENCE_TOKENS (2,048): pins the tokenizer truncation cap.
  // If an upgrade stopped honouring `model_max_length`, this row would embed the
  // whole text and its vector would move.
  Array.from(
    { length: 400 },
    (_, i) => `Section ${i}: the retention policy keeps audit rows for ${i + 7} days.`,
  ).join(" "),
];

export const RERANK_QUERY = "how long are audit log rows retained?";
export const RERANK_PASSAGES = [
  "Audit rows are kept for ninety days, then purged by the nightly retention job.",
  "The login page accepts a username and password.",
  "Preheat the oven and fold the bananas into the batter.",
];

const MODEL = "Alibaba-NLP/gte-modernbert-base";
const DIMENSION = 768;

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await main(process.argv[2]);

async function main(mode) {
  const dist = new URL("../../dist/", import.meta.url);
  const require = createRequire(new URL("lib/rag/embedder.js", dist));
  // The package `exports` map hides package.json; the library reports its own version.
  const loaded = await import(require.resolve("@huggingface/transformers"));
  const transformersVersion = (loaded.env ?? loaded.default.env).version;
  const emit = (result) =>
    process.stdout.write(`\nPROBE_RESULT ${JSON.stringify({ transformersVersion, ...result })}\n`);

  if (mode === "rerank") {
    const { createCrossEncoderReranker } = await import(new URL("lib/rag/reranker.js", dist).href);
    const reranker = createCrossEncoderReranker({ embed: { inProcessRuntime: "inline" } });
    const ranked = await reranker.rerank(
      RERANK_QUERY,
      RERANK_PASSAGES.map((text, i) => ({ chunkId: String(i), text })),
    );
    const scores = RERANK_PASSAGES.map((_, i) => ranked.find((c) => c.chunkId === String(i)).score);
    emit({ mode, scores });
    return;
  }

  const { XenovaEmbedder } = await import(new URL("lib/rag/embedder.js", dist).href);
  const embedder = new XenovaEmbedder(MODEL, DIMENSION, { runtime: "worker" });
  try {
    const embedded = await embedder.embed(PARITY_TEXTS);
    // No `process.exit()`: exiting with an ONNX session loaded aborts in
    // onnxruntime-node's teardown; a natural exit does not (#201).
    emit({
      mode: "embed",
      runtime: embedder.runtime,
      identity: embedder.currentIdentity(),
      pooling: embedder.pooling,
      dtype: embedder.dtype,
      dimension: embedded.dimension,
      texts: PARITY_TEXTS,
      vectors: embedded.vectors,
    });
  } finally {
    await embedder.close();
  }
}
