/**
 * Runner-level tests for `node scripts/verify-cla-workflow.mjs` (#1301).
 *
 * The core's unit tests exercise pure functions over injected text. They cannot see
 * the two things that only exist in the runner, and that are exactly where a gate
 * fails open:
 *
 *   1. the exit code — a gate that prints a violation and exits 0 enforces nothing;
 *   2. the file read, including the case where `.github/workflows/cla.yml` is not
 *      there at all, which must fail rather than pass vacuously.
 *
 * Both arms are present deliberately: a violating fixture must exit 1 AND a faithful
 * copy of the real workflow must exit 0. A gate tested on only the failing arm can be
 * one that fails on everything, which enforces nothing either.
 *
 * The scripts package's coverage config measures `lib/**` only, so top-level runners
 * report 0% however well they are covered (#1207). Spawning the real script is what
 * covers this one.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptsDir = path.join(here, "..");
const repoRoot = path.join(scriptsDir, "..");
const scriptPath = path.join(scriptsDir, "verify-cla-workflow.mjs");
const corePath = path.join(here, "cla-workflow-core.mjs");
const repoRootPath = path.join(here, "repo-root.mjs");
const realWorkflow = fs.readFileSync(path.join(repoRoot, ".github/workflows/cla.yml"), "utf8");

/** @type {string[]} */
const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(/** @type {string} */ (tempDirs.pop()), { recursive: true, force: true });
  }
});

/**
 * A throwaway repository carrying a copy of the gate and one workflow file.
 *
 * `chdirToRepoRoot` resolves the root with `git rev-parse`, so the fixture is a real
 * (if empty) repository rather than a bare `.git` directory.
 *
 * @param {string | null} workflowText `null` to omit the workflow entirely
 * @returns {string} absolute path to the repository
 */
function makeRepo(workflowText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cla-gate-"));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, "scripts", "lib"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  fs.copyFileSync(scriptPath, path.join(dir, "scripts", "verify-cla-workflow.mjs"));
  fs.copyFileSync(corePath, path.join(dir, "scripts", "lib", "cla-workflow-core.mjs"));
  fs.copyFileSync(repoRootPath, path.join(dir, "scripts", "lib", "repo-root.mjs"));

  if (workflowText !== null) {
    fs.mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".github", "workflows", "cla.yml"), workflowText);
  }
  return dir;
}

/**
 * @param {string} dir
 * @returns {{status: number | null, stdout: string, stderr: string}}
 */
function runGate(dir) {
  const result = spawnSync(process.execPath, [path.join(dir, "scripts/verify-cla-workflow.mjs")], {
    cwd: dir,
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("verify-cla-workflow runner", () => {
  it("exits 0 on the real workflow", () => {
    const result = runGate(makeRepo(realWorkflow));
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("same-repository");
  });

  it("exits 1 when remote-organization-name is reintroduced", () => {
    const broken = realWorkflow.replace(
      "path-to-signatures:",
      "remote-organization-name: openzigs\n          path-to-signatures:",
    );
    expect(broken).not.toBe(realWorkflow);
    const result = runGate(makeRepo(broken));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("remote-organization-name");
  });

  it("exits 1 when remote-repository-name is reintroduced", () => {
    const broken = realWorkflow.replace(
      "path-to-signatures:",
      "remote-repository-name: metis\n          path-to-signatures:",
    );
    expect(broken).not.toBe(realWorkflow);
    const result = runGate(makeRepo(broken));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("remote-repository-name");
  });

  it("exits 1 when the workflow is missing entirely", () => {
    const result = runGate(makeRepo(null));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("could not be read");
  });

  it("exits 1 when the CLA step has been renamed away", () => {
    const renamed = realWorkflow.replace(
      /contributor-assistant\/github-action/g,
      "some-fork/github-action",
    );
    expect(renamed).not.toBe(realWorkflow);
    const result = runGate(makeRepo(renamed));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no step using");
  });
});
