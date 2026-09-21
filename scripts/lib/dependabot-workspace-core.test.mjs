import { describe, expect, it } from "vitest";

import {
  auditDependabotWorkspaceScope,
  DependabotConfigParseError,
  normalizeDirectory,
  parseDependabotUpdates,
} from "./dependabot-workspace-core.mjs";

/**
 * Unit matrix for the Dependabot pnpm-workspace guard (#1283).
 *
 * `dependabot-workspace-repo.test.mjs` points this audit at the real tree. This file
 * proves the audit can actually go RED — every problem kind gets an arm that produces
 * it and a restore arm that clears it, because a gate whose only evidence is "it passes
 * on main" is indistinguishable from a gate that cannot fail (#1168/#1178/#1180/#1192).
 */

const ROOT_ONLY = `version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "monthly"
    cooldown:
      default-days: 7
    groups:
      root-minor-patch:
        patterns: ["*"]
        update-types: ["minor", "patch"]
`;

const ROOT_PLUS_UI = `version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "monthly"
    cooldown:
      default-days: 7

  # UI (Next.js) workspace
  - package-ecosystem: "npm"
    directory: "/ui"
    schedule:
      interval: "monthly"
    cooldown:
      default-days: 7
`;

const LOCK_AT_ROOT = new Set([""]);

describe("normalizeDirectory", () => {
  it("maps the repository root to the empty string", () => {
    expect(normalizeDirectory("/")).toBe("");
  });

  it("strips the leading slash and any trailing slash", () => {
    expect(normalizeDirectory("/ui")).toBe("ui");
    expect(normalizeDirectory("/ui/")).toBe("ui");
    expect(normalizeDirectory("/packages/shared")).toBe("packages/shared");
  });

  it("rejects a relative path, because Dependabot resolves from the repo root", () => {
    expect(() => normalizeDirectory("ui")).toThrow(DependabotConfigParseError);
  });

  it("rejects a glob rather than silently shrinking the checked domain", () => {
    expect(() => normalizeDirectory("/packages/*")).toThrow(/glob/i);
  });

  it("rejects a non-string", () => {
    expect(() => normalizeDirectory(null)).toThrow(DependabotConfigParseError);
  });
});

describe("parseDependabotUpdates", () => {
  it("reads ecosystem, directory, cooldown and group names", () => {
    const [entry] = parseDependabotUpdates(ROOT_ONLY);
    expect(entry.ecosystem).toBe("npm");
    expect(entry.directories).toEqual([""]);
    expect(entry.cooldownDays).toBe(7);
    expect(entry.groups).toEqual(["root-minor-patch"]);
  });

  it("reads every entry in order", () => {
    const entries = parseDependabotUpdates(ROOT_PLUS_UI);
    expect(entries.map((e) => e.directories[0])).toEqual(["", "ui"]);
  });

  it("ignores comments, including one indented inside the updates block", () => {
    const entries = parseDependabotUpdates(ROOT_PLUS_UI);
    expect(entries).toHaveLength(2);
  });

  it("does not treat a `#` inside a quoted scalar as a comment", () => {
    const [entry] = parseDependabotUpdates(`updates:
  - package-ecosystem: "npm"
    directory: "/"
    target-branch: "release#1"
    cooldown:
      default-days: 7
`);
    expect(entry.raw["target-branch"]).toBe("release#1");
  });

  it("reads an inline flow list of directories", () => {
    const [entry] = parseDependabotUpdates(`updates:
  - package-ecosystem: "npm"
    directories: ["/", "/other"]
    cooldown:
      default-days: 7
`);
    expect(entry.directories).toEqual(["", "other"]);
  });

  it("reads a block list of directories", () => {
    const [entry] = parseDependabotUpdates(`updates:
  - package-ecosystem: "npm"
    directories:
      - "/"
      - "/other"
    cooldown:
      default-days: 7
`);
    expect(entry.directories).toEqual(["", "other"]);
  });

  it("reports a missing cooldown as null rather than inventing a default", () => {
    const [entry] = parseDependabotUpdates(`updates:
  - package-ecosystem: "npm"
    directory: "/"
`);
    expect(entry.cooldownDays).toBeNull();
  });

  it("reports a cooldown block with no default-days as null", () => {
    const [entry] = parseDependabotUpdates(`updates:
  - package-ecosystem: "npm"
    directory: "/"
    cooldown:
      include: ["react"]
`);
    expect(entry.cooldownDays).toBeNull();
  });

  it("reports no groups as an empty list", () => {
    const [entry] = parseDependabotUpdates(`updates:
  - package-ecosystem: "npm"
    directory: "/"
    cooldown:
      default-days: 7
`);
    expect(entry.groups).toEqual([]);
  });

  // --- fail-closed arms: anything unrecognised throws rather than parsing to nothing ---

  it("throws when there is no top-level updates block", () => {
    expect(() => parseDependabotUpdates("version: 2\n")).toThrow(/updates/);
  });

  it("throws when the updates block is empty", () => {
    expect(() => parseDependabotUpdates("updates:\nversion: 2\n")).toThrow(/empty/);
  });

  it("throws when content appears before the first list item", () => {
    expect(() =>
      parseDependabotUpdates(`updates:
    package-ecosystem: "npm"
`),
    ).toThrow(/before the first/);
  });

  it("throws when an entry has no package-ecosystem", () => {
    expect(() =>
      parseDependabotUpdates(`updates:
  - directory: "/"
`),
    ).toThrow(/package-ecosystem/);
  });

  it("throws when an entry declares neither directory nor directories", () => {
    expect(() =>
      parseDependabotUpdates(`updates:
  - package-ecosystem: "npm"
    schedule:
      interval: "monthly"
`),
    ).toThrow(/directory/);
  });

  it("throws when an entry declares both directory and directories", () => {
    expect(() =>
      parseDependabotUpdates(`updates:
  - package-ecosystem: "npm"
    directory: "/"
    directories: ["/ui"]
`),
    ).toThrow(/both/);
  });

  it("throws when default-days is not a whole number", () => {
    expect(() =>
      parseDependabotUpdates(`updates:
  - package-ecosystem: "npm"
    directory: "/"
    cooldown:
      default-days: "seven"
`),
    ).toThrow(/default-days/);
  });

  it("throws on a line that is not `key: value`", () => {
    expect(() =>
      parseDependabotUpdates(`updates:
  - package-ecosystem: "npm"
    directory "/"
`),
    ).toThrow(/key: value/);
  });

  it("throws on a non-string input", () => {
    expect(() => parseDependabotUpdates(42)).toThrow(DependabotConfigParseError);
  });
});

