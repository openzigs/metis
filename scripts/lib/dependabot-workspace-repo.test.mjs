import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ancestorsOf,
  auditDependabotWorkspaceScope,
  collectLockfileDirs,
  COOLDOWN_FLOOR_DAYS,
  LOCKFILE_NAMES,
  parseDependabotUpdates,
} from "./dependabot-workspace-core.mjs";
import { findWorkspaceManifests } from "./pnpm-overrides-core.mjs";

/**
 * The live guard (#1283): does THIS repo's `.github/dependabot.yml` only point npm
 * ecosystems at directories that own the lockfile they would have to regenerate?
 *
 * `dependabot-workspace-core.test.mjs` proves the audit goes red on each way that can go
 * wrong. This file points it at the real tree — the pre-#1283 config, with its
 * `directory: "/ui"` entry beside the root one, fails the first assertion below.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (name) => readFileSync(resolve(REPO_ROOT, name), "utf8");

const dependabotText = read(".github/dependabot.yml");
const workspaceText = read("pnpm-workspace.yaml");

// Workspace directories, expanded through pnpm's own `packages:` globs by the module
// that already owns that expansion — one source of truth, not a second copy of it.
const { manifests } = findWorkspaceManifests(REPO_ROOT, workspaceText);
const workspaceDirs = manifests.map((m) => (m.path === "package.json" ? "" : dirname(m.path)));

const entries = parseDependabotUpdates(dependabotText);
const npmDirs = entries.filter((e) => e.ecosystem === "npm").flatMap((e) => e.directories);

const candidateDirs = new Set([
  "",
  ...workspaceDirs,
  ...npmDirs,
  ...npmDirs.flatMap((dir) => ancestorsOf(dir)),
]);
const lockfileDirs = collectLockfileDirs(REPO_ROOT, candidateDirs);

const result = auditDependabotWorkspaceScope({
  dependabotText,
  lockfileDirs,
  workspacePackages: workspaceDirs.filter((d) => d !== ""),
  cooldownFloorDays: COOLDOWN_FLOOR_DAYS,
});

describe("dependabot.yml matches where this repo's lockfiles actually live", () => {
  it("reports no problems", () => {
    expect(
      result.problems.map((p) => `[${p.kind}] ${p.message}`),
      "a Dependabot npm ecosystem is pointed at a directory it cannot relock",
    ).toEqual([]);
  });

  // Fail closed. Every assertion above is satisfied by an empty config, which is the
  // shape that made four gates unable to fail in one week (#1168/#1178/#1180/#1192).
  it("still declares an npm ecosystem rooted where the lockfile is", () => {
    const covering = result.npmEntries.filter((e) =>
      e.directories.some((d) => lockfileDirs.has(d)),
    );
    expect(covering.length).toBeGreaterThanOrEqual(1);
    expect(result.entries.map((e) => e.ecosystem)).toContain("github-actions");
  });

  // Acceptance criterion of #1283: the fix must not be "give /ui its own lockfile".
  //
  // Scoped to the pnpm WORKSPACE, not to the whole tree. `images/mcp-wrappers/*` is a
  // tracked standalone npm subproject with its own pinned dependencies whose Dockerfile
  // runs `npm ci` when a `package-lock.json` is present and `npm install` when it is not
  // (images/mcp-wrappers/code-graph-runner-sse/Dockerfile) — landing that lockfile is an
  // anticipated, legitimate change and none of this guard's business. A whole-tree
  // assertion banned it, which #1283's adversarial panel caught.
  it("has no lockfile in any pnpm workspace member but the root", () => {
    const tracked = execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    const lockfiles = tracked.filter((path) =>
      LOCKFILE_NAMES.includes(path.slice(path.lastIndexOf("/") + 1)),
    );
    const members = new Set(workspaceDirs);
    const insideWorkspace = lockfiles.filter((path) => {
      const cut = path.lastIndexOf("/");
      return members.has(cut === -1 ? "" : path.slice(0, cut));
    });
    expect(insideWorkspace, "a second lockfile inside the pnpm workspace").toEqual([
      "pnpm-lock.yaml",
    ]);
    // The floor: the workspace list must be non-trivial, or the filter above is vacuous.
    expect(members.size).toBeGreaterThanOrEqual(5);
  });

  // #586: the cooldown mirrors `minimumReleaseAge: 10080`. Restated on its own so a
  // regression names its own cause rather than arriving as one line of a problem list.
  it("holds the #586 cooldown floor on every ecosystem", () => {
    expect(entries.length).toBeGreaterThanOrEqual(2);
    for (const entry of entries) {
      expect(
        entry.cooldownDays,
        `${entry.ecosystem} at line ${entry.lineNumber}`,
      ).toBeGreaterThanOrEqual(COOLDOWN_FLOOR_DAYS);
    }
  });

  // Pin the FLOOR ITSELF, not just conformance to it. Asserting `cooldownDays >=
  // COOLDOWN_FLOOR_DAYS` measures the config against a constant the same commit can
  // lower, so dropping both to 4 stayed green — the #1283 panel's test-falsifiability
  // objection. #586's actual invariant is the MIRROR, so assert that: the floor is
  // `minimumReleaseAge` expressed in days, and it is 7.
  it("pins the floor to pnpm's minimumReleaseAge, in days", () => {
    const match = /minimumReleaseAge:\s*(\d+)/.exec(workspaceText);
    expect(match, "pnpm-workspace.yaml no longer declares minimumReleaseAge").not.toBeNull();
    expect(COOLDOWN_FLOOR_DAYS).toBe(Number(match[1]) / (60 * 24));
    expect(COOLDOWN_FLOOR_DAYS).toBe(7);
  });
});
