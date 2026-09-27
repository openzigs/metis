/**
 * Issue #307 — the in-process embedder must produce the SAME vectors after a
 * `@huggingface/transformers` upgrade as the library pair every stored vector came
 * from: transformers.js 3.8.1 on onnxruntime-node 1.21.0.
 *
 * A library upgrade that moves vectors does not fail anything: search keeps
 * returning results. It just ranks new query vectors against old stored vectors
 * from a slightly different space, and that degradation stays invisible until
 * someone re-embeds every project. So an upgrade is only acceptable if a fixed set
 * of strings still embeds to the vectors recorded under 3.8.1, row by row.
 *
 * #307 measured that the drift lives in onnxruntime-node, not transformers.js:
 * 4.3.0 on its own ORT 1.30 lands at cos 0.915–0.969, while 4.3.0 on ORT 1.21 or
 * 1.22 is cos 1.0000. That is why `pnpm-workspace.yaml` overrides onnxruntime-node
 * to 1.22.0 (the lowest release transformers.js 4 can run decoder models on — see
 * the comment there), and why this file also asserts, on EVERY run, that the
 * installed ORT is that pin. Moving the pin is a re-embed decision
 * (docs/OPERATIONS.md, "Embedding parity fixtures").
 *
 * q8 vectors are not portable across platforms, nor across x64 instruction sets:
 * under 3.8.1 alone, darwin-arm64 vs linux-x64 go down to cos 0.987, and a linux-x64
 * runner exposing AVX512-VNNI vs one exposing only AVX2 differ at cos 0.991 on two
 * rows. So there is one fixture per key — `darwin-arm64`, `linux-x64-avx512vnni`,
 * `linux-x64-avx2`, … (`platformKey()` in the probe) — and an opted-in run on a host
 * whose key has no fixture FAILS rather than skipping.
 *
 * The probe runs the PRODUCTION path: `XenovaEmbedder` from the built `dist`, under
 * plain node, in the worker runtime (#189), with the shipped model, CLS pooling,
 * normalisation and `q8` dtype. It includes a row longer than the 2,048-token cap,
 * so truncation that is no longer honoured shows up as a moved vector. A second
 * process scores the in-process cross-encoder, whose raw logits were recorded
 * alongside.
 *
 * The real-model half is opt-in, like `embed-worker-real-model.test.ts`, because it
 * needs the weights (~150 MB, downloaded once or read from TRANSFORMERS_CACHE) and
 * a built server:
 *
 *   pnpm --filter @metis/shared build && pnpm --filter @metis/server build
 *   EMBED_REAL_MODEL_TEST=1 pnpm --filter @metis/server exec vitest run tests/embed-parity-real-model.test.ts
 *
 * `.github/workflows/embed-real-model-nightly.yml` runs it nightly and on any pull
 * request that changes the dependency manifests, the lockfile, the pnpm overrides
 * or the embed path.
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { DEFAULT_EMBED_DIMENSION } from "@metis/shared";
import {
  DEFAULT_SIDECAR_EMBED_MODEL,
  resolveDtype,
  resolvePooling,
} from "../src/lib/rag/embed-model-config.js";
import { formatEmbeddingIdentity } from "../src/lib/rag/embedding-identity.js";
import {
  PARITY_TEXTS,
  RECORD_ONNXRUNTIME_VERSION,
  RECORD_TRANSFORMERS_VERSION,
  fixtureFileName,
  linuxCpuFlags,
  platformKey,
  platformOfFixture,
  x64IsaClass,
  // @ts-expect-error — plain-JS fixture shared with the probe process; no .d.ts.
} from "./fixtures/embed-parity-probe.mjs";

const run = promisify(execFile);
const FIXTURE_DIR = fileURLToPath(new URL("./fixtures/", import.meta.url));
const PROBE = join(FIXTURE_DIR, "embed-parity-probe.mjs");
const DIST_EMBEDDER = fileURLToPath(new URL("../dist/lib/rag/embedder.js", import.meta.url));

/** Per-string floor the upgrade must clear (issue #307). */
const MIN_PARITY_COSINE = 0.999;
/** Largest drift allowed on a raw cross-encoder logit (they span roughly −12…+9). */
const MAX_RERANK_LOGIT_DRIFT = 0.1;
/**
 * Keys that MUST carry a fixture: both ISA classes GitHub's linux-x64 runners have
 * been observed to expose (the PR-time parity job lands on either, at random), and
 * the platform the #307 measurements were taken on.
 */
