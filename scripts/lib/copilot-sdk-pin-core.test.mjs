import { describe, expect, it } from "vitest";

import {
  COPILOT_SDK_PACKAGE,
  DEPENDENCY_FIELDS,
  MINIMUM_DECLARATIONS,
  auditSingleVersionPin,
  collectDeclarations,
  resolvedVersions,
  satisfiesRange,
} from "./copilot-sdk-pin-core.mjs";

/**
 * Unit proofs for the single-version pin audit (#1347).
 *
 * `copilot-sdk-pin-repo.test.mjs` points the audit at the real tree; this file proves the
 * audit can FAIL, one arm per way the invariant can break. Every arm that asserts a
 * failure is paired with a restore arm asserting the same input passes once repaired —
 * without that pair, an audit that returned a problem for *every* input would satisfy the
 * failure arms and still be worthless (#1168's shape, four times over).
 */

const manifest = (path, range, field = "dependencies") =>
  range === null
    ? { path, text: JSON.stringify({ name: path }) }
    : { path, text: JSON.stringify({ name: path, [field]: { [COPILOT_SDK_PACKAGE]: range } }) };

/** A lockfile fragment shaped like the sections pnpm writes package keys into. */
const lockfile = (...versions) =>
  [
    "packages:",
    ...versions.map(
      (v) => `  '${COPILOT_SDK_PACKAGE}@${v}':\n    resolution: {integrity: sha512-x}`,
    ),
    "snapshots:",
    ...versions.map((v) => `  '${COPILOT_SDK_PACKAGE}@${v}':\n    dependencies:\n      zod: 4.4.3`),
  ].join("\n");

const CONVERGED = {
  manifests: [
    manifest("server/package.json", "^0.3.0"),
    manifest("server/copilot-svc/package.json", "^0.3.0"),
  ],
  lockfileText: lockfile("0.3.0"),
};

const kinds = (input) => auditSingleVersionPin(input).problems.map((p) => p.kind);

describe("auditSingleVersionPin", () => {
  it("passes the converged tree", () => {
    const result = auditSingleVersionPin(CONVERGED);
    expect(result.problems).toEqual([]);
    expect(result.ranges).toEqual(["^0.3.0"]);
    expect(result.resolved).toEqual(["0.3.0"]);
    expect(result.declarations).toHaveLength(2);
  });

  it("fails when the two manifests pin different ranges", () => {
    // The state this issue found: server at ^0.2.2, sidecar at ^0.3.0.
    const drifted = {
      manifests: [
        manifest("server/package.json", "^0.2.2"),
        manifest("server/copilot-svc/package.json", "^0.3.0"),
      ],
      lockfileText: lockfile("0.2.2", "0.3.0"),
    };
    expect(kinds(drifted)).toContain("pin-drift");
    expect(kinds(drifted)).toContain("multiple-resolutions");
    // Restore arm: the same shape, converged, is clean.
    expect(kinds(CONVERGED)).toEqual([]);
  });

  it("fails when the manifests agree but the lockfile resolves two versions", () => {
    // Ranges alone are not evidence — this is why the AC insists on resolution.
    const twoResolutions = { ...CONVERGED, lockfileText: lockfile("0.3.0", "0.3.1") };
    expect(kinds(twoResolutions)).toEqual(["multiple-resolutions"]);
  });

  it("fails when the lockfile resolves the package nowhere", () => {
    // Fails CLOSED: "no resolution" must not read as "one resolution".
    expect(kinds({ ...CONVERGED, lockfileText: "packages:\n  zod@4.4.3: {}" })).toEqual([
      "no-resolution",
    ]);
  });

  it("fails when a Copilot path stops declaring the SDK at all", () => {
    // The fail-open axis: one declaration is trivially "one range", and the lockfile
    // still resolves exactly one version. Only the count catches this.
    const dropped = {
      manifests: [
        manifest("server/package.json", "^0.3.0"),
        manifest("server/copilot-svc/package.json", null),
      ],
      lockfileText: lockfile("0.3.0"),
    };
    expect(kinds(dropped)).toEqual(["too-few-declarations"]);
  });

  it("fails when no manifest declares the SDK", () => {
    // Zero is internally consistent with every other assertion here and must still fail.
    const none = {
      manifests: [manifest("a/package.json", null), manifest("b/package.json", null)],
      lockfileText: lockfile("0.3.0"),
    };
    expect(kinds(none)).toEqual(["too-few-declarations"]);
  });

  it("fails when the resolved version does not satisfy a declared range", () => {
    // A hand-edited lockfile converging onto a version no manifest asked for.
    const forged = { ...CONVERGED, lockfileText: lockfile("0.4.0") };
    expect(kinds(forged)).toEqual(["resolution-outside-range", "resolution-outside-range"]);
    expect(auditSingleVersionPin(forged).problems[0].message).toContain("server/package.json");
  });

  it("fails on a range vocabulary it cannot evaluate, rather than passing it", () => {
    const exotic = {
      manifests: [
        manifest("server/package.json", ">=0.3.0"),
        manifest("server/copilot-svc/package.json", ">=0.3.0"),
      ],
      lockfileText: lockfile("0.3.0"),
    };
    expect(kinds(exotic)).toEqual(["unsupported-range", "unsupported-range"]);
  });

  it("fails on an unreadable manifest rather than skipping it", () => {
    const broken = {
      manifests: [...CONVERGED.manifests, { path: "ui/package.json", text: "{ not json" }],
      lockfileText: lockfile("0.3.0"),
    };
    expect(kinds(broken)).toEqual(["unreadable-manifest"]);
  });

  it("treats JSON that is not an object as unreadable", () => {
    const scalar = {
      manifests: [...CONVERGED.manifests, { path: "x/package.json", text: "null" }],
      lockfileText: lockfile("0.3.0"),
    };
    expect(kinds(scalar)).toEqual(["unreadable-manifest"]);
  });

  it("honours an explicit package name and declaration floor", () => {
    const other = {
      manifests: [
        {
          path: "a/package.json",
          text: JSON.stringify({ dependencies: { "left-pad": "^1.2.3" } }),
        },
      ],
      lockfileText: "packages:\n  'left-pad@1.2.3': {}",
      packageName: "left-pad",
      minimumDeclarations: 1,
    };
    expect(kinds(other)).toEqual([]);
  });
});

