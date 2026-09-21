/**
 * Issue #784 (review F2) — THE BAKE SCRIPT'S MODULE CONTRACT.
 *
 * `Dockerfile.embeddings` bakes weights with an inline `node -e` that reaches
 * into the COMPILED sidecar:
 *
 *   const cfg = await import(pathToFileURL('/deploy/dist/model-config.js').href);
 *   … cfg.resolveRemoteHost(process.env) … cfg.resolveBakeModels(process.env) …
 *
 * That is a string, so nothing in `tsc`, `eslint` or `vitest` sees it. And the
 * bake only ever RUNS at release time: `ci.yml` and the `build-images.yml` PR job
 * both pass `--build-arg BAKE_MODELS=0`, and the default (`BAKE_MODELS=1`) path is
 * reached only on `push: tags: v*` / `workflow_dispatch`. So a rename of
 * `resolveBakeModels`, or a change to the compiled layout, would go green through
 * every PR check and fail on the tag build — blocking a release rather than a PR.
 *
 * Making CI run the real bake is not the fix: it is a multi-arch buildx job that
 * downloads ~700 MB of ONNX weights, and it is release-gated deliberately. What
 * IS cheap is asserting the CONTRACT that `node -e` depends on:
 *
 *   - every `cfg.<fn>` it calls is really an export of `model-config.ts`;
 *   - every `process.env.<VAR>` it reads is really exported by the bake stage;
 *   - `/deploy/dist/model-config.js` is really where `pnpm deploy` + `tsc` put it.
 *
 * This test cannot prove the weights download. It does prove that the module
 * contract this line hardcodes is real — which is the failure mode that would
 * otherwise be discovered by a broken release.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as modelConfig from "../src/model-config.js";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(pkgRoot, "../..");

const dockerfile = readFileSync(resolve(repoRoot, "Dockerfile.embeddings"), "utf8");
const tsconfig = JSON.parse(readFileSync(resolve(pkgRoot, "tsconfig.json"), "utf8")) as {
  compilerOptions: { outDir: string; rootDir: string };
};
const pkg = JSON.parse(readFileSync(resolve(pkgRoot, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

/**
 * The `FROM`-delimited stage that RUNS the bake. Matched on the call, not the
 * word — the runner stage mentions `resolveBakeModels` in a comment.
 */
const bakeStage = dockerfile
  .split(/^FROM /m)
  .find((s) => s.includes("cfg.resolveBakeModels(process.env)"))!;

describe("bake script module contract (#784 F2)", () => {
  it("calls only functions that model-config actually exports", () => {
    const called = [...bakeStage.matchAll(/\bcfg\.(\w+)\(/g)].map((m) => m[1]);
    expect(
      called.length,
      "expected the bake to call into the compiled model-config",
    ).toBeGreaterThan(0);
    for (const name of new Set(called)) {
      expect(
        modelConfig,
        `Dockerfile.embeddings calls cfg.${name}() — model-config.ts must export it`,
      ).toHaveProperty(name);
      expect(
        typeof (modelConfig as unknown as Record<string, unknown>)[name],
        `cfg.${name} must be callable`,
      ).toBe("function");
    }
    // Belt and braces: these two ARE the bake's contract, so name them.
    expect(new Set(called)).toContain("resolveBakeModels");
    expect(new Set(called)).toContain("resolveRemoteHost");
  });

  it("reads only env the bake stage exports", () => {
    const read = new Set(
      [...bakeStage.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)].map((m) => m[1]),
    );
    for (const name of read) {
      expect(
        bakeStage,
        `bake reads process.env.${name} — the stage must export ENV ${name}`,
      ).toMatch(new RegExp(`^ENV ${name}=`, "m"));
    }
  });

  it("imports the module from the path pnpm deploy + tsc actually produce", () => {
    // The `node -e` hardcodes an absolute path into the compiled tree. Derive the
    // same path from the build inputs; if either moves, this fails in CI instead
    // of at release time.
    const deployDir = /pnpm .*deploy .*(\/deploy)\b/.exec(dockerfile)?.[1];
    expect(deployDir, "expected a `pnpm deploy` target dir in the Dockerfile").toBe("/deploy");

    expect(pkg.scripts.build, "the sidecar must build with tsc for dist/ to exist").toContain(
      "tsc",
    );
    expect(tsconfig.compilerOptions.rootDir).toBe("src");
    expect(tsconfig.compilerOptions.outDir).toBe("dist");

    // src/model-config.ts --(rootDir → outDir)--> dist/model-config.js
    const expectedPath = `${deployDir}/${tsconfig.compilerOptions.outDir}/model-config.js`;
    expect(expectedPath).toBe("/deploy/dist/model-config.js");
    expect(bakeStage).toContain(`pathToFileURL('${expectedPath}')`);
  });

  it("fails the bake loudly instead of shipping an image with no weights", () => {
    // The import above rejects if the layout moved; this is what turns that
    // rejection into a non-zero exit rather than an unhandled rejection warning
    // and a green `docker build`.
    expect(bakeStage).toMatch(
      /\.catch\(\(e\) => \{ console\.error\('\[bake\] FAILED', e\); process\.exit\(1\); \}\)/,
    );
  });
});
