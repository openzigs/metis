/**
 * Issue #782 — DTYPE LOCKSTEP GUARD.
 *
 * transformers.js v3 resolves a different weights FILE per dtype
 * (`model_quantized.onnx` for q8, `model.onnx` for fp32). An air-gapped image
 * (`HF_HUB_OFFLINE=1`) can only serve the dtype it BAKED, so the dtype the
 * runtime requests and the dtype the Dockerfile bakes must never disagree — a
 * mismatch is not a degraded vector, it is a pod that cannot boot.
 *
 * #781 kept four literal `q8`s in sync by hand. #782 makes the coupling
 * structural: both Dockerfiles bake with `dtype: process.env.EMBED_DTYPE` and
 * export the same `ARG EMBED_DTYPE` into their runtime stage, which is the very
 * env var `resolveDtype()` reads. This test is the last strand: it fails if a
 * literal dtype creeps back into a bake, if a Dockerfile's `ARG EMBED_DTYPE`
 * default drifts from the code default, or if a runtime stage stops exporting it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_DTYPE } from "../src/lib/rag/embed-model-config.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DOCKERFILES = ["Dockerfile.embeddings", "Dockerfile.server"] as const;

function read(name: string): string {
  return readFileSync(resolve(repoRoot, name), "utf8");
}

/**
 * Split a Dockerfile into its build stages. `ARG` does not cross a `FROM`
 * boundary, so EVERY stage that needs `EMBED_DTYPE` — the one that bakes and the
 * one that runs — must re-declare the ARG and export the ENV for itself. Any
 * assertion about that has to be per-stage; a file-wide count cannot tell "both
 * stages have it" from "one stage has it twice".
 */
function stagesOf(content: string): string[] {
  // Drop the pre-FROM preamble: it can never satisfy a stage's ARG/ENV.
  return content.split(/^FROM /m).slice(1);
}

describe.each(DOCKERFILES)("%s dtype lockstep", (name) => {
  const content = read(name);

  it("bakes weights with the EMBED_DTYPE env var, never a hardcoded dtype literal", () => {
    // Take EVERY bake call, not just the ones that happen to mention `dtype` — a
    // bake that DROPS the option entirely falls back to transformers.js v3's
    // fp32 default and bakes the wrong weights file, and a `dtype`-filtered list
    // could never see it.
    const pipelineLines = content.split("\n").filter((line) => line.includes("t.pipeline("));
    expect(pipelineLines.length).toBeGreaterThan(0);
    for (const line of pipelineLines) {
      // `{ dtype }` shorthand, sourced from process.env.EMBED_DTYPE above it.
      expect(line, "a bake call must pass the dtype option").toMatch(/\{\s*dtype\s*\}/);
      expect(line, "a bake call must not hardcode a dtype literal").not.toMatch(/dtype:\s*['"]/);
    }
    expect(content).toContain("const dtype = process.env.EMBED_DTYPE;");
  });

  it("declares ARG EMBED_DTYPE with exactly the code's DEFAULT_DTYPE", () => {
    const args = [...content.matchAll(/^ARG EMBED_DTYPE=(.+)$/gm)].map((m) => m[1].trim());
    // One per stage that needs it (builder bake + runtime), so at least two.
    expect(args.length).toBeGreaterThanOrEqual(2);
    for (const value of args) {
      expect(value).toBe(DEFAULT_DTYPE);
    }
  });

  it("exports EMBED_DTYPE into the RUNTIME stage, where resolveDtype() reads it", () => {
    // Stage-AWARE on purpose. `ARG` does not cross a `FROM` boundary, so a
    // file-wide count of `ENV EMBED_DTYPE` lines would still pass if BOTH lived
    // in the builder and the final stage exported none — which is precisely the
    // broken air-gapped image this guard exists to catch (runtime defaults to
    // fp32, requests weights the build never baked, pod cannot boot).
    const runtime = stagesOf(content).at(-1)!;
    expect(
      runtime,
      "final stage must re-declare ARG EMBED_DTYPE (ARG does not cross FROM)",
    ).toMatch(/^ARG EMBED_DTYPE=/m);
    expect(runtime, "final stage must export ENV EMBED_DTYPE").toMatch(
      /^ENV EMBED_DTYPE=\$\{EMBED_DTYPE\}$/m,
    );
  });

  it("exports EMBED_DTYPE into every BAKING stage, where the bake's process.env reads it", () => {
    // The mirror image of the runtime assertion, and just as load-bearing. The
    // bake does `const dtype = process.env.EMBED_DTYPE`, so if the stage that
    // RUNS the bake stops exporting the ENV, `dtype` is `undefined`,
    // transformers.js v3 silently falls back to fp32 and bakes `model.onnx` —
    // while the runtime stage still asks for the q8 `model_quantized.onnx` that
    // was never baked. Same unbootable air-gapped pod, entered from the other
    // end. Found structurally (the stage containing a bake), not by index, so it
    // keeps holding if the stage order changes.
    const bakeStages = stagesOf(content).filter((stage) => stage.includes("t.pipeline("));
    expect(bakeStages.length, "expected at least one stage to bake weights").toBeGreaterThan(0);
    for (const stage of bakeStages) {
      expect(
        stage,
        "baking stage must re-declare ARG EMBED_DTYPE (ARG does not cross FROM)",
      ).toMatch(/^ARG EMBED_DTYPE=/m);
      expect(
        stage,
        "baking stage must export ENV EMBED_DTYPE so the bake's process.env sees it",
      ).toMatch(/^ENV EMBED_DTYPE=\$\{EMBED_DTYPE\}$/m);
    }
  });
});

describe("runtime dtype sites", () => {
  it("no source file hardcodes a dtype literal in a pipeline() call", () => {
    const files = [
      "server/src/lib/rag/embedder.ts",
      "server/src/lib/rag/reranker.ts",
      "server/embeddings-svc/src/pipelines.ts",
    ];
    for (const file of files) {
      const src = readFileSync(resolve(repoRoot, file), "utf8");
      const offenders = src
        .split("\n")
        .filter((line) => /pipeline\(/.test(line) || /dtype:\s*['"]/.test(line))
        .filter((line) => /dtype:\s*['"]/.test(line));
      expect(offenders, `${file} still hardcodes a dtype`).toEqual([]);
    }
  });
});
