import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { findWorkspaceManifests } from "./pnpm-overrides-core.mjs";

/**
 * #149 / #150 (epic #130) — GitHub Copilot is gone from METIS, and stays gone.
 *
 * Replaces the #1347 single-version pin guard, which existed only because two Copilot
 * paths (in-process and the `copilot-svc` sidecar) had to run one SDK. With the provider
 * and the sidecar removed, the invariant is simpler and stricter: no workspace manifest
 * declares a `@github/copilot*` package, the lockfile resolves none, pnpm has no override
 * or workspace entry for them, and no server source imports one.
 *
 * The manifest domain is `findWorkspaceManifests` — exactly the set pnpm reads.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (name) => readFileSync(resolve(REPO_ROOT, name), "utf8");

const COPILOT_PACKAGE = /@github\/copilot/;

/** Every `.ts` file under `dir`, recursively (node_modules skipped). */
function tsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("no GitHub Copilot dependency remains (#149, #150)", () => {
  const workspace = read("pnpm-workspace.yaml");
  const { manifests, missing } = findWorkspaceManifests(REPO_ROOT, workspace);

  it("reads every workspace manifest — and the copilot-svc sidecar is not one of them", () => {
    expect(missing).toEqual([]);
    expect(workspace).not.toMatch(/copilot-svc/);
  });

  it("no workspace manifest declares a @github/copilot* package", () => {
    // Not vacuous: the server manifest (where the SDK used to live) is in the domain.
    expect(manifests.map((m) => m.path)).toContain("server/package.json");
    const offenders = manifests.filter((m) => COPILOT_PACKAGE.test(m.text)).map((m) => m.path);
    expect(offenders).toEqual([]);
  });

  it("the lockfile resolves no @github/copilot* package", () => {
    expect(read("pnpm-lock.yaml")).not.toMatch(COPILOT_PACKAGE);
  });

  it("pnpm-workspace.yaml carries no override for one", () => {
    expect(workspace).not.toMatch(COPILOT_PACKAGE);
  });

  it("no server source imports one", () => {
    const files = tsFiles(resolve(REPO_ROOT, "server", "src"));
    expect(files.length).toBeGreaterThan(100);
    const importers = files
      .filter((f) =>
        /from\s+["']@github\/copilot|import\(\s*["']@github\/copilot/.test(readFileSync(f, "utf8")),
      )
      .map((f) => relative(REPO_ROOT, f));
    expect(importers).toEqual([]);
  });
});
