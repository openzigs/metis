import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Issue #1382 — the corpus restore must be wired to every path that runs the server
 * suite, and to the nightly that reads the same corpus.
 *
 * ## Why this test exists rather than a comment
 *
 * The first attempt wired the restore into the ROOT `pnpm test` only. That looked like
 * "one place", and it was not: `ci.yml`'s `postgres-adapter` job runs `pnpm test` with
 * `working-directory: server`, which resolves to the SERVER package's own script and
 * never touches the root one. Measured on the first CI run of this branch — `api`
 * (root) failed 2 test files, `postgres-adapter` (server) failed 4, and the two extra
 * were the doc-retrieval suites whose corpus had not been restored.
 *
 * So the invariant is about the package that READS the corpus, not about a convenient
 * entry point: every script that starts `vitest` over `server/` restores first. A
 * future entry point that forgets it turns this red instead of turning a nightly or a
 * job red days later.
 */

const scriptsDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(scriptsDir);

/** @param {string} rel */
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(repoRoot, rel), "utf8"));

const RESTORE = "restore-corpus-doc-snapshots.mjs";

describe("the corpus restore is wired to every runner of the server suite", () => {
  const serverScripts = readJson("server/package.json").scripts;

  it.each([["test"], ["test:coverage"]])(
    "server's `%s` restores the corpus before starting vitest",
    (name) => {
      const script = serverScripts[name];
      expect(script, `server/package.json has no \`${name}\` script`).toBeDefined();
      expect(script).toContain(RESTORE);
      // Order matters: a restore after vitest would run when the suite has already
      // failed on the missing directory.
      expect(script.indexOf(RESTORE)).toBeLessThan(script.indexOf("vitest"));
    },
  );

  it("the root `test` fans out to the server package rather than duplicating the restore", () => {
    // Two copies of the same wiring is how the two drift apart; the root script is the
    // fan-out and the server script is where the corpus is actually needed.
    const root = readJson("package.json").scripts.test;
    expect(root).toContain("-r");
    expect(root).not.toContain(RESTORE);
  });

  it("the restore script the scripts point at actually exists", () => {
    expect(fs.existsSync(path.join(scriptsDir, RESTORE))).toBe(true);
  });
});

describe("the nightly domain eval restores the corpus before it reads it", () => {
  const lines = fs
    .readFileSync(path.join(repoRoot, ".github/workflows/eval-domain-nightly.yml"), "utf8")
    .split("\n");

  /**
   * Line number of the first non-comment line mentioning `needle`, or -1.
   *
   * Two drafts of this helper were wrong and both are worth stating, because each
   * failure mode is invisible from the assertion:
   *
   *  - `indexOf` over the whole file matched the COMMENT explaining the restore step,
   *    which mentions `pnpm eval:answer-correctness` several lines above the step it
   *    precedes. Prose is not execution order.
   *  - Matching only lines that start with `run:` missed every command inside a
   *    `run: |` block scalar — `eval-results-branch.mjs publish` is one — and returned
   *    -1 for a step that is plainly there.
   *
   * Skipping comment lines and accepting any command line handles both.
   *
   * @param {string} needle
   * @returns {number}
   */
  const runStep = (needle) =>
    lines.findIndex((line) => !line.trim().startsWith("#") && line.includes(needle));

  it("runs the restore, and runs it before `pnpm eval:answer-correctness`", () => {
    // `eval:answer-correctness` calls `loadDocRetrievalCorpus` unconditionally, so
    // without the restore the step fails on every run and the publish step — which
    // carries the default `success()` condition — is skipped, which is how the nightly
    // would silently stop committing anything. That is #1333 again, by a new route.
    const restoreAt = runStep(RESTORE);
    const evalAt = runStep("pnpm eval:answer-correctness");
    expect(restoreAt, `no \`run:\` step invokes ${RESTORE}`).toBeGreaterThan(-1);
    expect(evalAt).toBeGreaterThan(-1);
    expect(restoreAt).toBeLessThan(evalAt);
  });

  it("runs the restore before `pnpm eval:domain` too", () => {
    // The `> -1` guard is not ceremony: a missing restore returns -1, which is less
    // than every real line number, so without it this arm passes VACUOUSLY when the
    // step is deleted. Measured — mutant 2 (step removed) turned only the sibling arm
    // red until this was added.
    const restoreAt = runStep(RESTORE);
    expect(restoreAt).toBeGreaterThan(-1);
    expect(restoreAt).toBeLessThan(runStep("pnpm eval:domain"));
  });

  it("mounts the eval-results branch before anything writes an envelope", () => {
    // Order the other way round and the eval writes into a plain ignored directory
    // that the publish step then replaces.
    const mountAt = runStep("eval-results-branch.mjs checkout");
    expect(mountAt).toBeGreaterThan(-1);
    expect(mountAt).toBeLessThan(runStep("pnpm eval:domain"));
    expect(runStep("eval-results-branch.mjs publish")).toBeGreaterThan(
      runStep("eval-results-commit-guard.mjs"),
    );
  });
});

