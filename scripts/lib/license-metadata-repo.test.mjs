/**
 * The live guard (#1296): does THIS repository's licence metadata hold?
 *
 * `license-metadata-core.test.mjs` proves the audit fails on each way it can go
 * wrong. This file points it at the real tree, and it was written and watched go red
 * on the pre-#1296 state — ten manifests with no `license` field at all — which is
 * the only evidence that it can fail here.
 *
 * The manifest domain comes from `git ls-files`, i.e. everything the repository
 * actually tracks, rather than from a hardcoded list or from `pnpm-workspace.yaml`.
 * Both of those would have missed `images/mcp-wrappers/code-graph-runner-sse` — it is
 * a Docker build context, not a workspace member — which is exactly the manifest both
 * #1296's original body ("four") and #1322 B3's correction ("five") undercounted.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  OUTBOUND_LICENSE_ID,
  PUBLICATION_POLICY,
  auditLicenseMetadata,
  formatReport,
} from "./license-metadata-core.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** @returns {string[]} every tracked package.json, repo-relative */
function trackedManifests() {
  const out = execFileSync("git", ["ls-files", "-z", "*package.json"], {
    cwd: REPO_ROOT,
    maxBuffer: 16 * 1024 * 1024,
  });
  return out
    .toString("utf8")
    .split("\0")
    .filter((path) => path.length > 0 && !path.includes("node_modules/"))
    .sort();
}

const manifests = trackedManifests().map((path) => {
  let text = null;
  try {
    text = readFileSync(resolve(REPO_ROOT, path), "utf8");
  } catch {
    text = null;
  }
  return { path, text };
});

const result = auditLicenseMetadata({ manifests });

describe("this repository's licence metadata (#1296)", () => {
  it("reports no problems", () => {
    expect(result.problems, formatReport(result)).toEqual([]);
  });

  // The count is asserted because #1296 and #1322 B3 each got it wrong (four, then
  // five). If an eleventh manifest appears, this arm and the `unreviewed` arm both
  // fire, and the fix is to review the new package — not to bump the number.
  // Nine since #150 removed the `server/copilot-svc` sidecar and its manifest.
  it("covers all nine tracked manifests", () => {
    expect(result.reviewed).toHaveLength(9);
    expect(result.reviewed).toContain("images/mcp-wrappers/code-graph-runner-sse/package.json");
  });

  it("declares AGPL-3.0-only, and nowhere declares -or-later", () => {
    for (const { path, text } of manifests) {
      const parsed = JSON.parse(/** @type {string} */ (text));
      expect(parsed.license, `${path} declares the wrong licence`).toBe(OUTBOUND_LICENSE_ID);
    }
    expect(OUTBOUND_LICENSE_ID).toBe("AGPL-3.0-only");
  });

  // The recorded #1296 decision: nothing here is distributed through npm, so every
  // manifest keeps `private: true`. Stated as an assertion so flipping one is a
  // deliberate edit to this file and its reason, never a silent manifest tweak.
  it("records every package as never-publishing, each with its own reason", () => {
    expect(PUBLICATION_POLICY.every((entry) => entry.publishes === false)).toBe(true);
    expect(PUBLICATION_POLICY).toHaveLength(9);
  });

  // Two sources of truth for one licence — the ten manifests and the §13 offer the
  // running application serves — is exactly the #1180 shape, where two lists with
  // different filters both looked authoritative. This ties them together.
  //
  // Read as TEXT rather than imported: `scripts` does not depend on `@metis/shared`
  // and must not start to for one assertion. A missing or renamed constant fails
  // here loudly instead of resolving to `undefined` and passing.
  it("agrees with the SPDX id the running application serves at /source", () => {
    const shared = readFileSync(resolve(REPO_ROOT, "packages/shared/src/source-offer.ts"), "utf8");
    const declared = /export const OUTBOUND_LICENSE_ID = "([^"]+)"/.exec(shared);
    expect(declared, "OUTBOUND_LICENSE_ID is not declared where this gate reads it").not.toBeNull();
    expect(declared?.[1]).toBe(OUTBOUND_LICENSE_ID);
  });
});

describe("the licence files themselves", () => {
  const read = (name) => readFileSync(resolve(REPO_ROOT, name), "utf8");

  it("ships an AGPL-3.0 LICENSE containing the §13 network clause", () => {
    const licence = read("LICENSE");
    expect(licence).toContain("GNU AFFERO GENERAL PUBLIC LICENSE");
    expect(licence).toContain("Version 3, 19 November 2007");
    expect(licence).toContain("13. Remote Network Interaction");
  });

  it("ships a NOTICE naming Zylos Labs LLC as the copyright holder", () => {
    const notice = read("NOTICE");
    expect(notice).toContain("Zylos Labs LLC");
    expect(notice).toContain("SPDX-License-Identifier: AGPL-3.0-only");
  });

  // The jszip election is a decision that only exists if it is written down; an
  // unrecorded election has to be re-derived by every reader of the dependency list.
  it("records the jszip MIT election and the GPL-2.0-only verification", () => {
    const notice = read("NOTICE");
    expect(notice).toMatch(/elects the MIT arm of jszip/i);
    expect(notice).toMatch(/GPL-2\.0-only/);
  });
});
