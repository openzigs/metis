// Issue #307 — embed a FIXED set of strings through the production in-process
// embedder, from the BUILT `dist`, under plain `node`, and print the vectors (and
// the cross-encoder's logits) on one `PROBE_RESULT <json>` line.
//
// `tests/embed-parity-real-model.test.ts` compares that output with vectors
// RECORDED under @huggingface/transformers 3.8.1 + onnxruntime-node 1.21.0
// (`fixtures/embed-parity-v3-gte-modernbert-q8.<platform>-<arch>.json`). A library
// upgrade that moves a stored vector makes every project's index silently
// inconsistent with its new queries, so the upgrade is only acceptable if this
// output does not move.
//
// argv[2] is the mode — one ONNX runtime per process, never two (#201/#222:
// onnxruntime-node aborts the process when sessions live on two threads at once):
//   embed   the default embedder (worker runtime, the production default)
//   rerank  the in-process cross-encoder (inline runtime, as #222 requires)
//   record  runs `embed` and `rerank` in two child processes and writes THIS
//           host's fixture into this directory (argv[3] overrides the directory)
//
// WHY ONE FIXTURE PER PLATFORM — AND, ON x64, PER ISA. q8 vectors are not
// bit-portable: onnxruntime picks its quantized (u8s8) CPU kernels by OS, arch and
// instruction set. Under 3.8.1 + ORT 1.21.0 alone, darwin-arm64 vs linux-x64
// disagree down to cos 0.987, and two linux-x64 GitHub runners disagree at cos
// 0.991 on two rows when one exposes AVX512-VNNI and the other only AVX2 (measured
// for #307; same CPU model, EPYC 9V74, on both sides). Runners that share an ISA
// class agree at cos 1.0000. So the key is `<platform>-<arch>` plus, on linux-x64,
// the ISA class (`linux-x64-avx512vnni`, `linux-x64-avx2`, ...); the test picks the
// file for the host's key and FAILS (never skips) when it is missing, so a new
// class must be recorded before it can gate anything.
//
// RE-RECORDING — see "Embedding parity fixtures" in docs/OPERATIONS.md. Only ever
// from a tree that still resolves transformers.js 3.8.1 + onnxruntime-node 1.21.0
// (the parent of #307's bump); `record` refuses anything else, because a fixture
// recorded under the NEW library would compare the upgrade with itself. linux-x64
// (the CI platform) is recorded NATIVELY on a GitHub runner, never under
// emulation: `gh workflow run embed-real-model-nightly.yml --ref <branch>
// -f record=true` uploads it as the `embed-parity-fixture` artifact. The runner's
// ISA class is random per run, so dispatch until each class you need has one.
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { cpus } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

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

/** The library pair every stored vector came from; `record` accepts nothing else. */
export const RECORD_TRANSFORMERS_VERSION = "3.8.1";
export const RECORD_ONNXRUNTIME_VERSION = "1.21.0";

const FIXTURE_STEM = "embed-parity-v3-gte-modernbert-q8";

/**
 * The x64 instruction-set class that decides which u8s8 GEMM kernel onnxruntime
 * runs, from the `flags` of /proc/cpuinfo, most capable first.
 */
export function x64IsaClass(flags) {
  const has = new Set(flags);
  if (has.has("avx512_vnni")) return "avx512vnni";
  if (has.has("avx_vnni")) return "avxvnni";
  if (has.has("avx512bw")) return "avx512bw";
  if (has.has("avx2")) return "avx2";
  return "baseline";
}

/** The host CPU flags from /proc/cpuinfo (linux only), `null` when it has no flags line. */
export function linuxCpuFlags(readCpuinfo = () => readFileSync("/proc/cpuinfo", "utf8")) {
  const line = readCpuinfo()
    .split("\n")
    .find((l) => l.startsWith("flags"));
  return line
    ? line
        .slice(line.indexOf(":") + 1)
        .trim()
        .split(/\s+/)
    : null;
}

/**
 * The fixture key: `<platform>-<arch>`, plus the ISA class on linux-x64, e.g.
 * `darwin-arm64`, `linux-x64-avx512vnni`, `linux-x64-avx2`.
 */
export function platformKey(
  platform = process.platform,
  arch = process.arch,
  flags = platform === "linux" && arch === "x64" ? linuxCpuFlags() : null,
) {
  const base = `${platform}-${arch}`;
  return platform === "linux" && arch === "x64" && flags ? `${base}-${x64IsaClass(flags)}` : base;
}

/** The fixture file name for one platform. */
export function fixtureFileName(key = platformKey()) {
  return `${FIXTURE_STEM}.${key}.json`;
}

