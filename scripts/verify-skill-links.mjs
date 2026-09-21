#!/usr/bin/env node
/**
 * `pnpm skills:verify` — assert that every skill in `.github/skills/` is
 * discoverable by Claude Code through `.claude/skills/` (Issue #1142).
 *
 * Thin I/O glue only: it gathers the git index listing and the filesystem
 * facts, then hands them to the pure logic in `lib/skill-links-core.mjs`,
 * which is where the rules and their reasoning live.
 *
 * Exit codes:
 *   0  every skill is linked, committed as a symlink, and has usable frontmatter
 *   1  a repository-level defect (missing link, wrong target, bad frontmatter)
 *
 * An "unmaterialized" link — the commit is right but this checkout has
 * `core.symlinks=false`, which is the Git for Windows default without the
 * create-symlink privilege — is reported as a WARNING, not a failure. The
 * repository is correct; the working tree is degraded, and the message says
 * how to fix it. Failing there would make the check a report on the developer's
 * Git configuration rather than on the commit under test.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CLAUDE_AGENT_DIR,
  COPILOT_AGENT_DIR,
  copilotAgentSlug,
} from "./lib/copilot-agent-surface-core.mjs";
import { LINK_DIR, SOURCE_DIR, verifySkillLinks } from "./lib/skill-links-core.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(repoRoot, ...SOURCE_DIR.split("/"));
const linkRoot = path.join(repoRoot, ...LINK_DIR.split("/"));

/**
 * MCP servers this repository actually configures, or `null` when that cannot be decided.
 *
 * The two states are kept apart deliberately. A missing `.mcp.json` is a knowable answer —
 * no servers — and a repository with none is legitimate. A `.mcp.json` that exists and
 * cannot be parsed is a repository where the guard rule has no ground truth, and reporting
 * that as "no servers configured" would flag every skill; reporting it as "everything is
 * reachable" would flag none. Neither is honest, so the core is told `null` and says so
 * (#1215).
 *
 * @returns {string[] | null}
 */
function readMcpServerNames() {
  let raw;
  try {
    raw = fs.readFileSync(path.join(repoRoot, ".mcp.json"), "utf8");
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT" ? [] : null;
  }
  try {
    const servers = JSON.parse(raw).mcpServers;
    return servers && typeof servers === "object" ? Object.keys(servers) : [];
  } catch {
    return null;
  }
}

/**
 * Every agent definition that exists, on **either** surface, or `null` when neither
 * directory could be read.
 *
 * Both are consulted because a skill's `<name>.agent.md` reference is a Copilot spelling
 * for an agent that usually exists on both surfaces, and flagging `code-review.agent.md` as
 * missing because someone reorganised the Copilot directory — while `.claude/agents/` still
 * holds the agent — would be a false positive on a healthy repository. The union is the
 * charitable read, and the *parity* between the two directories is `agents:verify`'s job,
 * not this one's (#1282, ADR 0009).
 *
 * @returns {string[] | null}
 */
function readAgentSlugs() {
  /** @type {Set<string>} */
  const slugs = new Set();
  let read = 0;
  for (const [dir, toSlug] of /** @type {Array<[string, (name: string) => string | null]>} */ ([
    [COPILOT_AGENT_DIR, copilotAgentSlug],
    [CLAUDE_AGENT_DIR, (name) => (name.endsWith(".md") ? name.slice(0, -3) : null)],
  ])) {
    let entries;
    try {
      entries = fs.readdirSync(path.join(repoRoot, ...dir.split("/")));
    } catch (error) {
      // ENOENT is a knowable answer — that surface has no agents. Anything else means the
      // directory exists and could not be listed, which is the state that must not read as
      // "no agents there".
      if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") read += 1;
      continue;
    }
    read += 1;
    for (const name of entries) {
      const slug = toSlug(name);
      if (slug !== null && slug.length > 0) slugs.add(slug.toLowerCase());
    }
  }
  return read === 0 ? null : [...slugs].sort();
}

/**
 * Read the tracked `.claude/skills` entries with their git modes and, for
 * symlinks, the recorded target. This is the platform-independent view: it
 * reflects what was COMMITTED, regardless of what the checkout produced.
 *
 * @returns {Record<string, { mode: string, target: string }>}
 */
