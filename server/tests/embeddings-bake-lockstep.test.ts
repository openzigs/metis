/**
 * Issue #784 — BAKE LOCKSTEP GUARD (sibling of the #782 dtype guard).
 *
 * `Dockerfile.embeddings` runs with `HF_HUB_OFFLINE=1`, so the set of models in
 * its baked cache is the COMPLETE set of models it can ever serve. The invariant
 * this file exists to keep true is one sentence:
 *
 *   THE MODEL THE SIDECAR SERVES BY DEFAULT IS ALWAYS IN THE BAKED CACHE.
 *
 * The first cut of this guard did not enforce that. It compared the Dockerfile's
 * `ARG EMBED_MODEL` against `DEFAULT_BAKE_EMBED_MODEL` — a second copy of the
 * string — while the value that actually decided what the sidecar served was a
 * THIRD copy: a local `const DEFAULT_EMBED_MODEL` in `app.ts` that nothing here
 * referenced. And the runner stage never exported `EMBED_MODEL` at all (ARG/ENV
 * do not cross a `FROM`), so the build-time value the bake keyed on and the model
 * the running sidecar served were unrelated variables that happened to share a
 * name. #783 flips the runtime default; under that design the flip would have
 * kept this file green while the image quietly stopped baking what it served.
 *
 * The checks below close the loop end to end:
 *   1. `DEFAULT_SIDECAR_EMBED_MODEL` (what `app.ts` serves) IS the Dockerfile's
 *      `ARG EMBED_MODEL` default, in every stage that declares it;
 *   2. the RUNNER stage exports `ENV EMBED_MODEL`, so the image's runtime default
 *      is the build arg and not a compiled-in fallback;
 *   3. `app.ts` resolves its default through `resolveEmbedModel()` and holds no
 *      model literal of its own;
 *   4. the bake list is DERIVED from that same constant, and a trimmed list that
 *      omits it fails the BUILD;
 *   5. `@metis/shared`'s `DEFAULT_XENOVA_EMBED_MODEL` — the server's name for the
 *      same model — agrees with it.
 *
 * None of these failures breaks a build on its own. All of them produce an image
 * that boots, passes its health check, and then cannot load its model.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_XENOVA_EMBED_MODEL } from "@metis/shared";
import {
  AIR_GAP_EMBED_MODEL,
  BGE_SMALL_EMBED_MODEL,
  DEFAULT_BAKE_MODELS,
  DEFAULT_SIDECAR_EMBED_MODEL,
  resolveBakeModels,
  resolveEmbedModel,
} from "../src/lib/rag/embed-model-config.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const content = readFileSync(resolve(repoRoot, "Dockerfile.embeddings"), "utf8");
const appSource = readFileSync(resolve(repoRoot, "server/embeddings-svc/src/app.ts"), "utf8");

/** Stages of the Dockerfile — `ARG`/`ENV` do not cross a `FROM` boundary. */
function stagesOf(source: string): string[] {
  return source.split(/^FROM /m).slice(1);
}

/**
 * Stages that actually RUN the bake — matched on the call itself, not on the
 * word: the runner stage now MENTIONS `resolveBakeModels` in a comment (that is
 * where `ENV EMBED_MODEL` gets explained), and a substring match would classify
 * it as a baking stage and demand build-only args like HF_ENDPOINT of it.
 */
const bakeStages = stagesOf(content).filter((stage) =>
  stage.includes("cfg.resolveBakeModels(process.env)"),
);
const runnerStage = stagesOf(content).at(-1)!;