const REQUIRED_PLATFORMS = ["darwin-arm64", "linux-x64-avx512vnni", "linux-x64-avx2"];
/**
 * The onnxruntime-node `pnpm-workspace.yaml` pins (#307). Deliberately a literal:
 * moving it must be a reviewed edit here AND there, never a lockfile side effect.
 */
const PINNED_ONNXRUNTIME_VERSION = "1.22.0";

interface ParityFixture {
  recordedWith: {
    transformersVersion: string;
    onnxruntimeVersion: string;
    platform: string;
    node: string;
    cpu: string;
  };
  model: string;
  identity: string;
  pooling: string;
  dtype: string;
  runtime: string;
  dimension: number;
  texts: string[];
  vectors: number[][];
  rerank: { model: string; scores: number[] };
}

interface EmbedProbe {
  transformersVersion: string;
  onnxruntimeVersion: string;
  runtime: string;
  identity: string;
  pooling: string;
  dtype: string;
  dimension: number;
  texts: string[];
  vectors: number[][];
}

/** Cosine similarity, NOT assuming unit length — a lost normalisation must not hide. */
function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) return Number.NaN;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / Math.sqrt(na * nb);
}

/** Every committed parity fixture, keyed by the platform its file name names. */
function loadFixtures(): Map<string, ParityFixture> {
  const out = new Map<string, ParityFixture>();
  for (const name of readdirSync(FIXTURE_DIR)) {
    const key = platformOfFixture(name) as string | null;
    if (key) out.set(key, JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8")));
  }
  return out;
}

/**
 * The onnxruntime-node version transformers.js actually loads — resolved from the
 * installed `@huggingface/transformers`, which is the copy the pnpm override pins.
 */
function installedOnnxruntimeVersion(): string {
  const require = createRequire(import.meta.url);
  const fromTransformers = createRequire(require.resolve("@huggingface/transformers"));
  const pkg = fromTransformers.resolve("onnxruntime-node/package.json");
  return (JSON.parse(readFileSync(pkg, "utf8")) as { version: string }).version;
}

async function probe<T>(mode: "embed" | "rerank"): Promise<T> {
  const { stdout } = await run(process.execPath, [PROBE, mode], {
    // `tests/setup.ts` pins `inline` for mocked suites; the probe runs the real
    // model, so it gets the runtime production uses (rerank: inline, per #222).
    env: { ...process.env, EMBED_INPROCESS_RUNTIME: mode === "rerank" ? "inline" : "worker" },
    maxBuffer: 8 * 1024 * 1024,
    timeout: 240_000,
  });
  const line = stdout.split("\n").find((l) => l.startsWith("PROBE_RESULT "));
  expect(line, `no PROBE_RESULT line in:\n${stdout}`).toBeDefined();
  return JSON.parse((line as string).slice("PROBE_RESULT ".length)) as T;
}

describe("embed parity fixtures (#307)", () => {
  const fixtures = loadFixtures();

  it("maps platform keys to file names and back", () => {
    expect(fixtureFileName("linux-x64-avx2")).toBe(
      "embed-parity-v3-gte-modernbert-q8.linux-x64-avx2.json",
    );
    expect(platformOfFixture(fixtureFileName("darwin-arm64"))).toBe("darwin-arm64");
    expect(platformOfFixture(fixtureFileName("linux-x64-avx512vnni"))).toBe("linux-x64-avx512vnni");
    expect(platformOfFixture("embed-parity-v3-gte-modernbert-q8.json")).toBeNull();
    expect(platformOfFixture("embed-parity-probe.mjs")).toBeNull();
  });

  it("keys linux-x64 by the ISA class that picks onnxruntime's q8 kernel", () => {
    expect(x64IsaClass(["avx2", "avx512f", "avx512bw", "avx512_vnni", "avx_vnni"])).toBe(
      "avx512vnni",
    );
    expect(x64IsaClass(["avx2", "avx_vnni"])).toBe("avxvnni");
    expect(x64IsaClass(["avx2", "avx512f", "avx512bw"])).toBe("avx512bw");
    expect(x64IsaClass(["sse4_2", "avx2"])).toBe("avx2");
    expect(x64IsaClass(["sse4_2"])).toBe("baseline");
    expect(platformKey("linux", "x64", ["avx2"])).toBe("linux-x64-avx2");
    expect(platformKey("linux", "x64", ["avx2", "avx512_vnni"])).toBe("linux-x64-avx512vnni");
    // Only linux-x64 is split by ISA; elsewhere the key is platform-arch.
    expect(platformKey("darwin", "arm64", null)).toBe("darwin-arm64");
    expect(platformKey("win32", "x64")).toBe("win32-x64");
    expect(
      linuxCpuFlags(() => "processor\t: 0\nflags\t\t: fpu sse4_2 avx2 avx512_vnni\nbugs\t\t:\n"),
    ).toEqual(["fpu", "sse4_2", "avx2", "avx512_vnni"]);
    expect(linuxCpuFlags(() => "processor\t: 0\n")).toBeNull();
  });

  it("carries a fixture for every platform that must gate", () => {
    expect([...fixtures.keys()].sort()).toEqual(expect.arrayContaining(REQUIRED_PLATFORMS));
  });

  it.each(REQUIRED_PLATFORMS)(
    "%s was recorded on that platform, under 3.8.1 + ORT 1.21.0, with the shipped config",
    (key) => {
      const fixture = fixtures.get(key) as ParityFixture;
      expect(fixture, `no fixture for ${key}`).toBeDefined();
      // A fixture copied under another platform's name would gate against the
      // wrong kernels and pass or fail for the wrong reason.
      expect(fixture.recordedWith.platform).toBe(key);
      expect(fixture.recordedWith.transformersVersion).toBe(RECORD_TRANSFORMERS_VERSION);
      expect(fixture.recordedWith.onnxruntimeVersion).toBe(RECORD_ONNXRUNTIME_VERSION);
      // The shipped config is DERIVED, never restated: if the default model,
      // pooling or dtype moves, this fixture no longer describes production and
      // must be re-recorded, which is the same re-embed decision as an upgrade.
      expect(fixture.model).toBe(DEFAULT_SIDECAR_EMBED_MODEL);
      expect(fixture.pooling).toBe(resolvePooling(DEFAULT_SIDECAR_EMBED_MODEL).pooling);
      expect(fixture.dtype).toBe(resolveDtype({}));
      expect(fixture.identity).toBe(
        formatEmbeddingIdentity(fixture.model, fixture.pooling as "cls", fixture.dtype as "q8"),
      );
      expect(fixture.runtime).toBe("worker");
      expect(fixture.dimension).toBe(DEFAULT_EMBED_DIMENSION);

      expect(fixture.texts).toEqual(PARITY_TEXTS);
      expect(fixture.vectors).toHaveLength(PARITY_TEXTS.length);
      for (const v of fixture.vectors) {
        expect(v).toHaveLength(fixture.dimension);
        expect(Math.sqrt(v.reduce((s, x) => s + x * x, 0))).toBeCloseTo(1, 4);
      }
      // The rows are distinct: a fixture of one repeated vector would pass any
      // parity check against a model that ignores its input.
      expect(cosine(fixture.vectors[0], fixture.vectors[2])).toBeLessThan(0.9);
      expect(fixture.rerank.scores).toHaveLength(3);
    },
  );

  it("runs on the pinned onnxruntime-node (#307)", () => {
    // pnpm-workspace.yaml overrides onnxruntime-node because the q8 kernels in
    // later ORT releases move stored vectors (cos 0.915–0.969 on 1.30). If the
    // override is dropped, or a transformers.js bump drags a new ORT past it, this
    // fails on every PR — not just on the real-model job.
    expect(installedOnnxruntimeVersion()).toBe(PINNED_ONNXRUNTIME_VERSION);
  });
});

describe.runIf(process.env.EMBED_REAL_MODEL_TEST === "1")(
  "real gte-modernbert matches the transformers.js 3.8.1 vectors (#307)",
  () => {
    const key = platformKey() as string;
    const fixturePath = join(FIXTURE_DIR, fixtureFileName(key) as string);

    /** Opted in but not built, or no fixture for this platform, is a failure — never a skip (#201). */
    function preconditions(): ParityFixture {
      expect(existsSync(DIST_EMBEDDER), `${DIST_EMBEDDER} missing — run the server build`).toBe(
        true,
      );
      expect(
        existsSync(fixturePath),
        `no parity fixture for ${key}: record one under 3.8.1 (docs/OPERATIONS.md, "Embedding parity fixtures")`,
      ).toBe(true);
      return JSON.parse(readFileSync(fixturePath, "utf8")) as ParityFixture;
    }

    it("embeds every fixed string to cosine >= 0.999 of its recorded vector", async () => {
      const fixture = preconditions();
      const got = await probe<EmbedProbe>("embed");

      expect(got.onnxruntimeVersion).toBe(PINNED_ONNXRUNTIME_VERSION);
      expect(got.runtime).toBe("worker");
      expect(got.identity).toBe(fixture.identity);
      expect(got.pooling).toBe(fixture.pooling);
      expect(got.dtype).toBe(fixture.dtype);
      expect(got.dimension).toBe(fixture.dimension);
      expect(got.texts).toEqual(fixture.texts);

      const report = got.vectors.map((v, i) => ({
        text: fixture.texts[i].slice(0, 40),
        cosine: cosine(v, fixture.vectors[i]),
        norm: Math.sqrt(v.reduce((s, x) => s + x * x, 0)),
      }));
      // eslint-disable-next-line no-console
      console.info(
        `embed parity on ${key} vs ${fixture.recordedWith.transformersVersion} + ORT ` +
          `${fixture.recordedWith.onnxruntimeVersion} (running ${got.transformersVersion} + ORT ` +
          `${got.onnxruntimeVersion}):\n` +
          report.map((r) => `  ${r.cosine.toFixed(6)}  ${JSON.stringify(r.text)}`).join("\n"),
      );
      for (const r of report) {
        expect(r.norm, `norm of ${JSON.stringify(r.text)}`).toBeCloseTo(1, 3);
        expect(r.cosine, `cosine of ${JSON.stringify(r.text)}`).toBeGreaterThanOrEqual(
          MIN_PARITY_COSINE,
        );
      }

      // The model cache dir is still TRANSFORMERS_CACHE, in the layout an
      // offline bundle bakes (`<cache>/<model>/onnx/model_quantized.onnx`).
      const cacheDir = process.env.TRANSFORMERS_CACHE;
      if (cacheDir) {
        expect(
          existsSync(join(cacheDir, fixture.model, "onnx", "model_quantized.onnx")),
          `weights not under TRANSFORMERS_CACHE=${cacheDir}`,
        ).toBe(true);
      }
    }, 300_000);

    it("scores the cross-encoder pairs to the recorded raw logits", async () => {
      const fixture = preconditions();
      const got = await probe<{ scores: number[] }>("rerank");
      expect(got.scores).toHaveLength(fixture.rerank.scores.length);
      got.scores.forEach((s, i) => {
        expect(Math.abs(s - fixture.rerank.scores[i]), `logit ${i}: ${s}`).toBeLessThanOrEqual(
          MAX_RERANK_LOGIT_DRIFT,
        );
      });
    }, 300_000);
  },
);
