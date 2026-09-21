import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  ENGINES_PNPM_FLOOR,
  OverridesParseError,
  UNBOUNDED,
  WORKSPACE_OVERRIDES_FLOOR,
  auditOverrides,
  ceilingMajorOf,
  collectPnpmFieldDeclarations,
  diffOverrideMaps,
  findWorkspaceManifests,
  floorOf,
  floorTripleOf,
  isAtLeast,
  parseTopLevelOverrides,
  resolvedLockfileVersions,
  resolvedVersionMeetsFloor,
  parseWorkspacePackages,
  rangeMeetsFloor,
} from "./pnpm-overrides-core.mjs";

/**
 * Unit tests for the effective-override guard (#1213).
 *
 * The defect this guard replaces read `manifest.pnpm.overrides` from package.json —
 * the field pnpm 11 stopped obeying — so it reported 4/4 health about a field that had
 * stopped mattering. Everything below is therefore written against the OUTCOME: the
 * lockfile's top-level `overrides:` block, which is pnpm's own record of what it
 * actually applied.
 *
 * The matrix deliberately sweeps three axes, because the repo's last five fail-open
 * gates each escaped a matrix that swept only the first:
 *
 *   content   — a declared value/key changed          (M1-M3)
 *   identity  — the right values in the WRONG SOURCE  (M4-M8)
 *   domain    — inputs never offered to the check     (M9-M12)
 *
 * plus over-blocking restore arms (R1-R4) so the fix cannot earn its own deletion.
 */

