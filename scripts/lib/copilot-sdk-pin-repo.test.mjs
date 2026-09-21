import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  COPILOT_SDK_PACKAGE,
  MINIMUM_DECLARATIONS,
  auditSingleVersionPin,
  resolvedVersions,
} from "./copilot-sdk-pin-core.mjs";
import { findWorkspaceManifests } from "./pnpm-overrides-core.mjs";

/**
 * The live guard (#1347): do THIS repo's two Copilot paths run the same SDK?
 *
 * `copilot-sdk-pin-core.test.mjs` proves the audit fails on each way that can go wrong.
 * This file points it at the real tree — and it was written before the fix and watched go
 * red on the drifted state (`server` at `^0.2.2`, `server/copilot-svc` at `^0.3.0`, both
 * resolved in the lockfile), which is the only evidence that it can fail here.
 *
 * The manifest domain comes from `findWorkspaceManifests`, i.e. exactly the set pnpm
 * itself reads, so it cannot drift from what is being guarded and no gitignored ingest
 * directory can enter it (see that function's note).
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (name) => readFileSync(resolve(REPO_ROOT, name), "utf8");

const lockfileText = read("pnpm-lock.yaml");
const { manifests, missing } = findWorkspaceManifests(REPO_ROOT, read("pnpm-workspace.yaml"));

const result = auditSingleVersionPin({ manifests, lockfileText });

describe("the two Copilot paths are pinned to one @github/copilot-sdk", () => {
  it("reads every workspace manifest", () => {
    expect(missing, "a package declared in pnpm-workspace.yaml has no package.json").toEqual([]);
  });

  it("reports no problems", () => {
    expect(
      result.problems.map((p) => `[${p.kind}] ${p.message}`),
      "the in-process (server/) and sidecar (server/copilot-svc/) Copilot paths are not " +
        "running the same SDK",
    ).toEqual([]);
  });

  // Stated separately from `problems` so a failure names the cause directly rather than
  // arriving as one line in a list.
  it("declares the SDK in both Copilot paths, with one range", () => {
    expect(result.declarations.map((d) => d.path).sort()).toEqual([
      "server/copilot-svc/package.json",
      "server/package.json",
    ]);
    expect(result.declarations.length).toBeGreaterThanOrEqual(MINIMUM_DECLARATIONS);
    expect(result.ranges).toHaveLength(1);
  });

  // The acceptance criterion's own check, by resolution rather than by manifest: two
  // carets can agree on paper and still resolve apart.
  it("resolves exactly one version in pnpm-lock.yaml", () => {
    expect(resolvedVersions(lockfileText, COPILOT_SDK_PACKAGE)).toHaveLength(1);
  });

  // Direction matters (#1347): converge UP onto the version the sidecar already runs in
  // production, never down onto 0.2.2. Without this, "make it one version" is satisfied
  // by dropping the sidecar back to the older SDK.
  it("converged onto the sidecar's 0.3.x, not back onto 0.2.x", () => {
    expect(result.ranges).toEqual(["^0.3.0"]);
    expect(resolvedVersions(lockfileText, COPILOT_SDK_PACKAGE)[0]).toMatch(/^0\.3\./);
  });
});
