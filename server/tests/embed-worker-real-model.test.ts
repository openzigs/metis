/**
 * Issue #201 — the REAL gte-modernbert, in the embed WORKER, from the BUILT dist.
 *
 * Every other embed-worker suite runs a deterministic stub module
 * (`fixtures/busy-transformers.mjs`) and `tests/setup.ts` forces the `inline`
 * runtime, so CI never loaded the real model in the worker — a CJS/ESM loader
 * defect in the worker's `import()` of transformers.js (resolved differently
 * under real node than under vitest) would ship green.
 *
 * Opt-in, because it needs the model weights (~150 MB, downloaded on first run or
 * read from TRANSFORMERS_CACHE) and a built server:
 *
 *   pnpm --filter @metis/shared build && pnpm --filter @metis/server build
 *   EMBED_REAL_MODEL_TEST=1 pnpm --filter @metis/server exec vitest run tests/embed-worker-real-model.test.ts
 *
 * `.github/workflows/embed-real-model-nightly.yml` runs it every night.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const PROBE = fileURLToPath(new URL("./fixtures/real-model-worker-probe.mjs", import.meta.url));
const DIST_EMBEDDER = fileURLToPath(new URL("../dist/lib/rag/embedder.js", import.meta.url));

interface ProbeReport {
  runtime: string;
  identity: string;
  dimension: number;
  vectorLength: number;
  norms: number[];
  related: number;
  unrelated: number;
  vectors: number[][];
  maxSequenceTokens: number;
  chunkCount: number;
  maxChunkTokens: number;
  chunkVectorCount: number;
  v2WindowTokens: { japanese: number; emoji: number; rareCjk: number };
}

describe.runIf(process.env.EMBED_REAL_MODEL_TEST === "1")(
  "real gte-modernbert in the embed worker, from dist (#201)",
  () => {
    it("loads, embeds meaningfully, matches inline, and takes CJK/emoji chunks whole", async () => {
      // Opted in but not built is a failure, never a skip: a skip here is exactly
      // the silent green this suite exists to remove.
      expect(existsSync(DIST_EMBEDDER), `${DIST_EMBEDDER} missing — run the server build`).toBe(
        true,
      );
      // One runtime per process: onnxruntime-node aborts the process when sessions
      // live on two threads at once, so the inline comparison is its own run.
      const probe = async (runtime: "worker" | "inline"): Promise<unknown> => {
        const { stdout } = await run(process.execPath, [PROBE, runtime], {
          env: { ...process.env, EMBED_INPROCESS_RUNTIME: runtime },
          maxBuffer: 4 * 1024 * 1024,
          timeout: 140_000,
        });
        const line = stdout.split("\n").find((l) => l.startsWith("PROBE_RESULT "));
        expect(line, `no PROBE_RESULT line in:\n${stdout}`).toBeDefined();
        return JSON.parse((line as string).slice("PROBE_RESULT ".length));
      };
      const report = (await probe("worker")) as ProbeReport;
      const inline = (await probe("inline")) as { runtime: string; vectors: number[][] };

      expect(report.runtime).toBe("worker");
      expect(report.identity).toBe("Alibaba-NLP/gte-modernbert-base");
      expect(report.dimension).toBe(768);
      expect(report.vectorLength).toBe(768);
      for (const n of report.norms) expect(n).toBeCloseTo(1, 3);
      // A real vector space: the paraphrase is far closer than the unrelated text.
      expect(report.related - report.unrelated).toBeGreaterThan(0.1);
      // The worker computes what the in-thread pipeline computes.
      expect(inline.runtime).toBe("inline");
      report.vectors.forEach((v, i) => {
        const dot = v.reduce((sum, x, j) => sum + x * inline.vectors[i][j], 0);
        expect(dot).toBeGreaterThan(0.999);
      });

      // The v2 character window really was over the model's input for these…
      expect(report.v2WindowTokens.japanese).toBeGreaterThan(report.maxSequenceTokens);
      expect(report.v2WindowTokens.emoji).toBeGreaterThan(report.maxSequenceTokens);
      expect(report.v2WindowTokens.rareCjk).toBeGreaterThan(report.maxSequenceTokens);
      // …and no chunk the v3 chunker emits is, by the model's own tokenizer.
      expect(report.chunkCount).toBeGreaterThan(3);
      expect(report.maxChunkTokens).toBeLessThanOrEqual(report.maxSequenceTokens);
      expect(report.chunkVectorCount).toBe(4);
    }, 300_000);
  },
);