describe("Dockerfile.embeddings bake lockstep", () => {
  it("declares ARG EMBED_MODEL with exactly the model the sidecar SERVES", () => {
    // The #783 tripwire. When #783 flips DEFAULT_SIDECAR_EMBED_MODEL to
    // gte-modernbert, this fails until the Dockerfile ARG follows it — and since
    // the bake list is derived from the same constant, moving the ARG moves what
    // the image bakes. There is no longer a way to flip the served default
    // without the bake following.
    const args = [...content.matchAll(/^ARG EMBED_MODEL=(.+)$/gm)].map((m) => m[1].trim());
    expect(args.length).toBeGreaterThan(0);
    for (const value of args) {
      expect(value).toBe(DEFAULT_SIDECAR_EMBED_MODEL);
    }
  });

  it("exports EMBED_MODEL into the RUNNER stage, not only the builder", () => {
    // THE F1 BUG. Without this the runner never sees the build arg, so
    // `--build-arg EMBED_MODEL=<gte>` produced an image that BAKED gte and then
    // SERVED bge-small — a model it had never downloaded — under HF_HUB_OFFLINE=1.
    expect(runnerStage, "runner stage must declare ARG EMBED_MODEL").toMatch(/^ARG EMBED_MODEL=/m);
    expect(runnerStage, "runner stage must export ENV EMBED_MODEL").toMatch(
      /^ENV EMBED_MODEL=\$\{EMBED_MODEL\}$/m,
    );
  });

  it("serves its default via resolveEmbedModel(), never a literal in app.ts", () => {
    // A re-introduced `const DEFAULT_EMBED_MODEL = "…"` in app.ts would be
    // invisible to the bake — which is exactly how this bug happened.
    expect(appSource).toMatch(/model = resolveEmbedModel\(\)/);
    expect(
      appSource,
      "app.ts must not hardcode an embed model id — derive it from model-config",
    ).not.toMatch(/DEFAULT_EMBED_MODEL\s*=\s*["']/);
  });

  it("derives the default bake list from the served default, so it cannot omit it", () => {
    expect(DEFAULT_BAKE_MODELS).toContain(DEFAULT_SIDECAR_EMBED_MODEL);
    expect(resolveBakeModels({})).toContain(resolveEmbedModel({}));
    // #783 flips the RUNTIME default to gte-modernbert as a config change. That
    // only works if the image already carries the weights — otherwise the flip
    // silently becomes "rebuild and redeploy every image", or worse, an offline
    // pod asking for a model it never baked.
    expect(DEFAULT_BAKE_MODELS).toContain(AIR_GAP_EMBED_MODEL);
    // bge-small stays baked ACROSS the flip: corpora indexed with it are queried
    // by model id, so dropping its weights breaks retrieval on every old corpus.
    expect(DEFAULT_BAKE_MODELS).toContain(BGE_SMALL_EMBED_MODEL);
  });

  it("serves gte-modernbert by default, and bakes what it serves (the #783 flip)", () => {
    // #783 HAS flipped: the served default IS gte-modernbert, and the bake list —
    // derived from the same constant — carries it with no edit here.
    expect(DEFAULT_SIDECAR_EMBED_MODEL).toBe(AIR_GAP_EMBED_MODEL);
    expect(resolveEmbedModel({})).toBe(AIR_GAP_EMBED_MODEL);
    expect(resolveBakeModels({})).toContain(AIR_GAP_EMBED_MODEL);
    // A deployment that pins the OLD model still boots offline: bge stays baked.
    expect(resolveBakeModels({ EMBED_MODEL: BGE_SMALL_EMBED_MODEL })).toContain(
      BGE_SMALL_EMBED_MODEL,
    );
  });

  it("fails the BUILD when a trimmed bake list omits the model that will be served", () => {
    // The brick-the-image path — now a build error instead of a boot error.
    expect(() => resolveBakeModels({ BAKE_EMBED_MODELS: BGE_SMALL_EMBED_MODEL })).toThrow(
      /does not include "Alibaba-NLP\/gte-modernbert-base"/,
    );
    // ...and the SAFE trim (move both) genuinely trims: gte only, in and out.
    expect(
      resolveBakeModels({
        EMBED_MODEL: AIR_GAP_EMBED_MODEL,
        BAKE_EMBED_MODELS: AIR_GAP_EMBED_MODEL,
      }),
    ).toEqual([AIR_GAP_EMBED_MODEL]);
  });

  it("agrees with @metis/shared about which model that is", () => {
    // The 4th copy of the literal. The server sends an explicit `model` on every
    // /embed call (`embeddings-client.ts`), defaulting to this constant — so if
    // it drifted from the sidecar's, the server would routinely ask an offline
    // image for a model it never baked.
    expect(DEFAULT_XENOVA_EMBED_MODEL).toBe(AIR_GAP_EMBED_MODEL);
    expect(DEFAULT_XENOVA_EMBED_MODEL).toBe(DEFAULT_SIDECAR_EMBED_MODEL);
  });

  it("resolves the bake list from the compiled model-config, never a literal list", () => {
    expect(bakeStages.length, "expected a stage that bakes weights").toBeGreaterThan(0);
    for (const stage of bakeStages) {
      // The bake must import the SAME module the runtime uses...
      expect(stage).toContain("dist/model-config.js");
      // ...and drive its embed pipeline from the resolver's output, so the
      // "what we serve is what we bake" invariant lives in exactly one place.
      expect(stage).toMatch(/for \(const model of cfg\.resolveBakeModels\(process\.env\)\)/);
      expect(stage).toMatch(/t\.pipeline\('feature-extraction', model, \{ dtype \}\)/);
      // A literal HF model id passed straight to a bake would bypass the whole
      // resolver — that is the drift this guard exists to catch.
      expect(stage, "bake must not hardcode a feature-extraction model id").not.toMatch(
        /t\.pipeline\('feature-extraction', ['"]/,
      );
    }
  });

  it("exports the env the bake resolver reads into every baking stage", () => {
    for (const stage of bakeStages) {
      // resolveBakeModels() reads BAKE_EMBED_MODELS + EMBED_MODEL from
      // process.env; resolveRemoteHost() reads HF_ENDPOINT. An ARG that is never
      // promoted to ENV is invisible to `node -e`, so `--build-arg` would be
      // accepted and ignored.
      for (const name of ["EMBED_MODEL", "BAKE_EMBED_MODELS", "HF_ENDPOINT"]) {
        expect(stage, `baking stage must declare ARG ${name}`).toMatch(
          new RegExp(`^ARG ${name}=`, "m"),
        );
        expect(stage, `baking stage must export ENV ${name}`).toMatch(
          new RegExp(`^ENV ${name}=\\$\\{${name}\\}$`, "m"),
        );
      }
    }
  });

  it("keeps HF_HUB_OFFLINE=1 as the runtime default", () => {
    // The zero-egress guarantee. If this is ever relaxed, a missing baked model
    // stops being a loud boot failure and becomes a silent runtime download —
    // which is the corp-network 401 that started epic #780.
    expect(runnerStage).toMatch(/^ENV HF_HUB_OFFLINE=1$/m);
  });

  it("does not export a mirror endpoint into the RUNTIME stage", () => {
    // HF_ENDPOINT is a BUILD-time concern (fetch the weights from the corp
    // mirror). Baking it into the runtime image would hand an air-gapped pod a
    // URL to try, which is exactly the egress this image promises not to make.
    expect(runnerStage).not.toMatch(/^ENV HF_ENDPOINT=/m);
  });
});
