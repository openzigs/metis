/**
 * Runner-level tests for `node scripts/verify-license-metadata.mjs` (#1296).
 *
 * The core's unit tests exercise pure functions over injected manifests. They cannot
 * see the three things that only exist in the runner, and that are exactly where a
 * gate fails open:
 *
 *   1. the `git ls-files` enumeration — does it find the manifests at all, and does
 *      it find them from the repository root rather than the caller's cwd?
 *   2. the exit code — a gate that prints a violation and exits 0 enforces nothing;
 *   3. the unreadable-file classification.
 *
 * The scripts package's coverage config measures `lib/**` only, so top-level runners
 * report 0% however well they are covered (#1207). Spawning the real script is what
 * covers this one; the percentage is not evidence about it either way.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptsDir = path.join(here, "..");
const scriptPath = path.join(scriptsDir, "verify-license-metadata.mjs");
const corePath = path.join(here, "license-metadata-core.mjs");
const repoRootPath = path.join(here, "repo-root.mjs");

/** @type {string[]} */
const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(/** @type {string} */ (tempDirs.pop()), { recursive: true, force: true });
  }
});

/**
 * A throwaway git repository carrying a copy of the gate and its dependencies, plus
 * whatever manifests the arm wants tracked.
 *
 * The core is copied verbatim rather than stubbed, so the arms run against the real
 * register: a manifest the register does not name is genuinely unreviewed here.
 *
 * @param {Record<string, string>} files repo-relative path -> contents
 * @returns {string} absolute path to the repository
 */
function makeRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "license-gate-"));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, "scripts", "lib"), { recursive: true });
  fs.copyFileSync(scriptPath, path.join(dir, "scripts", "verify-license-metadata.mjs"));
  fs.copyFileSync(corePath, path.join(dir, "scripts", "lib", "license-metadata-core.mjs"));
  fs.copyFileSync(repoRootPath, path.join(dir, "scripts", "lib", "repo-root.mjs"));

  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
  }

  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "gate@example.invalid"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "gate"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: dir });
  return dir;
}

/**
 * @param {string} cwd
 * @returns {{ status: number | null, stdout: string, stderr: string }}
 */
function runGate(cwd) {
  const result = spawnSync(
    process.execPath,
    [path.join("scripts", "verify-license-metadata.mjs")],
    {
      cwd,
      encoding: "utf8",
    },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Every manifest the shipped register names, all satisfying it. */
function compliantTree() {
  const paths = [
    "package.json",
    "server/package.json",
    "ui/package.json",
    "packages/shared/package.json",
    "packages/ui-kit/package.json",
    "e2e/package.json",
    "scripts/package.json",
    "server/copilot-svc/package.json",
    "server/embeddings-svc/package.json",
    "images/mcp-wrappers/code-graph-runner-sse/package.json",
  ];
  /** @type {Record<string, string>} */
  const files = {};
  for (const p of paths) {
    files[p] = `${JSON.stringify({ name: p, private: true, license: "AGPL-3.0-only" }, null, 2)}\n`;
  }
  return files;
}

describe("verify-license-metadata runner", () => {
  it("exits 0 and says what it checked on a compliant tree", () => {
    const { status, stdout } = runGate(makeRepo(compliantTree()));
    expect(status).toBe(0);
    expect(stdout).toContain("10 manifests");
    expect(stdout).toContain("AGPL-3.0-only");
  });

  // The whole point of a gate. A run that prints the violation and exits 0 is the
  // fail-open shape this repository has shipped several times (#1168, #1180, #1215).
  it("exits 1 and names the file when a manifest loses its licence", () => {
    const files = compliantTree();
    files["ui/package.json"] = `${JSON.stringify({ name: "ui", private: true }, null, 2)}\n`;
    const { status, stderr } = runGate(makeRepo(files));
    expect(status).toBe(1);
    expect(stderr).toContain("ui/package.json");
    expect(stderr).toContain("missing-license");
  });

  it("exits 1 on AGPL-3.0-or-later, which is a different licence and not a typo", () => {
    const files = compliantTree();
    files["server/package.json"] = `${JSON.stringify(
      { name: "server", private: true, license: "AGPL-3.0-or-later" },
      null,
      2,
    )}\n`;
    const { status, stderr } = runGate(makeRepo(files));
    expect(status).toBe(1);
    expect(stderr).toContain("wrong-license");
  });

  it("exits 1 when a manifest loses `private: true`", () => {
    const files = compliantTree();
    files["scripts/package.json"] = `${JSON.stringify(
      { name: "scripts", license: "AGPL-3.0-only" },
      null,
      2,
    )}\n`;
    const { status, stderr } = runGate(makeRepo(files));
    expect(status).toBe(1);
    expect(stderr).toContain("private-mismatch");
  });

  it("exits 1 on an eleventh manifest nobody reviewed", () => {
    const files = compliantTree();
    files["packages/new-thing/package.json"] = `${JSON.stringify(
      { name: "new-thing", private: true, license: "AGPL-3.0-only" },
      null,
      2,
    )}\n`;
    const { status, stderr } = runGate(makeRepo(files));
    expect(status).toBe(1);
    expect(stderr).toContain("unreviewed");
    expect(stderr).toContain("packages/new-thing/package.json");
  });

  it("exits 1 when a registered manifest has been deleted", () => {
    const files = compliantTree();
    delete files["e2e/package.json"];
    const { status, stderr } = runGate(makeRepo(files));
    expect(status).toBe(1);
    expect(stderr).toContain("stale-policy");
  });

  it("ignores manifests under node_modules rather than auditing dependencies", () => {
    const files = compliantTree();
    files["node_modules/left-pad/package.json"] = '{"name":"left-pad","license":"WTFPL"}\n';
    const { status, stdout } = runGate(makeRepo(files));
    expect(status).toBe(0);
    expect(stdout).toContain("10 manifests");
  });

  // `git ls-files` enumerates the CURRENT DIRECTORY's subtree, not the repository.
  // Run from `server/`, an unanchored gate would see two manifests, find both
  // compliant, and print success about a tree it never opened — measured on the
  // sibling gates as #1381. The anchor is what stops that, so it is asserted from a
  // subdirectory rather than assumed.
  it("audits the whole repository when run from a subdirectory", () => {
    const files = compliantTree();
    files["ui/package.json"] = `${JSON.stringify({ name: "ui", private: true }, null, 2)}\n`;
    const dir = makeRepo(files);
    const result = spawnSync(
      process.execPath,
      [path.join(dir, "scripts", "verify-license-metadata.mjs")],
      { cwd: path.join(dir, "server"), encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ui/package.json");
  });

  it("exits 1 rather than 0 when a tracked manifest is unparseable", () => {
    const files = compliantTree();
    files["packages/shared/package.json"] = "{ not json\n";
    const { status, stderr } = runGate(makeRepo(files));
    expect(status).toBe(1);
    expect(stderr).toContain("unreadable");
  });
});