/** Inverse of `fixtureFileName`; `null` for any other file. */
export function platformOfFixture(fileName) {
  const m = new RegExp(`^${FIXTURE_STEM}\\.([a-z0-9]+-[a-z0-9]+(?:-[a-z0-9]+)?)\\.json$`).exec(
    fileName,
  );
  return m ? m[1] : null;
}

const MODEL = "Alibaba-NLP/gte-modernbert-base";
const DIMENSION = 768;
const RERANK_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";
const SELF = fileURLToPath(import.meta.url);

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await main(process.argv[2]);

/** Versions of the transformers.js + onnxruntime-node the BUILT server resolves. */
async function libraryVersions() {
  const dist = new URL("../../dist/", import.meta.url);
  const entry = createRequire(new URL("lib/rag/embedder.js", dist)).resolve(
    "@huggingface/transformers",
  );
  // The package `exports` map hides package.json; the library reports its own version.
  const loaded = await import(pathToFileURL(entry).href);
  const transformersVersion = (loaded.env ?? loaded.default.env).version;
  // onnxruntime-node is transformers.js's dependency, so resolve it from THERE:
  // that is the copy the pipeline loads, and the one the pnpm override pins.
  const fromTransformers = createRequire(entry);
  const onnxruntimeVersion = fromTransformers(
    fromTransformers.resolve("onnxruntime-node/package.json"),
  ).version;
  return { transformersVersion, onnxruntimeVersion };
}

async function main(mode) {
  if (mode === "record") {
    await record(process.argv[3]);
    return;
  }
  const dist = new URL("../../dist/", import.meta.url);
  const versions = await libraryVersions();
  const emit = (result) =>
    process.stdout.write(`\nPROBE_RESULT ${JSON.stringify({ ...versions, ...result })}\n`);

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

async function runProbe(mode) {
  const { stdout } = await promisify(execFile)(process.execPath, [SELF, mode], {
    env: { ...process.env, EMBED_INPROCESS_RUNTIME: mode === "rerank" ? "inline" : "worker" },
    maxBuffer: 8 * 1024 * 1024,
    timeout: 240_000,
  });
  const line = stdout.split("\n").find((l) => l.startsWith("PROBE_RESULT "));
  if (!line) throw new Error(`no PROBE_RESULT line from '${mode}':\n${stdout}`);
  return JSON.parse(line.slice("PROBE_RESULT ".length));
}

/** /proc/cpuinfo, or "" where there is none — so `isaFlags` is [] off linux. */
function safeCpuinfo() {
  try {
    return readFileSync("/proc/cpuinfo", "utf8");
  } catch {
    return "";
  }
}

async function record(outDir) {
  const embed = await runProbe("embed");
  const rerank = await runProbe("rerank");
  for (const got of [embed, rerank]) {
    if (
      got.transformersVersion !== RECORD_TRANSFORMERS_VERSION ||
      got.onnxruntimeVersion !== RECORD_ONNXRUNTIME_VERSION
    ) {
      throw new Error(
        `refusing to record: this tree resolves transformers.js ${got.transformersVersion} + ` +
          `onnxruntime-node ${got.onnxruntimeVersion}; a parity fixture must come from ` +
          `${RECORD_TRANSFORMERS_VERSION} + ${RECORD_ONNXRUNTIME_VERSION}, the pair every stored vector came from`,
      );
    }
  }
  const key = platformKey();
  const fixture = {
    recordedWith: {
      transformersVersion: embed.transformersVersion,
      onnxruntimeVersion: embed.onnxruntimeVersion,
      platform: key,
      node: process.versions.node,
      cpu: cpus()[0]?.model ?? "unknown",
      isaFlags: (linuxCpuFlags(safeCpuinfo) ?? []).filter((f) =>
        ["avx2", "avx512bw", "avx512_vnni", "avx_vnni", "amx_int8"].includes(f),
      ),
      recordedOn: new Date().toISOString().slice(0, 10),
      issue: 307,
    },
    model: MODEL,
    identity: embed.identity,
    pooling: embed.pooling,
    dtype: embed.dtype,
    runtime: embed.runtime,
    dimension: embed.dimension,
    texts: embed.texts,
    vectors: embed.vectors,
    rerank: { model: RERANK_MODEL, scores: rerank.scores },
  };
  const target = outDir
    ? join(outDir, fixtureFileName(key))
    : fileURLToPath(new URL(fixtureFileName(key), import.meta.url));
  writeFileSync(target, `${JSON.stringify(fixture)}\n`);
  process.stdout.write(`recorded ${key} fixture -> ${target}\n`);
}
