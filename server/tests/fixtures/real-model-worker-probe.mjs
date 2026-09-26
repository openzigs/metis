// Issue #201 — load the REAL gte-modernbert in the embed worker, from the BUILT
// `dist`, under plain `node` (not vitest, not tsx): the exact module graph and
// loader a production `node dist/index.js` uses. The worker resolves
// transformers.js with `import.meta.resolve` only under real node ESM, so this is
// the one place a CJS/ESM loader defect in that path can show up.
//
// Prints one `PROBE_RESULT <json>` line on stdout (the server logger writes there too). Driven by `tests/embed-worker-real-model.test.ts`
// (opt-in: EMBED_REAL_MODEL_TEST=1) after `pnpm --filter @metis/server build`.
//
// `argv[2]` is the runtime: `worker` (the full probe) or `inline` (the probe
// vectors only, for comparison). Never both in ONE process: onnxruntime-node
// aborts the process when sessions live on two threads at once (#201 found it).
import { createRequire } from "node:module";

const MODEL = "Alibaba-NLP/gte-modernbert-base";
const DIMENSION = 768;

const dist = new URL("../../dist/", import.meta.url);
const { XenovaEmbedder, MAX_EMBED_SEQUENCE_TOKENS } = await import(
  new URL("lib/rag/embedder.js", dist).href
);
const { chunkMarkdown } = await import(new URL("lib/rag/chunker.js", dist).href);

const cosine = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);
const norm = (v) => Math.sqrt(cosine(v, v));

const probes = {
  anchor: "Users must be locked out after five failed login attempts.",
  related: "Block the account once someone enters a wrong password too many times.",
  unrelated: "Preheat the oven and fold the bananas into the batter.",
};

const runtime = process.argv[2] === "inline" ? "inline" : "worker";
const embedder = new XenovaEmbedder(MODEL, DIMENSION, { runtime });
const emit = (result) => process.stdout.write(`\nPROBE_RESULT ${JSON.stringify(result)}\n`);
try {
  const texts = Object.values(probes);
  const embedded = await embedder.embed(texts);
  // No `process.exit()` anywhere: exiting with an ONNX session loaded aborts in
  // onnxruntime-node's teardown ("mutex lock failed"); a natural exit does not.
  if (runtime === "inline") emit({ runtime: embedder.runtime, vectors: embedded.vectors });
  else emit(await fullReport(embedded));
} finally {
  await embedder.close();
}

async function fullReport(embedded) {
  const [anchor, related, unrelated] = embedded.vectors;
  // Token counts, with the model's own tokenizer, of what the chunker hands the
  // embedder for CJK and emoji text — and of the 2,048-character window v2 used.
  const require = createRequire(new URL("lib/rag/embedder.js", dist));
  const loaded = await import(require.resolve("@huggingface/transformers"));
  const transformers = loaded.AutoTokenizer ? loaded : loaded.default;
  if (process.env.TRANSFORMERS_CACHE) transformers.env.cacheDir = process.env.TRANSFORMERS_CACHE;
  const tokenizer = await transformers.AutoTokenizer.from_pretrained(MODEL);
  const tokens = (text) => tokenizer.encode(text).length;
  const japanese = Array.from(
    { length: 200 },
    (_, i) => `${i}：検索拡張生成は文書の内容を理解するための仕組みです。`,
  ).join("\n");
  const emoji = "😀🚀🎉🧪".repeat(1500);
  const rareCjk = "龘靐齉爩鱻麤龗灪".repeat(800);
  const chunks = chunkMarkdown(
    `# 日本語\n\n${japanese}\n\n# Emoji\n\n${emoji}\n\n# 稀\n\n${rareCjk}`,
  );
  const chunkTokens = chunks.map((c) => tokens(c.text));
  const chunkVectors = await embedder.embed(chunks.slice(0, 4).map((c) => c.text));
  return {
    runtime: embedder.runtime,
    identity: embedder.currentIdentity(),
    dimension: embedded.dimension,
    vectorLength: anchor.length,
    norms: embedded.vectors.map(norm),
    related: cosine(anchor, related),
    unrelated: cosine(anchor, unrelated),
    vectors: embedded.vectors,
    maxSequenceTokens: MAX_EMBED_SEQUENCE_TOKENS,
    chunkCount: chunks.length,
    maxChunkTokens: Math.max(...chunkTokens),
    chunkVectorCount: chunkVectors.vectors.length,
    v2WindowTokens: {
      japanese: tokens(japanese.slice(0, 2048)),
      emoji: tokens(emoji.slice(0, 2048)),
      rareCjk: tokens(rareCjk.slice(0, 2048)),
    },
  };
}