describe("auditDependabotWorkspaceScope", () => {
  const audit = (dependabotText, overrides = {}) =>
    auditDependabotWorkspaceScope({
      dependabotText,
      lockfileDirs: LOCK_AT_ROOT,
      workspacePackages: ["ui", "server", "packages/*"],
      ...overrides,
    });

  it("passes a root-only npm entry against a single root lockfile", () => {
    expect(audit(ROOT_ONLY).problems).toEqual([]);
  });

  // THE DEFECT. This is the config as it stood before #1283.
  it("flags an npm entry in a subdirectory the root lockfile already covers", () => {
    const { problems } = audit(ROOT_PLUS_UI);
    expect(problems.map((p) => p.kind)).toEqual(["orphan-npm-directory"]);
    expect(problems[0].directory).toBe("ui");
    expect(problems[0].coveredBy).toBe("");
    expect(problems[0].workspaceMember).toBe(true);
    expect(problems[0].message).toMatch(/ERR_PNPM_OUTDATED_LOCKFILE/);
  });

  // The restore arm: deleting the /ui entry is what clears it.
  it("clears once the subdirectory entry is removed", () => {
    expect(audit(ROOT_ONLY).problems).toEqual([]);
  });

  it("does not flag a subdirectory that owns its own lockfile", () => {
    expect(audit(ROOT_PLUS_UI, { lockfileDirs: new Set(["", "ui"]) }).problems).toEqual([]);
  });

  it("names the nearest ancestor holding the lockfile, not the root by assumption", () => {
    const nested = ROOT_PLUS_UI.replace('"/ui"', '"/ui/nested"');
    const { problems } = audit(nested, {
      lockfileDirs: new Set(["", "ui"]),
      workspacePackages: ["ui", "ui/*"],
    });
    expect(problems).toHaveLength(1);
    expect(problems[0].coveredBy).toBe("ui");
  });

  // Membership is the whole test. `images/mcp-wrappers/code-graph-runner-sse` is a real
  // example: tracked, its own pinned deps, its own `npm ci` in its own Dockerfile, and NOT
  // in pnpm-workspace.yaml's `packages:`. The root lockfile does not pin it, so there is no
  // staleness to cause — flagging it would refuse legitimate config, and the remedy text
  // ("the root entry already relocks it") would be a false statement.
  it("does not flag a subdirectory that is not a pnpm workspace member", () => {
    const other = ROOT_PLUS_UI.replace('"/ui"', '"/images/mcp-wrappers/code-graph-runner-sse"');
    expect(audit(other).problems).toEqual([]);
  });

  it("still flags the same directory once it becomes a workspace member", () => {
    const other = ROOT_PLUS_UI.replace('"/ui"', '"/images/mcp-wrappers/code-graph-runner-sse"');
    const { problems } = audit(other, {
      workspacePackages: ["ui", "images/mcp-wrappers/*"],
    });
    expect(problems.map((p) => p.kind)).toEqual(["orphan-npm-directory"]);
    expect(problems[0].workspaceMember).toBe(true);
  });

  // Fail closed: without the workspace list every directory reads as a standalone
  // subproject and the check above skips silently.
  it("refuses to judge a subdirectory entry with no workspace list", () => {
    expect(() => audit(ROOT_PLUS_UI, { workspacePackages: [] })).toThrow(
      /workspacePackages is empty/,
    );
  });

  it("does not require a workspace list when no npm entry targets a subdirectory", () => {
    expect(audit(ROOT_ONLY, { workspacePackages: [] }).problems).toEqual([]);
  });

  it("flags an npm entry with no lockfile at or above it", () => {
    const { problems } = audit(ROOT_PLUS_UI, { lockfileDirs: new Set(["server"]) });
    expect(problems.map((p) => p.kind).sort()).toEqual([
      "no-covering-npm-entry",
      "npm-directory-has-no-lockfile",
      "npm-directory-has-no-lockfile",
    ]);
  });

  it("does not treat a nested `- ` sequence item as a new update entry", () => {
    const { entries } = audit(`updates:
  - package-ecosystem: "npm"
    directories:
      - "/"
    cooldown:
      default-days: 7
`);
    expect(entries).toHaveLength(1);
    expect(entries[0].ecosystem).toBe("npm");
  });

  // Fail-closed: "no npm entries at all" is internally consistent and would otherwise
  // satisfy every other assertion here — the #1168 shape where the default means
  // "nothing to check".
  it("flags a config that has dropped the npm ecosystem entirely", () => {
    const { problems } = audit(`updates:
  - package-ecosystem: "github-actions"
    directory: "/"
    cooldown:
      default-days: 7
`);
    expect(problems.map((p) => p.kind)).toContain("no-npm-ecosystem");
  });

  it("flags an npm ecosystem that covers no lockfile directory at all", () => {
    const { problems } = audit(`updates:
  - package-ecosystem: "npm"
    directory: "/ui"
    cooldown:
      default-days: 7
`);
    expect(problems.map((p) => p.kind)).toContain("no-covering-npm-entry");
  });

  // --- the #586 cooldown floor, which #1283 must not weaken while restructuring ---

  it("flags a cooldown below the floor", () => {
    const weakened = ROOT_ONLY.replace("default-days: 7", "default-days: 3");
    const { problems } = audit(weakened);
    expect(problems.map((p) => p.kind)).toEqual(["cooldown-below-floor"]);
    expect(problems[0].cooldownDays).toBe(3);
  });

  it("flags a cooldown that has been deleted outright", () => {
    const stripped = ROOT_ONLY.replace("    cooldown:\n      default-days: 7\n", "");
    expect(audit(stripped).problems.map((p) => p.kind)).toEqual(["cooldown-missing"]);
  });

  it("accepts a cooldown above the floor", () => {
    const longer = ROOT_ONLY.replace("default-days: 7", "default-days: 14");
    expect(audit(longer).problems).toEqual([]);
  });

  it("applies the cooldown floor to every ecosystem, not just npm", () => {
    const { problems } = audit(`updates:
  - package-ecosystem: "npm"
    directory: "/"
    cooldown:
      default-days: 7
  - package-ecosystem: "github-actions"
    directory: "/"
    cooldown:
      default-days: 1
`);
    expect(problems.map((p) => p.kind)).toEqual(["cooldown-below-floor"]);
    expect(problems[0].ecosystem).toBe("github-actions");
  });

  it("honours an explicit floor", () => {
    expect(audit(ROOT_ONLY, { cooldownFloorDays: 10 }).problems.map((p) => p.kind)).toEqual([
      "cooldown-below-floor",
    ]);
  });

  it("rejects a lockfileDirs argument that is not a set of strings", () => {
    expect(() => audit(ROOT_ONLY, { lockfileDirs: "/" })).toThrow(TypeError);
  });

  it("returns the parsed entries alongside the problems", () => {
    const result = audit(ROOT_PLUS_UI);
    expect(result.entries).toHaveLength(2);
    expect(result.npmEntries).toHaveLength(2);
  });
});