function readIndexEntries() {
  /** @type {Record<string, { mode: string, target: string }>} */
  const entries = {};
  let listing = "";
  try {
    listing = execFileSync("git", ["ls-files", "-s", "--", LINK_DIR], {
      cwd: repoRoot,
      encoding: "utf8",
    });
  } catch {
    console.error(`Could not run git ls-files in ${repoRoot}.`);
    process.exit(1);
  }

  for (const line of listing.split("\n")) {
    if (line.trim().length === 0) continue;
    // Format: "<mode> <sha> <stage>\t<path>"
    const [meta, filePath] = line.split("\t");
    if (!filePath) continue;
    const [mode, sha] = meta.trim().split(/\s+/);
    const name = filePath.slice(LINK_DIR.length + 1).split("/")[0];
    if (!name || entries[name]) continue;

    let target = "";
    try {
      target = execFileSync("git", ["cat-file", "blob", sha], {
        cwd: repoRoot,
        encoding: "utf8",
      }).trim();
    } catch {
      target = "";
    }
    entries[name] = { mode, target };
  }
  return entries;
}

/**
 * Probe what the working tree actually holds at `.claude/skills/<name>`.
 *
 * @param {string} name
 * @returns {{ kind: "symlink" | "file" | "directory" | "missing", content: string | null, skillMdReadable: boolean }}
 */
function probeWorktree(name) {
  const entryPath = path.join(linkRoot, name);
  let stats;
  try {
    stats = fs.lstatSync(entryPath);
  } catch {
    return { kind: "missing", content: null, skillMdReadable: false };
  }

  let skillMdReadable = false;
  try {
    skillMdReadable = fs.statSync(path.join(entryPath, "SKILL.md")).isFile();
  } catch {
    skillMdReadable = false;
  }

  if (stats.isSymbolicLink()) {
    return { kind: "symlink", content: null, skillMdReadable };
  }
  if (stats.isDirectory()) {
    return { kind: "directory", content: null, skillMdReadable };
  }
  let content = null;
  try {
    content = fs.readFileSync(entryPath, "utf8");
  } catch {
    content = null;
  }
  return { kind: "file", content, skillMdReadable: false };
}

function main() {
  if (!fs.existsSync(sourceRoot)) {
    console.error(`Missing ${SOURCE_DIR}/ — nothing to verify.`);
    process.exit(1);
  }

  const skillNames = fs
    .readdirSync(sourceRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  const indexEntries = readIndexEntries();
  const extraLinkNames = Object.keys(indexEntries).filter((name) => !skillNames.includes(name));

  /** @type {Record<string, ReturnType<typeof probeWorktree>>} */
  const worktree = {};
  /** @type {Record<string, string | null>} */
  const skillFiles = {};
  for (const name of skillNames) {
    worktree[name] = probeWorktree(name);
    try {
      skillFiles[name] = fs.readFileSync(path.join(sourceRoot, name, "SKILL.md"), "utf8");
    } catch {
      skillFiles[name] = null;
    }
  }

  const report = verifySkillLinks({
    skillNames,
    indexEntries,
    worktree,
    skillFiles,
    extraLinkNames,
    mcpServerNames: readMcpServerNames(),
    agentSlugs: readAgentSlugs(),
  });

  const linked = report.results.filter((r) => r.status === "ok").length;
  const degraded = report.results.filter((r) => r.status === "unmaterialized").length;

  console.log(
    `Skill discovery: ${skillNames.length} skill(s) in ${SOURCE_DIR}/, ` +
      `${linked} resolving through ${LINK_DIR}/ in this working tree.`,
  );
  console.log(`platform=${process.platform}`);

  for (const result of report.results) {
    const marker = result.status === "ok" ? "ok  " : "WARN";
    if (result.status === "ok") {
      console.log(`  ${marker} ${result.detail}`);
    } else if (result.status === "unmaterialized") {
      console.log(`  ${marker} ${result.detail}`);
    }
  }

  for (const warning of report.warnings) {
    console.warn(`WARNING: ${warning}`);
  }

  if (degraded > 0) {
    console.warn(
      `\n${degraded} link(s) did not materialize in this checkout. The commit is correct ` +
        `(git records mode 120000); this client cannot create symlinks.`,
    );
  }

  if (!report.ok) {
    console.error("\nSkill discovery check FAILED:");
    for (const problem of report.problems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  console.log("\nAll skills are committed as symlinks with usable frontmatter.");
}

main();
