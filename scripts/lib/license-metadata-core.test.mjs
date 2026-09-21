/**
 * Unit arms for the licence-metadata audit (#1296).
 *
 * Every arm here proves the audit can FAIL on one specific way the tree can go wrong.
 * `license-metadata-repo.test.mjs` then points the same audit at the real tree; a
 * gate that only ever runs against a correct tree has never been shown to have a red
 * state at all.
 */
import { describe, expect, it } from "vitest";

import {
  OUTBOUND_LICENSE_ID,
  PUBLICATION_POLICY,
  auditLicenseMetadata,
  formatReport,
  isClean,
} from "./license-metadata-core.mjs";

const POLICY = [
  { path: "a/package.json", publishes: false, reason: "an application" },
  { path: "b/package.json", publishes: true, reason: "a published library" },
];

/** @param {Record<string, unknown>} fields */
const manifest = (path, fields) => ({ path, text: JSON.stringify(fields) });

const CLEAN = [
  manifest("a/package.json", { name: "a", license: OUTBOUND_LICENSE_ID, private: true }),
  manifest("b/package.json", { name: "b", license: OUTBOUND_LICENSE_ID }),
];

const audit = (manifests, policy = POLICY) => auditLicenseMetadata({ manifests, policy });
const kinds = (result) => result.problems.map((p) => p.kind).sort();

describe("a tree that satisfies the policy", () => {
  it("reports nothing", () => {
    const result = audit(CLEAN);
    expect(result.problems).toEqual([]);
    expect(isClean(result)).toBe(true);
  });

  it("lists what it reviewed, so the report is evidence of scope", () => {
    expect(audit(CLEAN).reviewed).toEqual(["a/package.json", "b/package.json"]);
  });

  it("says so in the report", () => {
    expect(formatReport(audit(CLEAN))).toContain("2 manifests");
  });
});

describe("the licence field", () => {
  it("flags a manifest with no license at all", () => {
    const result = audit([manifest("a/package.json", { name: "a", private: true }), CLEAN[1]]);
    expect(kinds(result)).toEqual(["missing-license"]);
    expect(result.problems[0].message).toContain("AGPL-3.0-only");
  });

  // The `-only` / `-or-later` distinction is the entire reason #1296 chose one over
  // the other: `-or-later` hands a future FSF version authority over these terms. A
  // gate that accepted either would not be enforcing the decision that was made.
  it("flags AGPL-3.0-or-later as the wrong licence, not a near-enough one", () => {
    const result = audit([
      manifest("a/package.json", { license: "AGPL-3.0-or-later", private: true }),
      CLEAN[1],
    ]);
    expect(kinds(result)).toEqual(["wrong-license"]);
    expect(result.problems[0].message).toContain("AGPL-3.0-or-later");
  });

  it("flags a permissive licence slipping back in", () => {
    const result = audit([manifest("a/package.json", { license: "MIT", private: true }), CLEAN[1]]);
    expect(kinds(result)).toEqual(["wrong-license"]);
  });

  it("flags a non-string licence field", () => {
    const result = audit([
      manifest("a/package.json", { license: { type: "AGPL-3.0-only" }, private: true }),
      CLEAN[1],
    ]);
    expect(kinds(result)).toEqual(["wrong-license"]);
  });
});

describe("the private flag", () => {
  it("flags a must-never-publish package that lost `private: true`", () => {
    const result = audit([manifest("a/package.json", { license: OUTBOUND_LICENSE_ID }), CLEAN[1]]);
    expect(kinds(result)).toEqual(["private-mismatch"]);
    expect(result.problems[0].message).toContain("npm publish");
  });

  it("flags `private: false` as spelled out, not only an omitted flag", () => {
    const result = audit([
      manifest("a/package.json", { license: OUTBOUND_LICENSE_ID, private: false }),
      CLEAN[1],
    ]);
    expect(kinds(result)).toEqual(["private-mismatch"]);
  });

  // The rule has to bite in BOTH directions, or "review per package" collapses back
  // into "set private everywhere", which is the blanket change #1296 forbade.
  it("flags a package intended for npm that still carries `private: true`", () => {
    const result = audit([
      CLEAN[0],
      manifest("b/package.json", { license: OUTBOUND_LICENSE_ID, private: true }),
    ]);
    expect(kinds(result)).toEqual(["private-mismatch"]);
    expect(result.problems[0].message).toContain("publishes");
  });

  it("does not treat a truthy non-true value as private", () => {
    const result = audit([
      manifest("a/package.json", { license: OUTBOUND_LICENSE_ID, private: "yes" }),
      CLEAN[1],
    ]);
    expect(kinds(result)).toEqual(["private-mismatch"]);
  });
});