describe("collectDeclarations", () => {
  it("finds the package in every dependency field pnpm resolves from", () => {
    for (const field of DEPENDENCY_FIELDS) {
      const { declarations } = collectDeclarations(
        [manifest("p/package.json", "^0.3.0", field)],
        COPILOT_SDK_PACKAGE,
      );
      expect(declarations, `field ${field} was not searched`).toEqual([
        { path: "p/package.json", field, range: "^0.3.0" },
      ]);
    }
  });

  it("ignores a non-string range and a non-object dependency block", () => {
    const odd = [
      { path: "a/package.json", text: JSON.stringify({ dependencies: "nonsense" }) },
      {
        path: "b/package.json",
        text: JSON.stringify({ dependencies: { [COPILOT_SDK_PACKAGE]: { from: "git" } } }),
      },
    ];
    const { declarations, unreadable } = collectDeclarations(odd, COPILOT_SDK_PACKAGE);
    expect(declarations).toEqual([]);
    expect(unreadable).toEqual([]);
  });

  it("tolerates a missing manifest list", () => {
    expect(collectDeclarations(undefined, COPILOT_SDK_PACKAGE)).toEqual({
      declarations: [],
      unreadable: [],
    });
  });
});

describe("resolvedVersions", () => {
  it("reads the lockfile's own package keys, deduplicated and sorted", () => {
    expect(resolvedVersions(lockfile("0.3.0", "0.2.2"), COPILOT_SDK_PACKAGE)).toEqual([
      "0.2.2",
      "0.3.0",
    ]);
  });

  it("does not confuse a longer package name that shares this prefix", () => {
    // `@github/copilot` is a REAL sibling in this tree; `@github/copilot-sdk` must not
    // match `@github/copilot@1.0.60`, nor the reverse.
    const text = "packages:\n  '@github/copilot@1.0.60': {}\n  '@github/copilot-sdk@0.3.0': {}";
    expect(resolvedVersions(text, "@github/copilot-sdk")).toEqual(["0.3.0"]);
    expect(resolvedVersions(text, "@github/copilot")).toEqual(["1.0.60"]);
  });

  it("ignores an occurrence not followed by a version", () => {
    // Three real shapes: an importers-style mention, a name@ with a non-numeric tail, and
    // the name@ ending the file. None of them is a resolution.
    const text = [
      "packages:",
      `  '${COPILOT_SDK_PACKAGE}@': {}`,
      `  '${COPILOT_SDK_PACKAGE}@workspace': {}`,
      `  '${COPILOT_SDK_PACKAGE}@0.3.0': {}`,
    ].join("\n");
    expect(resolvedVersions(text, COPILOT_SDK_PACKAGE)).toEqual(["0.3.0"]);
    expect(resolvedVersions(`${COPILOT_SDK_PACKAGE}@`, COPILOT_SDK_PACKAGE)).toEqual([]);
  });

  it("reduces pnpm's peer-suffixed keys to the version they resolve", () => {
    // pnpm writes `'pkg@1.2.3(peer@4)'` for a peer-parameterised install. Two peer sets of
    // the same version are ONE version for this gate's purposes, so the suffix is dropped
    // rather than counted as drift.
    const text = [
      "snapshots:",
      "  'left-pad@1.2.3(react@19.0.0)': {}",
      "  'left-pad@1.2.3(react@18.0.0)': {}",
      "  'left-pad@1.2.4': {}",
    ].join("\n");
    expect(resolvedVersions(text, "left-pad")).toEqual(["1.2.3", "1.2.4"]);
  });

  it("returns nothing for a non-string lockfile", () => {
    expect(resolvedVersions(undefined, COPILOT_SDK_PACKAGE)).toEqual([]);
  });
});

