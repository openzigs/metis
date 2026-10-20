import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * GHSA-vfj7-8cjw-p6xm, braces@3.0.3, CVSS 8.7 (#767): the claim behind its waiver.
 *
 * The advisory (published 2026-09-18) is a stack-exhaustion DoS through deeply nested
 * brace patterns. OSV records `introduced 0, last_affected 3.0.3`, and 3.0.3 is the
 * latest braces on npm. No release fixes it. An override has nothing to point at, so the
 * remedies are the dated `WAIVERS` entry in `.github/workflows/sast.yml` or removing the
 * consumer. #777 found ui's `eslint-config-next` is loaded by no ESLint config, so dropping
 * it would delete braces outright; that is tracked as a follow-up, not done here. Checked
 * 2026-10-02 against api.osv.dev and registry.npmjs.org, and again 2026-10-20 (#777), when
 * the waiver was re-dated to 2027-01-15 because nothing in the chain had shipped a fix.
 *
 * The waiver says the advisory is not exploitable here: braces reaches the tree only as
 * ui's dev-time ESLint tooling (`eslint-config-next` -> `@next/eslint-plugin-next` ->
 * `fast-glob` -> `micromatch` -> `braces`). The only patterns it expands are
 * developer-written lint config. It never ships in the server image or the UI bundle, and
 * request input never reaches it.
 *
 * That claim depends on the lockfile staying the same. If a runtime dependency pulls in
 * micromatch or fast-glob tomorrow, the waiver would hide a reachable DoS. So this file
 * reads the RESOLVED tree and fails as soon as braces gains any other route in. The
 * waiver's own `expires` date does the rest: on that date the gate goes red again.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const lockfileText = readFileSync(resolve(repoRoot, "pnpm-lock.yaml"), "utf8");
const workflowText = readFileSync(resolve(repoRoot, ".github", "workflows", "sast.yml"), "utf8");

const ADVISORY = "GHSA-vfj7-8cjw-p6xm";

const PYTHON3 = spawnSync("python3", ["-c", "print(1)"], { encoding: "utf8" }).status === 0;

/** `'@scope/name@1.2.3(peer@4)'` or `braces@3.0.3` -> the bare package name. */
function packageNameOf(key) {
  const bare = key.replace(/^'|'$/g, "");
  const at = bare.indexOf("@", 1);
  return at === -1 ? bare : bare.slice(0, at);
}

/** Dependency NAMES under a 4-space `*dependencies:` header, from 6-space entries. */
function collectDependencyNames(lines, sectionFilter) {
  const names = [];
  let inSection = false;
  for (const line of lines) {
    const header = /^ {4}(\w*[dD]ependencies):$/.exec(line);
    if (header) {
      inSection = sectionFilter(header[1]);
      continue;
    }
    if (/^ {0,4}\S/.test(line)) {
      inSection = false;
      continue;
    }
    const entry = /^ {6}('[^']+'|[^:\s]+):/.exec(line);
    if (inSection && entry) names.push(entry[1].replace(/^'|'$/g, ""));
  }
  return names;
}

/** Split a top-level lockfile section into its 2-space-indented blocks. */
function blocksOf(sectionName) {
  const lines = lockfileText.split("\n");
  const start = lines.indexOf(`${sectionName}:`);
  expect(start, `pnpm-lock.yaml has no \`${sectionName}:\` section`).toBeGreaterThan(-1);
  const blocks = [];
  for (let i = start + 1; i < lines.length && !/^\S/.test(lines[i]); i++) {
    const key = /^ {2}('[^']+'|[^\s][^:]*?):(?: \{\})?$/.exec(lines[i]);
    if (key) blocks.push({ key: key[1], lines: [] });
    else if (blocks.length > 0) blocks[blocks.length - 1].lines.push(lines[i]);
  }
  return blocks;
}

/** Every package NAME that transitively depends on `target`, via `snapshots:`. */
function ancestorsOf(target) {
  const edges = blocksOf("snapshots").map((b) => ({
    name: packageNameOf(b.key),
    deps: collectDependencyNames(b.lines, () => true),
  }));
  const found = new Set();
  let frontier = new Set([target]);
  while (frontier.size > 0) {
    const next = new Set();
    for (const { name, deps } of edges) {
      if (!found.has(name) && name !== target && deps.some((d) => frontier.has(d))) {
        found.add(name);
        next.add(name);
      }
    }
    frontier = next;
  }
  return found;
}

describe(`braces ${ADVISORY} is waived only while it stays dev-only (#767)`, () => {
  const chain = new Set(["braces", ...ancestorsOf("braces")]);

  it("reaches braces through exactly one chain, ending at eslint-config-next", () => {
    expect([...chain].sort()).toEqual(
      ["@next/eslint-plugin-next", "braces", "eslint-config-next", "fast-glob", "micromatch"],
      "braces gained a new route into the tree. The sast.yml waiver for " +
        `${ADVISORY} assumes lint tooling is its only consumer. Re-triage before you ` +
        "extend the waiver or this list.",
    );
  });

  it("enters through a workspace devDependency only, never a runtime dependency", () => {
    const entries = blocksOf("importers").flatMap((importer) =>
      ["dependencies", "devDependencies", "optionalDependencies"].flatMap((section) =>
        collectDependencyNames(importer.lines, (s) => s === section)
          .filter((name) => chain.has(name))
          .map((name) => `${importer.key} ${section} ${name}`),
      ),
    );
    expect(entries).toEqual(["ui devDependencies eslint-config-next"]);
  });

  // #777 re-dated the waiver on a narrower claim: the plugin is installed but never
  // LOADED. Next 16 removed `next lint` and build-time linting, so only an ESLint config
  // importing eslint-config-next or the plugin could load it — and the plugin's one glob
  // call (`globSync(settings.next.rootDir)`) is what reaches braces. A config that starts
  // loading it must re-triage the waiver, so this arm goes red the moment one does.
  it("is loaded by no tracked ESLint config (#777)", () => {
    const listed = spawnSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8" });
    expect(listed.status, listed.stderr).toBe(0);
    const configs = listed.stdout
      .split("\n")
      .filter((f) => /(^|\/)(eslint\.config\.[cm]?[jt]s|\.eslintrc(\.[a-z]+)?)$/.test(f));
    // An empty list would pass the loop below vacuously.
    expect(configs, "found no ESLint config at all — the scan is broken").toContain(
      "ui/eslint.config.mjs",
    );
    const loaders = configs.filter((f) =>
      /eslint-config-next|@next\/eslint-plugin-next|settings[\s\S]*rootDir/.test(
        readFileSync(resolve(repoRoot, f), "utf8"),
      ),
    );
    expect(
      loaders,
      "an ESLint config now loads the Next plugin (or sets next.rootDir). The braces " +
        `waiver for ${ADVISORY} says it is never loaded: re-triage before the waiver stands.`,
    ).toEqual([]);
  });

  // Executes the real dict, as sast-waiver-expiry.test.mjs does. Skips without python3.
  it.skipIf(!PYTHON3)("carries a dated, reasoned waiver in the audit gate", () => {
    const start = workflowText.indexOf("WAIVERS = {");
    const end = workflowText.indexOf("today = datetime.date.today()", start);
    expect(start, "WAIVERS dict not found in sast.yml").toBeGreaterThan(-1);
    expect(end, "WAIVERS dict is no longer followed by `today = ...`").toBeGreaterThan(start);
    const block = workflowText.slice(start, end).replace(/^ {10}/gm, "");
    const program = `${block}\nimport json\nprint(json.dumps(WAIVERS.get("${ADVISORY}")))\n`;
    const run = spawnSync("python3", ["-c", program], { encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    const waiver = JSON.parse(run.stdout);
    expect(waiver, `no WAIVERS entry for ${ADVISORY}`).not.toBeNull();
    expect(waiver.expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The reason must name the route the first two arms verified, so the waiver text and
    // the lockfile cannot drift apart without one of them going red.
    expect(waiver.reason).toContain("dev-time");
    for (const name of [...chain].filter((n) => n !== "braces")) {
      expect(waiver.reason, `waiver reason no longer names ${name}`).toContain(name);
    }
  });
});