describe("the identity axis — which manifests were reviewed at all", () => {
  // This is the arm that makes the gate survive contact with the future. An eleventh
  // package six weeks from now arrives with neither field, and no value-diff gate
  // would see it, because a gate that only compares the manifests it was told about
  // is silent about the one it was not.
  it("flags a manifest that has no policy entry", () => {
    const result = audit([...CLEAN, manifest("c/package.json", { license: OUTBOUND_LICENSE_ID })]);
    expect(kinds(result)).toEqual(["unreviewed"]);
    expect(result.problems[0].path).toBe("c/package.json");
  });

  it("does not also report licence or private problems for an unreviewed manifest", () => {
    // One finding, naming the real cause: nobody decided anything about this file.
    const result = audit([...CLEAN, manifest("c/package.json", { license: "MIT" })]);
    expect(kinds(result)).toEqual(["unreviewed"]);
  });

  it("flags a policy entry whose manifest is gone", () => {
    const result = audit([CLEAN[0]]);
    expect(kinds(result)).toEqual(["stale-policy"]);
    expect(result.problems[0].path).toBe("b/package.json");
  });

  it("flags an empty tree against a non-empty policy rather than passing", () => {
    const result = audit([]);
    expect(kinds(result)).toEqual(["stale-policy", "stale-policy"]);
  });
});

describe("fail-closed reading", () => {
  it("treats an unreadable manifest as a problem, never as clean", () => {
    const result = audit([{ path: "a/package.json", text: null }, CLEAN[1]]);
    expect(kinds(result)).toEqual(["unreadable"]);
    expect(isClean(result)).toBe(false);
  });

  it("treats unparseable JSON as a problem", () => {
    const result = audit([{ path: "a/package.json", text: "{not json" }, CLEAN[1]]);
    expect(kinds(result)).toEqual(["unreadable"]);
  });

  it("treats a JSON array as a problem", () => {
    const result = audit([{ path: "a/package.json", text: "[]" }, CLEAN[1]]);
    expect(kinds(result)).toEqual(["unreadable"]);
  });

  it("treats JSON null as a problem", () => {
    const result = audit([{ path: "a/package.json", text: "null" }, CLEAN[1]]);
    expect(kinds(result)).toEqual(["unreadable"]);
  });
});

describe("the reason requirement", () => {
  // #1296 asks for reasoning to be RECORDED per package. A required non-empty reason
  // is what makes that mechanical rather than a promise, so the gate has to fail on
  // a decision recorded without one.
  it.each([
    ["absent", undefined],
    ["empty", ""],
    ["whitespace", "   "],
    ["not a string", 42],
  ])("flags a policy entry whose reason is %s", (_label, reason) => {
    const result = audit(CLEAN, [{ path: "a/package.json", publishes: false, reason }, POLICY[1]]);
    expect(result.problems.some((p) => p.kind === "unreasoned")).toBe(true);
  });

  it("checks reasons even for entries whose manifest is missing", () => {
    const result = audit([], [{ path: "gone/package.json", publishes: false, reason: "" }]);
    expect(kinds(result)).toEqual(["stale-policy", "unreasoned"]);
  });
});

describe("input validation", () => {
  it("throws rather than silently passing on a non-array of manifests", () => {
    expect(() => auditLicenseMetadata({ manifests: null })).toThrow(TypeError);
  });

  it("throws rather than silently passing on a non-array policy", () => {
    expect(() => auditLicenseMetadata({ manifests: [], policy: "all of them" })).toThrow(TypeError);
  });
});

describe("the shipped policy itself", () => {
  it("names every entry exactly once", () => {
    const paths = PUBLICATION_POLICY.map((e) => e.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("carries a substantive reason on every entry", () => {
    for (const entry of PUBLICATION_POLICY) {
      expect(entry.reason.trim().length, `${entry.path} has a token reason`).toBeGreaterThan(30);
    }
  });

  it("gives each package its own reason rather than one pasted rule", () => {
    const reasons = PUBLICATION_POLICY.map((e) => e.reason);
    expect(new Set(reasons).size).toBe(reasons.length);
  });

  it("formats problems with kind, path and message", () => {
    const report = formatReport(audit([CLEAN[0]]));
    expect(report).toContain("[stale-policy]");
    expect(report).toContain("b/package.json");
  });
});