describe("nothing under eval-results/ is tracked", () => {
  /**
   * The directory-level invariant #1382 establishes, asserted against the real index
   * rather than against `.gitignore` prose.
   *
   * This replaces an earlier arm that staged the fixture with `git add -A` and filtered
   * the result. That arm was vacuous: `eval-results/` is a nested worktree in the
   * fixture, so git stages it as a single gitlink path with NO trailing slash, and the
   * `startsWith("eval-results/")` filter came back empty whatever `.gitignore` said —
   * it passed with the rule deleted outright.
   */
  it("git ls-files reports no path under eval-results/", () => {
    const tracked = execFileSync("git", ["ls-files", "--", "eval-results"], {
      cwd: repoRoot,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
    expect(tracked).toEqual([]);
  });

  it("git check-ignore reports a would-be nightly envelope as ignored, by a POSITIVE rule", () => {
    /*
     * Two signals, because the obvious one is not falsifiable on its own.
     *
     * The first draft ran `check-ignore -v` and asserted the output mentioned
     * `.gitignore` and `eval-results/`. Measured against the PRE-#1382 rule
     * (`eval-results/*` plus `!eval-results/[0-9]*.json`), that passes: `-v` exits 0
     * and prints `.gitignore:2:!eval-results/[0-9]*.json` for a path it is telling you
     * is NOT ignored. Both `toContain`s were satisfied by the negation.
     *
     * So: plain `check-ignore`, whose exit code really does distinguish the two (1 when
     * not ignored — measured, git 2.54.0), AND an assertion that the matching pattern
     * is not a negation. Either one alone would have let the old rule through.
     */
    const plain = spawnSync("git", ["check-ignore", "eval-results/2026-01-01T00-00-00-000Z.json"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(plain.status, "the path is not ignored at all").toBe(0);

    const verbose = execFileSync(
      "git",
      ["check-ignore", "-v", "eval-results/2026-01-01T00-00-00-000Z.json"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    // `<source>:<line>:<pattern>\t<path>` — the pattern is the third colon field.
    const pattern = verbose.split("\t")[0].split(":")[2];
    expect(verbose).toContain(".gitignore");
    expect(pattern, "a negation is git telling you the path is NOT ignored").not.toMatch(/^!/);
    expect(pattern).toContain("eval-results/");
  });

  it("the two committed provenance artefacts live outside it, and ARE tracked", () => {
    // They are fixtures a test reads on every run, not nightly output — see
    // server/src/lib/eval/provenance/README.md.
    const tracked = execFileSync("git", ["ls-files", "--", "server/src/lib/eval/provenance"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(tracked).toContain("doc-retrieval-chunk-sweep-2026-07-31T20-37-55-374Z.json");
    expect(tracked).toContain("answer-correctness-2026-08-30T14-57-51-691Z.json");
  });
});