describe("satisfiesRange", () => {
  it("treats a caret on the 0.x line as bounded by the next MINOR", () => {
    // The whole reason ^0.2.2 and ^0.3.0 could not converge on their own.
    expect(satisfiesRange("^0.3.0", "0.3.9")).toBe(true);
    expect(satisfiesRange("^0.3.0", "0.4.0")).toBe(false);
    expect(satisfiesRange("^0.2.2", "0.3.0")).toBe(false);
    expect(satisfiesRange("^0.3.0", "0.2.9")).toBe(false);
  });

  it("treats a caret on a 1.x line as bounded by the next MAJOR", () => {
    expect(satisfiesRange("^1.2.3", "1.99.0")).toBe(true);
    expect(satisfiesRange("^1.2.3", "2.0.0")).toBe(false);
    expect(satisfiesRange("^1.2.3", "1.2.2")).toBe(false);
  });

  it("bounds a tilde at the next minor on every line", () => {
    expect(satisfiesRange("~1.2.3", "1.2.9")).toBe(true);
    expect(satisfiesRange("~1.2.3", "1.3.0")).toBe(false);
  });

  it("matches an exact pin only exactly", () => {
    expect(satisfiesRange("0.3.0", "0.3.0")).toBe(true);
    expect(satisfiesRange("0.3.0", "0.3.1")).toBe(false);
    expect(satisfiesRange(" 0.3.0 ", "0.3.0")).toBe(true);
  });

  it("returns null — not a verdict — for input it cannot parse", () => {
    expect(satisfiesRange(">=0.3.0", "0.3.0")).toBeNull();
    expect(satisfiesRange("workspace:*", "0.3.0")).toBeNull();
    expect(satisfiesRange("^0.3", "0.3.0")).toBeNull();
    expect(satisfiesRange(undefined, "0.3.0")).toBeNull();
    expect(satisfiesRange("^0.3.0", "not-a-version")).toBeNull();
    expect(satisfiesRange("^0.3.0", undefined)).toBeNull();
  });

  it("compares prerelease-suffixed versions by their release triple", () => {
    expect(satisfiesRange("^0.3.0", "0.3.1-preview.0")).toBe(true);
  });
});

describe("exported constants", () => {
  it("names the package this gate exists for", () => {
    expect(COPILOT_SDK_PACKAGE).toBe("@github/copilot-sdk");
  });

  it("requires both Copilot paths to declare it", () => {
    expect(MINIMUM_DECLARATIONS).toBe(2);
  });
});
