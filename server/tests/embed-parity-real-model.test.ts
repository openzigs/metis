/**
 * Issue #307 — the in-process embedder must produce the SAME vectors after a
 * `@huggingface/transformers` upgrade as the version every stored vector came from.
 *
 * Every project's index holds vectors computed under transformers.js 3.8.1. A
 * library upgrade that moves them does not fail anything: search keeps returning
 * results. It just ranks new query vectors against old stored vectors from a
 * slightly different space, and that degradation stays invisible until someone
 * re-embeds every project. So the upgrade is only acceptable if a fixed set of strings
 * still embeds to the vectors recorded under 3.8.1
 * (`fixtures/embed-parity-v3-gte-modernbert-q8.json`), row by row.
 *
 * The probe runs the PRODUCTION path: `XenovaEmbedder` from the built `dist`, under
 * plain node, in the worker runtime (#189), with the shipped model, CLS pooling,
 * normalisation and `q8` dtype. It includes a row longer than the 2,048-token cap,
 * so truncation that is no longer honoured shows up as a moved vector. A second process scores the
 * in-process cross-encoder, whose raw logits were recorded alongside.
 *
 * Opt-in, like `embed-worker-real-model.test.ts`, because it needs the weights
 * (~150 MB, downloaded once or read from TRANSFORMERS_CACHE) and a built server:
 *
 *   pnpm --filter @metis/shared build && pnpm --filter @metis/server build
 *   EMBED_REAL_MODEL_TEST=1 pnpm --filter @metis/server exec vitest run tests/embed-parity-real-model.test.ts
 *
 * `.github/workflows/embed-real-model-nightly.yml` runs it nightly and on any pull
 * request that changes the dependency manifests or the embed path.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
// @ts-expect-error — plain-JS fixture shared with the probe process; no .d.ts.
import { PARITY_TEXTS } from "./fixtures/embed-parity-probe.mjs";

const run = promisify(execFile);
const PROBE = fileURLToPath(new URL("./fixtures/embed-parity-probe.mjs", import.meta.url));
const FIXTURE = fileURLToPath(
  new URL("./fixtures/embed-parity-v3-gte-modernbert-q8.json", import.meta.url),
);
const DIST_EMBEDDER = fileURLToPath(new URL("../dist/lib/rag/embedder.js", import.meta.url));

/** Per-string floor the upgrade must clear (issue #307). */
const MIN_PARITY_COSINE = 0.999;
/** Largest drift allowed on a raw cross-encoder logit (they span roughly −12…+9). */
const MAX_RERANK_LOGIT_DRIFT = 0.1;

interface ParityFixture {
  recordedWith: { transformersVersion: string };
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

describe("embed parity fixture (#307)", () => {
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as ParityFixture;

  it("was recorded under 3.8.1 with the shipped model, pooling, dtype and worker runtime", () => {
    // The shipped config is DERIVED, never restated: if the default model,
    // pooling or dtype moves, this fixture no longer describes production and
    // must be re-recorded, which is the same re-embed decision as an upgrade.
    expect(fixture.recordedWith.transformersVersion).toBe("3.8.1");
    expect(fixture.model).toBe(DEFAULT_SIDECAR_EMBED_MODEL);
    expect(fixture.pooling).toBe(resolvePooling(DEFAULT_SIDECAR_EMBED_MODEL).pooling);
    expect(fixture.dtype).toBe(resolveDtype({}));
    expect(fixture.identity).toBe(
      formatEmbeddingIdentity(fixture.model, fixture.pooling as "cls", fixture.dtype as "q8"),
    );
    expect(fixture.runtime).toBe("worker");
    expect(fixture.dimension).toBe(DEFAULT_EMBED_DIMENSION);
  });

  it("holds one unit-length vector per probe text, in probe order", () => {
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
  });
});

describe.runIf(process.env.EMBED_REAL_MODEL_TEST === "1")(
  "real gte-modernbert matches the transformers.js 3.8.1 vectors (#307)",
  () => {
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as ParityFixture;

    it("embeds every fixed string to cosine >= 0.999 of its recorded vector", async () => {
      // Opted in but not built is a failure, never a skip (#201).
      expect(existsSync(DIST_EMBEDDER), `${DIST_EMBEDDER} missing — run the server build`).toBe(
        true,
      );
      const got = await probe<EmbedProbe>("embed");

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
        `embed parity vs ${fixture.recordedWith.transformersVersion} (running ${got.transformersVersion}):\n` +
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
      expect(existsSync(DIST_EMBEDDER), `${DIST_EMBEDDER} missing — run the server build`).toBe(
        true,
      );
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