const temps = [];
function tempTree() {
  const dir = mkdtempSync(join(tmpdir(), "pnpm-overrides-"));
  temps.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** A lockfile whose top-level `overrides:` block holds exactly `entries`. */
function lockfileWith(entries) {
  const body = Object.entries(entries)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join("\n");
  return `lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n\noverrides:\n${body}\n\nimporters:\n\n  .:\n    dependencies: {}\n`;
}

/** A lockfile with NO overrides block at all — what pnpm 11 writes for an ignored field. */
const LOCKFILE_NO_OVERRIDES = `lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n\nimporters:\n\n  .:\n    dependencies: {}\n`;

function workspaceWith(entries, { comments = false } = {}) {
  const body = Object.entries(entries)
    .map(([k, v]) => (comments ? `  # pin for an advisory\n  ${k}: ${v}` : `  ${k}: ${v}`))
    .join("\n");
  return `packages:\n  - server\n\nminimumReleaseAge: 10080\n\noverrides:\n${body}\n`;
}

const CLEAN_MANIFEST = { path: "package.json", text: JSON.stringify({ name: "metis" }) };
const REAL_ENTRIES = { "ws@<8.21.0": "^8.21.0", "js-yaml@4": "4.3.0" };

/** The committed, healthy state: declared in the yaml, honoured in the lockfile. */
function healthyInput(overrides = { ...REAL_ENTRIES }) {
  return {
    manifests: [CLEAN_MANIFEST],
    workspaceText: workspaceWith(overrides),
    lockfileText: lockfileWith(overrides),
    minimumOverrides: 2,
  };
}

const kinds = (result) => result.problems.map((p) => p.kind).sort();

describe("parseTopLevelOverrides", () => {
  it("reads a flat top-level block, unquoting keys and values", () => {
    const parsed = parseTopLevelOverrides(
      `packages:\n  - server\n\noverrides:\n  '@github/copilot@<1.0.43': ^1.0.43\n  uuid@<14.0.0: '>=14.0.0'\n  protobufjs@>=8.0.0 <8.6.6: ^8.6.6\n`,
    );
    expect(Object.fromEntries(parsed)).toEqual({
      "@github/copilot@<1.0.43": "^1.0.43",
      "uuid@<14.0.0": ">=14.0.0",
      "protobufjs@>=8.0.0 <8.6.6": "^8.6.6",
    });
  });

  it("skips comments and blank lines inside the block", () => {
    const parsed = parseTopLevelOverrides(
      `overrides:\n  # a pin for GHSA-xxxx\n  ws@<8.21.0: ^8.21.0\n\n  js-yaml@4: 4.3.0\n`,
    );
    expect([...parsed.keys()]).toEqual(["ws@<8.21.0", "js-yaml@4"]);
  });

  it("stops at the next top-level key", () => {
    const parsed = parseTopLevelOverrides(
      `overrides:\n  ws@<8.21.0: ^8.21.0\nonlyBuiltDependencies:\n  - sharp\n`,
    );
    expect([...parsed.keys()]).toEqual(["ws@<8.21.0"]);
  });

  // M12 (domain): a lookalike must not be mistaken for the real block. `overrides:`
  // nested under another key is NOT what pnpm reads, so treating it as the top-level
  // block would manufacture a false green out of a file that configures nothing.
  it("M12: ignores an INDENTED `overrides:` — only a top-level block counts", () => {
    expect(
      parseTopLevelOverrides(`somePackage:\n  overrides:\n    ws@<8.21.0: ^8.21.0\n`),
    ).toBeNull();
  });

  // Absent must be distinguishable from empty: `null` means "pnpm applied no override
  // block at all", `new Map()` means "it applied an empty one". Collapsing them to `{}`
  // is the #1168 "default that means nothing to check" shape.
  it("returns null when the block is absent, and an empty Map when it is empty", () => {
    expect(parseTopLevelOverrides(`packages:\n  - server\n`)).toBeNull();
    const empty = parseTopLevelOverrides(`overrides: {}\npackages:\n  - server\n`);
    expect(empty).toEqual(new Map());
  });

  // M9 (domain): a line the parser cannot read must be REPORTED, never skipped.
  // Skipping is how an entry escapes validation while still looking present.
  it("M9: throws on a malformed entry rather than skipping it", () => {
    expect(() => parseTopLevelOverrides(`overrides:\n  this line has no colon\n`)).toThrow(
      OverridesParseError,
    );
    expect(() => parseTopLevelOverrides(`overrides:\n  nested:\n    deeper: 1\n`)).toThrow(
      OverridesParseError,
    );
  });

  it("requires its argument rather than defaulting to an empty document", () => {
    expect(() => parseTopLevelOverrides(undefined)).toThrow(OverridesParseError);
  });
});

describe("findWorkspaceManifests (the domain axis — which files are offered)", () => {
  function tree() {
    const root = tempTree();
    writeFileSync(join(root, "package.json"), '{"name":"root"}');
    writeFileSync(
      join(root, "pnpm-workspace.yaml"),
      "packages:\n  - server\n  - packages/*\n  # a comment\n  - ui # trailing\n",
    );
    for (const d of ["server", "ui", "packages/shared", "packages/ui-kit"]) {
      mkdirSync(join(root, d), { recursive: true });
      writeFileSync(join(root, d, "package.json"), `{"name":"${d}"}`);
    }
    return root;
  }

  it("enumerates the root plus every declared workspace package, expanding `/*`", () => {
    const { manifests, missing } = findWorkspaceManifests(
      tree(),
      readFileSync(join(tree(), "pnpm-workspace.yaml"), "utf8"),
    );
    expect(missing).toEqual([]);
    expect(manifests.map((m) => m.path).sort()).toEqual([
      "package.json",
      "packages/shared/package.json",
      "packages/ui-kit/package.json",
      "server/package.json",
      "ui/package.json",
    ]);
  });

  // The over-blocking objection this replaced a tree-walk to fix: METIS's own ingest
  // writes third-party source, package.json included, into gitignored `server/data/*`.
  // A walk swept those in, so a cloned repo carrying a `pnpm` field turned a local
  // `pnpm test` red for a file that is not this repo's dependency config.
  it("does NOT enumerate ingested manifests under gitignored data directories", () => {
    const root = tree();
    mkdirSync(join(root, "server", "data", "repo-extracts", "acme"), { recursive: true });
    writeFileSync(
      join(root, "server", "data", "repo-extracts", "acme", "package.json"),
      JSON.stringify({ name: "third-party", pnpm: { overrides: { lodash: "1.0.0" } } }),
    );
    const { manifests } = findWorkspaceManifests(
      root,
      readFileSync(join(root, "pnpm-workspace.yaml"), "utf8"),
    );
    expect(manifests.map((m) => m.path)).not.toContain(
      "server/data/repo-extracts/acme/package.json",
    );
    const result = auditOverrides({
      manifests,
      workspaceText: workspaceWith(REAL_ENTRIES),
      lockfileText: lockfileWith(REAL_ENTRIES),
      minimumOverrides: 2,
    });
    expect(result.problems).toEqual([]);
  });

  // A typo in `packages:` must shrink nothing silently.
  it("reports a declared package whose manifest is missing", () => {
    const root = tempTree();
    writeFileSync(join(root, "package.json"), "{}");
    const { manifests, missing } = findWorkspaceManifests(root, "packages:\n  - nope\n");
    expect(manifests.map((m) => m.path)).toEqual(["package.json"]);
    expect(missing).toEqual(["nope/package.json"]);
  });

  it("fails closed on a glob form it does not understand", () => {
    expect(() => findWorkspaceManifests("/x", "packages:\n  - 'apps/**/pkg'\n")).toThrow(
      /unsupported workspace package pattern/,
    );
  });

  it("parseWorkspacePackages reads the list, ignoring comments", () => {
    expect(parseWorkspacePackages("packages:\n  - a\n  # c\n  - b # t\nother: 1\n")).toEqual([
      "a",
      "b",
    ]);
    expect(parseWorkspacePackages("minimumReleaseAge: 1\n")).toBeNull();
  });
});

describe("collectPnpmFieldDeclarations", () => {
  it("reports the keys of a `pnpm` field wherever it appears", () => {
    const found = collectPnpmFieldDeclarations([
      { path: "package.json", text: JSON.stringify({ pnpm: { overrides: {}, foo: 1 } }) },
      { path: "server/package.json", text: JSON.stringify({ name: "s" }) },
    ]);
    expect(found).toEqual([{ path: "package.json", keys: ["overrides", "foo"] }]);
  });

  it("reports an unreadable manifest instead of skipping it", () => {
    const found = collectPnpmFieldDeclarations([{ path: "package.json", text: "{ not json" }]);
    expect(found).toEqual([{ path: "package.json", keys: [], unreadable: true }]);
  });
});

describe("diffOverrideMaps", () => {
  it("reports missing, extra and mismatched keys in both directions", () => {
    const declared = new Map([
      ["a", "1"],
      ["b", "2"],
      ["c", "3"],
    ]);
    const effective = new Map([
      ["a", "1"],
      ["b", "9"],
      ["d", "4"],
    ]);
    expect(diffOverrideMaps(declared, effective)).toEqual({
      missing: ["c"],
      extra: ["d"],
      mismatched: [{ key: "b", declared: "2", effective: "9" }],
    });
  });
});

describe("auditOverrides — the outcome assertion", () => {
  // R1 (over-blocking): the committed, healthy shape must PASS, or the guard is
  // unpassable and earns its own deletion.
  it("R1: passes on declared-and-honoured overrides", () => {
    const result = auditOverrides(healthyInput());
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  // R5/R6: trailing comments are valid YAML that pnpm honours, in a file whose every
  // other section is commented. R6 is the worse of the two — it did not error, it
  // parsed the comment INTO the value and produced a bogus mismatch.
  it("R5: a trailing comment on the `overrides:` line is not an inline value", () => {
    const result = auditOverrides({
      ...healthyInput(),
      workspaceText: `overrides: # security pins\n  ws@<8.21.0: ^8.21.0\n  js-yaml@4: 4.3.0\n`,
    });
    expect(result.problems).toEqual([]);
  });

  it("R6: a trailing comment on an entry line is not part of the value", () => {
    const result = auditOverrides({
      ...healthyInput(),
      workspaceText: `overrides:\n  ws@<8.21.0: ^8.21.0 # GHSA-xxxx\n  js-yaml@4: 4.3.0   # CVE-y\n`,
    });
    expect(result.problems).toEqual([]);
  });

  // R4: the real file has comments and blank lines interleaved in the block.
  it("R4: passes when the yaml block carries comments", () => {
    const result = auditOverrides({
      ...healthyInput(),
      workspaceText: workspaceWith(REAL_ENTRIES, { comments: true }),
    });
    expect(result.ok).toBe(true);
  });

  // R2: #1211's planned trajectory must not be blocked by this guard.
  it("R2: passes on #1211's planned brace-expansion backport values", () => {
    const planned = { "brace-expansion@1": "^1.1.17", "brace-expansion@2": "^2.1.3" };
    expect(auditOverrides(healthyInput(planned)).ok).toBe(true);
  });

  // R3: quoting is a YAML detail, not a semantic difference. Over-blocking here would
  // fail the real repo, whose lockfile and workspace file quote differently.
  it("R3: a quoted declaration equals an unquoted effective value", () => {
    const result = auditOverrides({
      manifests: [CLEAN_MANIFEST],
      workspaceText: `overrides:\n  'uuid@<14.0.0': '>=14.0.0'\n  ws@<8.21.0: "^8.21.0"\n`,
      lockfileText: `overrides:\n  uuid@<14.0.0: '>=14.0.0'\n  'ws@<8.21.0': ^8.21.0\n`,
      minimumOverrides: 2,
    });
    expect(result.problems).toEqual([]);
  });

  it("M1 (content): a declared value the lockfile did not apply is mismatched", () => {
    const result = auditOverrides({
      ...healthyInput(),
      workspaceText: workspaceWith({ ...REAL_ENTRIES, "js-yaml@4": "4.4.0" }),
    });
    expect(kinds(result)).toEqual(["override-mismatched"]);
    expect(result.ok).toBe(false);
  });

  it("M2 (content): a declared override absent from the lockfile is missing", () => {
    const result = auditOverrides({
      ...healthyInput(),
      workspaceText: workspaceWith({ ...REAL_ENTRIES, "axios@<1.18.0": "^1.18.0" }),
    });
    expect(kinds(result)).toEqual(["override-missing"]);
  });

  it("M3 (content): a lockfile override nobody declared is extra", () => {
    const result = auditOverrides({
      ...healthyInput(),
      lockfileText: lockfileWith({ ...REAL_ENTRIES, "tmp@<0.2.6": "^0.2.6" }),
    });
    expect(kinds(result)).toEqual(["override-extra"]);
  });

  // ---- M4 IS THE WHOLE POINT OF #1213 -------------------------------------------
  // DECLARED BUT NOT HONOURED. This is the literal pnpm 11 state, reproduced from
  // real pnpm 11.18.0 output: overrides sit in package.json's `pnpm` field, pnpm
  // ignores them with a WARNING and exit 0, and the lockfile loses its `overrides:`
  // block entirely. The guard this replaces read the manifest field and stayed green.
  it("M4 (identity): FAILS when overrides are declared in package.json and not honoured", () => {
    const result = auditOverrides({
      manifests: [
        { path: "package.json", text: JSON.stringify({ pnpm: { overrides: REAL_ENTRIES } }) },
      ],
      workspaceText: `packages:\n  - server\n`,
      lockfileText: LOCKFILE_NO_OVERRIDES,
      minimumOverrides: 2,
    });
    expect(kinds(result)).toEqual(["overrides-not-applied", "pnpm-field-present"]);
    expect(result.ok).toBe(false);
  });

  it("M5 (identity): FAILS when the yaml declares overrides the lockfile never applied", () => {
    const result = auditOverrides({ ...healthyInput(), lockfileText: LOCKFILE_NO_OVERRIDES });
    expect(kinds(result)).toEqual(["overrides-not-applied"]);
  });

  // M6 is the pure identity mutation: every VALUE is correct and the tree is fine
  // today. Only the SOURCE is booby-trapped. A content-only matrix cannot see this.
  it("M6 (identity): FAILS on a reintroduced `pnpm` field even when the tree is correct", () => {
    const result = auditOverrides({
      ...healthyInput(),
      manifests: [
        { path: "package.json", text: JSON.stringify({ pnpm: { overrides: REAL_ENTRIES } }) },
      ],
    });
    expect(kinds(result)).toEqual(["pnpm-field-present"]);
    expect(result.problems[0].message).toMatch(/no longer read/i);
  });

  it("M7 (identity): FAILS on a `pnpm` field in a CHILD workspace manifest", () => {
    const result = auditOverrides({
      ...healthyInput(),
      manifests: [
        CLEAN_MANIFEST,
        { path: "server/package.json", text: JSON.stringify({ pnpm: { overrides: {} } }) },
      ],
    });
    expect(kinds(result)).toEqual(["pnpm-field-present"]);
    expect(result.problems[0].path).toBe("server/package.json");
  });

  // M8 (domain): the vacuous pass. Zero overrides everywhere is internally consistent
  // and would satisfy every diff above — the #1168 "nothing to check" shape.
  it("M8: FAILS when the override set collapses below the expected floor", () => {
    const result = auditOverrides({
      manifests: [CLEAN_MANIFEST],
      workspaceText: `overrides: {}\n`,
      lockfileText: `overrides: {}\n`,
      minimumOverrides: 2,
    });
    expect(kinds(result)).toEqual(["too-few-overrides"]);
  });

  // M8b: the shape pnpm ACTUALLY writes for "no overrides" is an ABSENT block, not
  // `overrides: {}`. That took an early return which never consulted the floor, so a
  // TOTAL collapse in both files returned ok=true — the "nothing to check" fail-open,
  // reappearing inside the fix for one. Found by the test-falsifiability lens.
  it("M8b: FAILS on a total collapse where the block is ABSENT, not empty", () => {
    const result = auditOverrides({
      manifests: [CLEAN_MANIFEST],
      workspaceText: `packages:\n  - server\n`,
      lockfileText: LOCKFILE_NO_OVERRIDES,
      minimumOverrides: 2,
    });
    expect(kinds(result)).toEqual(["too-few-overrides"]);
    expect(result.ok).toBe(false);
  });

  // ...but a floor of 0 is an explicit opt-out and must stay passable, or a repo with
  // genuinely no overrides could never satisfy the guard.
  it("M8c: a floor of 0 still passes on a total collapse", () => {
    const result = auditOverrides({
      manifests: [CLEAN_MANIFEST],
      workspaceText: `packages:\n  - server\n`,
      lockfileText: LOCKFILE_NO_OVERRIDES,
      minimumOverrides: 0,
    });
    expect(result.ok).toBe(true);
  });

  it("M11: reports an unreadable manifest rather than passing over it", () => {
    const result = auditOverrides({
      ...healthyInput(),
      manifests: [{ path: "package.json", text: "{" }],
    });
    expect(kinds(result)).toEqual(["unreadable-manifest"]);
  });

  it("surfaces a malformed overrides block as a problem, not a throw", () => {
    const result = auditOverrides({ ...healthyInput(), lockfileText: `overrides:\n  junk line\n` });
    expect(kinds(result)).toEqual(["malformed-overrides"]);
  });

  // `minimumOverrides` is REQUIRED. Defaulting it to 0 would read as "nothing to
  // check", which is exactly how #1168 shipped.
  it("requires minimumOverrides instead of defaulting it to zero", () => {
    for (const bad of [undefined, NaN, "20", null]) {
      expect(() => auditOverrides({ ...healthyInput(), minimumOverrides: bad })).toThrow(
        /minimumOverrides/,
      );
    }
  });
});

/**
 * The version-range helpers used to live inside the brace-expansion test file, where
 * the coverage scope (`lib/ ** / *.mjs`) never measured them. #1208's surviving mutant
 * (M5) was in exactly this code: `ceilingMajorOf` must report the range's CEILING, and
 * the obvious regex reads its FLOOR, so `">=1.1.17"` passed a "stays in major 1" guard
 * while installing 5.0.9. Moving them into the module puts them under measurement;
 * these arms are what make that measurement mean something.
 */
describe("version-range helpers", () => {
  it("floorOf reads the first semver in a range, and rejects a range without one", () => {
    expect(floorOf("^5.0.8")).toEqual([5, 0, 8]);
    expect(floorOf(">=1.1.17 <2.0.0")).toEqual([1, 1, 17]);
    expect(() => floorOf("latest")).toThrow(OverridesParseError);
  });

  it.each([
    // [range, ceiling major, why]
    ["1.1.16", 1, "an exact pin caps itself"],
    ["^1.1.17", 1, "caret stays inside the major"],
    ["~2.1.3", 2, "tilde stays inside the minor, so inside the major"],
    [">=1.1.17 <2.0.0", 1, "an explicit `<2.0.0` bounds it — this form is SAFE"],
    [">=1.1.17 <=1.9.9", 1, "a `<=` term inside the major bounds it too"],
    [">=1.1.17", UNBOUNDED, "M5: an in-major FLOOR with no ceiling installs 5.0.9"],
    [">1.1.17", UNBOUNDED, "a bare `>` is a lower bound only"],
    ["*", UNBOUNDED, "wildcards are unbounded"],
    ["x", UNBOUNDED, "wildcards are unbounded"],
    ["latest", UNBOUNDED, "a dist-tag is unbounded"],
    ["", UNBOUNDED, "an empty range is unbounded"],
    ["1.x", UNBOUNDED, "unparsable forms fail CLOSED rather than slipping past"],
    ["1.0.0 - 2.0.0", UNBOUNDED, "a hyphen range is unparsable here, so it fails CLOSED"],
    ["^1.1.17 || ^5.0.8", 5, "a disjunction is as loose as its loosest arm"],
  ])("ceilingMajorOf(%j) === %s — %s", (range, expected) => {
    expect(ceilingMajorOf(range)).toBe(expected);
  });

  it("isAtLeast compares major, then minor, then patch", () => {
    expect(isAtLeast("^5.0.8", [5, 0, 8])).toBe(true);
    expect(isAtLeast("^5.0.9", [5, 0, 8])).toBe(true);
    expect(isAtLeast("^5.0.7", [5, 0, 8])).toBe(false);
    expect(isAtLeast("^6.0.0", [5, 0, 8])).toBe(true);
    expect(isAtLeast("^4.9.9", [5, 0, 8])).toBe(false);
    expect(isAtLeast("^5.1.0", [5, 0, 8])).toBe(true);
    expect(isAtLeast("^5.0.0", [5, 1, 0])).toBe(false);
  });
});

/**
 * The engine floor (#1213 follow-up).
 *
 * `floorTripleOf` is the DUAL of `ceilingMajorOf` above and the two are easy to grab the
 * wrong way round — #1208's surviving mutant was exactly that confusion. The arms below
 * are therefore written as the mirror image of the ceiling table: the failure mode here is
 * a range reading as a HIGHER floor than it enforces, which would certify an
 * `engines.pnpm` that still admits a pnpm unable to see the overrides at all.
 */
describe("floorTripleOf — the range floor that gates engines.pnpm", () => {
  it.each([
    // [range, floor, why]
    [">=10.5.1", [10, 5, 1], "the form this repo uses"],
    ["10.5.1", [10, 5, 1], "an exact pin floors at itself"],
    ["^10.5.1", [10, 5, 1], "caret floors at its base"],
    ["~10.5.1", [10, 5, 1], "tilde floors at its base"],
    [">=10.5.1 <12.0.0", [10, 5, 1], "an upper bound does not move the floor"],
    [">10.5.1", [10, 5, 1], "a bare `>` still contributes its lower bound"],
    [">=9.0.0", [9, 0, 0], "the pre-#1213 value, which admits the ignoring band"],
    ["<12.0.0", [0, 0, 0], "an upper bound ALONE imposes no floor"],
    ["*", [0, 0, 0], "a wildcard imposes no floor"],
    ["latest", [0, 0, 0], "a dist-tag imposes no floor"],
    ["", [0, 0, 0], "an empty range imposes no floor"],
    ["10.x", [0, 0, 0], "an unparsable form fails CLOSED — no floor, not a guessed one"],
    [null, [0, 0, 0], "a missing engines.pnpm imposes no floor rather than throwing"],
    [undefined, [0, 0, 0], "likewise an absent field"],
    // The panel's finding, and the one arm whose absence let it through. A hyphen range
    // splits on whitespace into `9.0.0`, `-`, `12.0.0`; skipping the unreadable `-` let
    // the range's CEILING win the maximum and report a floor of 12.0.0 for a range that
    // admits pnpm 9. Any unreadable term must collapse the whole range, not be dropped.
    ["9.0.0 - 12.0.0", [0, 0, 0], "a hyphen range fails CLOSED — its UPPER bound is not a floor"],
    ["1.0.0 - 2.0.0", [0, 0, 0], "likewise, matching ceilingMajorOf's treatment of the form"],
    [">=10.5.1 - 12.0.0", [0, 0, 0], "an operator on the low side does not rescue it either"],
    [">=10.16.0-beta.1", [0, 0, 0], "a prerelease sorts BELOW the release, so it fails CLOSED"],
    // Shorthands are understood rather than rejected: `>=11` is strictly safer than the
    // floor, and refusing it would fail the guard with a message saying the opposite.
    [">=11", [11, 0, 0], "a major-only lower bound is honoured"],
    ["^11", [11, 0, 0], "caret on a bare major"],
    [">=10.6", [10, 6, 0], "a major.minor lower bound"],
    [">=9.0.0 >=10.5.1", [10, 5, 1], "conjunction takes the HIGHEST lower bound"],
    // The mirror of the ceiling table's disjunction arm, and the one that matters most:
    // a floor must take the LOWEST arm where a ceiling takes the highest. BOTH orders are
    // listed on purpose — with only one, a reduce that simply kept its accumulator (or
    // simply took each arm) would pass, and the "lowest" rule would be untested.
    [">=10.5.1 || >=9.0.0", [9, 0, 0], "a disjunction is as loose as its LOWEST arm"],
    [">=9.0.0 || >=10.5.1", [9, 0, 0], "and the same when the low arm comes FIRST"],
    ["10.5.1 || 9.0.0", [9, 0, 0], "order does not rescue it — pnpm 9 is still permitted"],
  ])("floorTripleOf(%j) === %j — %s", (range, expected) => {
    expect(floorTripleOf(range)).toEqual(expected);
  });

  it("rangeMeetsFloor accepts only ranges that refuse everything below the floor", () => {
    expect(rangeMeetsFloor(">=10.16.0", ENGINES_PNPM_FLOOR)).toBe(true);
    expect(rangeMeetsFloor(">=10.33.0", ENGINES_PNPM_FLOOR)).toBe(true);
    expect(rangeMeetsFloor(">=11.0.0", ENGINES_PNPM_FLOOR)).toBe(true);
    expect(rangeMeetsFloor(">=11", ENGINES_PNPM_FLOOR)).toBe(true);
    // One patch below each boundary that matters.
    expect(rangeMeetsFloor(">=10.15.9", ENGINES_PNPM_FLOOR)).toBe(false);
    expect(rangeMeetsFloor(">=10.5.1", ENGINES_PNPM_FLOOR)).toBe(false);
    expect(rangeMeetsFloor(">=10.5.0", WORKSPACE_OVERRIDES_FLOOR)).toBe(false);
    expect(rangeMeetsFloor(">=9.0.0", ENGINES_PNPM_FLOOR)).toBe(false);
    expect(rangeMeetsFloor("*", ENGINES_PNPM_FLOOR)).toBe(false);
    expect(rangeMeetsFloor(">=10.16.0 || >=9.0.0", ENGINES_PNPM_FLOOR)).toBe(false);
    // The panel's finding, asserted at the level the repo guard actually calls.
    expect(rangeMeetsFloor("9.0.0 - 12.0.0", ENGINES_PNPM_FLOOR)).toBe(false);
  });

  it("keeps both floor constants at the versions actually measured", () => {
    // Bare identity assertions, so that MOVING either floor is a deliberate edit with a
    // measurement behind it rather than a quiet consequence of touching a range helper.
    // They are separate constants because they answer different questions: 10.5.1 is when
    // `overrides:` began working, 10.16.0 is when the LAST security-relevant key in
    // pnpm-workspace.yaml began working. Only the second may gate engines.pnpm.
    expect(WORKSPACE_OVERRIDES_FLOOR).toEqual([10, 5, 1]);
    expect(ENGINES_PNPM_FLOOR).toEqual([10, 16, 0]);
    expect(
      compareTripleForTest(ENGINES_PNPM_FLOOR, WORKSPACE_OVERRIDES_FLOOR),
      "the engines floor must never drop below the overrides floor",
    ).toBeGreaterThanOrEqual(0);
  });
});

/** Local triple comparison, so the assertion above does not depend on a non-exported helper. */
function compareTripleForTest(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

describe("parser edge cases", () => {
  it("rejects an inline overrides value that is not an empty mapping", () => {
    expect(() => parseTopLevelOverrides(`overrides: {ws: 1}\n`)).toThrow(
      /unsupported inline overrides value/,
    );
  });

  it("rejects an entry whose quoted key is unterminated or has no colon", () => {
    expect(() => parseTopLevelOverrides(`overrides:\n  'unterminated\n`)).toThrow(
      OverridesParseError,
    );
    expect(() => parseTopLevelOverrides(`overrides:\n  'quoted' no-colon\n`)).toThrow(
      OverridesParseError,
    );
  });

  it("handles a doubled quote inside a single-quoted key", () => {
    const parsed = parseTopLevelOverrides(`overrides:\n  'it''s@1': 1.0.0\n`);
    expect(parsed.get("it's@1")).toBe("1.0.0");
  });

  it("keeps a `#` that is not preceded by whitespace inside the value", () => {
    const parsed = parseTopLevelOverrides(`overrides:\n  pkg@1: 1.0.0#build\n`);
    expect(parsed.get("pkg@1")).toBe("1.0.0#build");
  });

  it("keeps a comment character inside a quoted value", () => {
    const parsed = parseTopLevelOverrides(`overrides:\n  pkg@1: '>=1.0.0' # note\n`);
    expect(parsed.get("pkg@1")).toBe(">=1.0.0");
  });

  it("unescapes a double-quoted scalar", () => {
    const parsed = parseTopLevelOverrides(`overrides:\n  "pkg@1": "^1.0.0"\n`);
    expect(parsed.get("pkg@1")).toBe("^1.0.0");
  });

  it("collectPnpmFieldDeclarations ignores a null or absent pnpm field", () => {
    expect(
      collectPnpmFieldDeclarations([
        { path: "a/package.json", text: JSON.stringify({ pnpm: null }) },
        { path: "b/package.json", text: JSON.stringify({ pnpm: "not-an-object" }) },
        { path: "c/package.json", text: "null" },
      ]),
    ).toEqual([]);
  });

  it("collectPnpmFieldDeclarations requires an array", () => {
    expect(() => collectPnpmFieldDeclarations(undefined)).toThrow(TypeError);
  });

  it("findWorkspaceManifests accepts an injected fs seam", () => {
    const { manifests } = findWorkspaceManifests("/root", "packages:\n  - pkgs/*\n", {
      readdirSync: () => [{ name: "a", isDirectory: () => true }],
      readFileSync: () => '{"name":"x"}',
    });
    expect(manifests.map((m) => m.path)).toEqual(["package.json", "pkgs/a/package.json"]);
  });
});

describe("resolvedLockfileVersions", () => {
  // The exact shape pnpm writes: bare keys, quoted keys, peer-suffixed snapshot keys and
  // selector lines, all at the two-space indent that `packages:` entries use.
  const LOCKFILE = [
    "packages:",
    "  @xmldom/xmldom@0.8.15:",
    "  '@xmldom/xmldom@0.9.12':",
    "  sharp@0.35.4:",
    "  sharp@0.35.4(@types/node@25.6.0):",
    "  next@<16.3.3: ^16.3.3",
    "  js-yaml@4.3.2:",
  ].join("\n");

  it("reads every resolved copy, bare or quoted", () => {
    expect(resolvedLockfileVersions(LOCKFILE, "@xmldom/xmldom").sort()).toEqual([
      "0.8.15",
      "0.9.12",
    ]);
  });

  it("excludes peer-suffixed snapshot keys — the bare counterpart is always present", () => {
    expect(resolvedLockfileVersions(LOCKFILE, "sharp")).toEqual(["0.35.4"]);
  });

  it("excludes selector lines, which restate an override rather than resolve one", () => {
    expect(resolvedLockfileVersions(LOCKFILE, "next")).toEqual([]);
  });

  it("does not confuse a package with one whose name it prefixes", () => {
    expect(resolvedLockfileVersions("  js-yaml-loader@1.0.0:", "js-yaml")).toEqual([]);
  });

  // THE #1363 REGRESSION ARM. The predecessor matched `/^(\d+\.\d+\.\d+)'?:$/` and
  // dropped anything else on the floor. This is the mutation that proved it: a prerelease
  // inside the affected band vanished from the guard's view, so all 23 arms of the
  // advisory suite stayed GREEN with a vulnerable copy resolved in the tree.
  it("reads a PRERELEASE key — dropping it silently is what made the old guard fail open", () => {
    const withPrerelease = `${LOCKFILE}\n  '@xmldom/xmldom@0.9.11-rc.1':`;
    expect(resolvedLockfileVersions(withPrerelease, "@xmldom/xmldom")).toContain("0.9.11-rc.1");
  });

  it("reads a four-segment key rather than skipping it", () => {
    expect(resolvedLockfileVersions("  odd@1.2.3.4:", "odd")).toEqual(["1.2.3.4"]);
  });

  it("returns [] for a non-string lockfile instead of throwing", () => {
    expect(resolvedLockfileVersions(undefined, "sharp")).toEqual([]);
  });
});

describe("resolvedVersionMeetsFloor", () => {
  it("compares an exact triple", () => {
    expect(resolvedVersionMeetsFloor("0.9.12", [0, 9, 12])).toBe(true);
    expect(resolvedVersionMeetsFloor("0.9.13", [0, 9, 12])).toBe(true);
    expect(resolvedVersionMeetsFloor("0.9.11", [0, 9, 12])).toBe(false);
  });

  // Semver: a prerelease sorts BELOW the release it precedes. Reading `0.9.12-rc.1` as
  // "meets 0.9.12" would wave through exactly the build the #1363 guard exists to catch.
  it("treats a prerelease as BELOW the release of the same triple", () => {
    expect(resolvedVersionMeetsFloor("0.9.12-rc.1", [0, 9, 12])).toBe(false);
    expect(resolvedVersionMeetsFloor("0.9.11-rc.1", [0, 9, 12])).toBe(false);
  });

  it("treats a build suffix and a fourth segment as at-or-above the triple", () => {
    expect(resolvedVersionMeetsFloor("0.9.12+build.5", [0, 9, 12])).toBe(true);
    expect(resolvedVersionMeetsFloor("1.2.3.4", [1, 2, 3])).toBe(true);
  });

  // Fail CLOSED. `isAtLeast`/`floorOf` would read an unparseable input as a floor of
  // 0.0.0 and quietly answer; an advisory guard must refuse instead.
  it("THROWS on anything that is not an exact resolved version", () => {
    expect(() => resolvedVersionMeetsFloor("^16.3.3", [16, 3, 3])).toThrow(
      /not an exact resolved version/,
    );
    expect(() => resolvedVersionMeetsFloor("", [1, 0, 0])).toThrow();
    expect(() => resolvedVersionMeetsFloor(undefined, [1, 0, 0])).toThrow();
  });
});
