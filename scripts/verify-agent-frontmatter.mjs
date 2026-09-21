#!/usr/bin/env node
/**
 * `pnpm agents:verify` — assert that every Claude Code subagent definition in
 * `.claude/agents/` has frontmatter that says what it means (Issue #1146).
 *
 * Thin I/O glue only: it reads the agent files, `.mcp.json`, the skill names in
 * `.claude/skills/` and `CLAUDE.md`, then hands them to the pure logic in
 * `lib/agent-frontmatter-core.mjs`, which
 * is where the rules and their reasoning live. The YAML frontmatter parser
 * itself is shared with `pnpm skills:verify` rather than duplicated — the
 * ` #`-truncation rule in particular has exactly one implementation.
 *
 * Exit codes:
 *   0  every agent's frontmatter is valid and CLAUDE.md's table matches disk
 *   1  a repository-level defect
 *
 * Warnings (unrecognised keys, a missing `model`, a missing `tools` allowlist)
 * are printed but do not fail: Claude Code supports more frontmatter fields
 * than METIS uses, and a check that rejected a valid-but-unused field would
 * block adopting one.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { COPILOT_AGENT_DIR, copilotAgentSlug } from "./lib/copilot-agent-surface-core.mjs";
import {
  AGENT_DIR,
  MEMORY_ARCHIVE_FILE,
  MEMORY_DIR,
  MEMORY_INDEX_FILE,
  SKILL_DIR,
  SKILL_SOURCE_DIR,
  isMemoryPathSegment,
  memoryEntryPath,
  parseTrackedPaths,
  selectMemoryIndexes,
  verifyAgents,
} from "./lib/agent-frontmatter-core.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agentRoot = path.join(repoRoot, ...AGENT_DIR.split("/"));
const skillRoot = path.join(repoRoot, ...SKILL_DIR.split("/"));
const skillSourceRoot = path.join(repoRoot, ...SKILL_SOURCE_DIR.split("/"));
const copilotAgentRoot = path.join(repoRoot, ...COPILOT_AGENT_DIR.split("/"));

/**
 * Read the server names defined in `.mcp.json`. A missing or malformed file is
 * not this check's business — it yields an empty list, and the only effect is
 * that `mcpServers:` entries cannot be validated against it.
 *
 * @returns {string[]}
 */
function readMcpServerNames() {
  try {
    const raw = fs.readFileSync(path.join(repoRoot, ".mcp.json"), "utf8");
    return Object.keys(JSON.parse(raw).mcpServers ?? {});
  } catch {
    return [];
  }
}

/**
 * Every path under `.claude/agent-memory/` that git is **tracking**.
 *
 * #1163 asked `fs.existsSync` here, which an *untracked* `MEMORY.md` satisfies —
 * silencing rule B while the store stayed invisible to every other checkout,
 * i.e. exactly the guarantee the failure message promises. That is this repo's
 * demonstrated failure mode (`ddbbc6ba` committed 23 orphaned memory files), so
 * the probe asks git (#1168).
 *
 * One `git ls-files` for the whole directory rather than
 * `git ls-files --error-unmatch <path>` per agent: same answer, one subprocess
 * instead of one per agent. The argv is **fixed** — no agent name, and nothing
 * else derived from a filename, is interpolated into it, so a hostile agent
 * filename cannot become a git option or a shell fragment. `execFileSync` with an
 * argv array never involves a shell.
 *
 * @returns {Set<string>} repo-relative, forward-slashed paths
 */
function trackedMemoryPaths() {
  const stdout = execFileSync("git", ["ls-files", "-z", "--", MEMORY_DIR], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return new Set(parseTrackedPaths(stdout));
}

/**
 * Skill names Claude Code can resolve for this project.
 *
 * Entries are matched by **name shape** rather than by directory-ness, because
 * every one is a symlink into `.github/skills/` (#1142) and its `Dirent` type
 * varies by checkout: a directory when followed, a symlink normally, and a plain
 * *file* holding the path text on a Windows client with `core.symlinks=false`.
 * Filtering on `isDirectory()` would silently report zero skills there. The
 * shape filter also drops junk like `.DS_Store`, and a stray name could only
 * ever widen the known-skill set, never fail an agent.
 *
 * **Both roots are read, not just `.claude/skills/`.** An unreadable `.claude/skills/`
 * used to fall to `[]`, which silences the #1180 MCP rule *and* #1162's skill-reference
 * rule at once and still exits 0 — the same fail-open shape the runner test exists to
 * close, one level up. `.github/skills/` is where the files actually live (#1142), so it
 * answers the question even when the symlink tree is missing, unreadable, or has not
 * been created yet on a fresh clone. Unioning rather than falling back means a partial
 * symlink tree cannot hide a skill either; per the note above, a wider set never fails
 * an agent, and `skills:verify` is what gates the symlinks themselves.
 *
 * **An UNREADABLE root that leaves the union empty is a hard failure (#1215).** Tolerating
 * one unreadable root is the union's whole point; tolerating *both* is the #1180 shape
 * one level further out. Measured: with both roots replaced by plain files, an agent
 * body invoking `/ghost-skill` — a name no skill has ever had — exits **0**, because
 * `checkAgent` gates its marked-skill rule on `skillNames.length > 0` and an empty list
 * reads as "no list supplied" rather than "could not enumerate". The identical tree with
 * the roots intact exits 1. That guard is correct in the pure core, which genuinely
 * cannot tell the two apart; only the runner can, so the runner is where it is decided.
 *
 * **`ENOENT` is not unreadable.** A root that is simply not there is a knowable answer —
 * zero skills — and a repository with no skills at all is a legitimate tree this check
 * must not reject. That is the same line `readMemoryStores` below already draws, and
 * drawing it two different ways in one file is how filters come to disagree (#1192). The
 * failure is therefore also conditioned on the union coming back **empty**: if a root
 * answered with content the list is real, and an `EACCES` on the other is the degraded
 * checkout the union exists to absorb.
 *
 * @returns {{ names: string[], unreadable: string[] }}
 */
function readSkillNames() {
  /** @type {Set<string>} */
  const names = new Set();
  /** @type {string[]} */
  const unreadable = [];
  for (const root of [skillRoot, skillSourceRoot]) {
    let entries;
    try {
      entries = fs.readdirSync(root);
    } catch (error) {
      const err = /** @type {NodeJS.ErrnoException} */ (error);
      if (err.code !== "ENOENT") unreadable.push(err.message ?? String(error));
      continue;
    }
    for (const name of entries) {
      if (/^[a-z0-9][a-z0-9-]*$/.test(name)) names.add(name);
    }
  }
  return { names: [...names].sort(), unreadable };
}

/**
 * The body of every skill, keyed by name, for the #1180 MCP-reachability rule.
 *
 * `.claude/skills/<name>` is tried first because that is what Claude Code resolves,
 * then `.github/skills/<name>` — which is where the file really lives (#1142). The
 * fallback is not belt-and-braces: on a Windows client with `core.symlinks=false`
 * the `.claude` entry is a plain *file* holding the target path, so joining
 * `SKILL.md` onto it throws `ENOTDIR`. Without the fallback the rule would read
 * nothing there and pass in silence — which is the exact failure shape #1168 found
 * in rule B's `fs.existsSync` probe.
 *
 * @param {string[]} names
 * @returns {Record<string, string | null>}
 */
function readSkillFiles(names) {
  /** @type {Record<string, string | null>} */
  const files = {};
  for (const name of names) {
    files[name] =
      readOrNull(path.join(skillRoot, name, "SKILL.md")) ??
      readOrNull(path.join(skillSourceRoot, name, "SKILL.md"));
  }
  return files;
}

/**
 * Read every agent-memory store off disk for the #1206 budget rules.
 *
 * **Disk is the source of truth for "which stores exist", and only disk.** Not
 * the agent list: `.claude/agent-memory/code-review/` exists with nothing in it
 * because #1163 removed that agent's `memory:` scope while the harness kept
 * creating the directory, and a store whose owning agent was deleted would still
 * be loaded by nothing yet still be sitting in the repository. Enumerating one
 * way and checking another is how #1192 shipped three bypasses.
 *
 * A missing `MEMORY_DIR` yields no stores — which is correct, and is *not* a
 * fail-open, because `checkMemoryStoresGathered` cross-checks this list against
 * git's answer and fails on the disagreement. Any other error is a hard failure:
 * a directory that cannot be read is not a directory with nothing in it.
 *
 * `indexPresent` is a *directory entry* named `MEMORY.md`, of any type, rather
 * than a successful read. That separation is the point — "present but unreadable"
 * has to be distinguishable from "absent", or an EACCES/EISDIR index reads as an
 * empty store and sails under budget.
 *
 * `files` comes from `listStoreFiles`, which walks the store through the *same*
 * `memoryEntryPath` predicate the pointer side uses. It used to be a narrower
 * inline filter, and the disagreement was a fail-open — see that function.
 *
 * @returns {Array<{ store: string, indexPresent: boolean, index: string | null, archive: string | null, files: string[] }>}
 */
function readMemoryStores() {
  const root = path.join(repoRoot, ...MEMORY_DIR.split("/"));
  /** @type {import("node:fs").Dirent[]} */
  let roots;
  try {
    roots = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return [];
    throw error;
  }

  return roots
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const storeDir = path.join(root, entry.name);
      const contents = fs.readdirSync(storeDir, { withFileTypes: true });
      return {
        store: entry.name,
        indexPresent: contents.some((child) => child.name === MEMORY_INDEX_FILE),
        index: readOrNull(path.join(storeDir, MEMORY_INDEX_FILE)),
        archive: readOrNull(path.join(storeDir, MEMORY_ARCHIVE_FILE)),
        files: listStoreFiles(storeDir),
      };
    });
}

/**
 * Every memory entry a store holds, as store-relative paths.
 *
 * **This is the disk half of one shared predicate, and it used to be a fifth
 * fail-open.** The filter here was `child.isFile() && child.name.endsWith(".md")`
 * — strictly narrower than the pointer side, which accepts any link target.
 * Measured against this runner, that gave four answers to one question: an
 * unindexed non-`.md` file, an unindexed symlinked `.md`, and an unindexed `.md`
 * one directory down each exited **0 silently**, while the identical regular
 * top-level `.md` exited 1. `Dirent.isFile()` has `lstat` semantics, so a symlink
 * is neither a file nor a directory to it and simply vanished; `readdirSync` is
 * not recursive, so a subdirectory's contents were never seen. The mirror was a
 * *wrong* message rather than silence — a pointer to a file that genuinely exists
 * reported as "which does not exist".
 *
 * No mutation catches that, because the defect is in a filter expression rather
 * than in control flow, which is why it survived a 34-mutation sweep. The fix is
 * #1192's: the disk side and the pointer side run one predicate,
 * `memoryEntryPath`, and nothing else decides what counts.
 *
 * So: recursive, and `statSync` (which follows symlinks) rather than the
 * `Dirent`. A broken symlink stats as an error and is skipped — it is genuinely
 * not a file on disk, and a pointer to it correctly reads as dangling. Directory
 * recursion is guarded by realpath, so a symlink cycle terminates instead of
 * hanging the gate.
 *
 * @param {string} storeDir absolute path to the store
 * @returns {string[]} sorted store-relative paths
 */
function listStoreFiles(storeDir) {
  /** @type {string[]} */
  const found = [];
  /** @type {Set<string>} */
  const visited = new Set();

  /** @param {string} dir @param {string} prefix */
  function walk(dir, prefix) {
    const real = realpathOrNull(dir);
    if (real === null || visited.has(real)) return;
    visited.add(real);

    for (const child of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, child.name);
      const relative = prefix ? `${prefix}/${child.name}` : child.name;
      const stats = statOrNull(absolute);
      if (stats === null) continue;
      if (stats.isDirectory()) {
        if (isMemoryPathSegment(child.name)) walk(absolute, relative);
        continue;
      }
      if (!stats.isFile()) continue;
      const entry = memoryEntryPath(relative);
      if (entry !== null) found.push(entry);
    }
  }

  walk(storeDir, "");
  return found.sort();
}

/**
 * @param {string} target
 * @returns {import("node:fs").Stats | null}
 */
function statOrNull(target) {
  try {
    return fs.statSync(target);
  } catch {
    return null;
  }
}

/**
 * @param {string} target
 * @returns {string | null}
 */
function realpathOrNull(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

/**
 * @param {string} filePath
 * @returns {string | null}
 */
function readOrNull(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

/**
 * Read the **Copilot** agent surface, `.github/agents/*.agent.md` (#1282).
 *
 * `readdirSync` throws are deliberately NOT caught here. Everywhere else in this runner
 * that distinction is drawn the same way — an `ENOENT` is a knowable answer and any other
 * error is a defect — but this directory has no legitimate absent state: `AGENTS.md`,
 * `.github/copilot-instructions.md` and six SKILL.md files all reference it by path, and
 * `checkRosterParity` would read "the directory is gone" as "every Claude agent is
 * unpaired", which is loud and correct. So absence fails through the parity rule with a
 * useful message, and unreadability fails through the caller's try/catch with a different
 * one. Neither can be mistaken for a clean run (#1215).
 *
 * A file whose name is not `<slug>.agent.md` is skipped rather than reported: Copilot
 * ignores it too, and a `README.md` sitting beside the agents is not a defect.
 *
 * @returns {Record<string, string | null>} contents keyed by slug
 */
function readCopilotAgentFiles() {
  /** @type {Record<string, string | null>} */
  const files = {};
  for (const entry of fs.readdirSync(copilotAgentRoot, { withFileTypes: true })) {
    const slug = copilotAgentSlug(entry.name);
    if (slug === null) continue;
    // Not gated on `entry.isFile()`: a symlinked definition is one Copilot still loads,
    // and `Dirent.isFile()` has lstat semantics, so gating on it is how the memory walk
    // came to silently skip symlinks (#1192). An unreadable entry reads as null, which
    // `checkCopilotAgent` reports rather than skips.
    files[slug] = readOrNull(path.join(copilotAgentRoot, entry.name));
  }
  return files;
}

/**
 * The documents that tell a reader `.github/agents/` exists (#1282).
 *
 * These are the second source of truth `checkSurfaceDocumented` pins the surface to, the
 * same way `checkClaudeMdTable` pins `.claude/agents/` to `CLAUDE.md`'s table. Every skill
 * body is included alongside the two instruction files because six of them name a
 * `.agent.md` path, and a deletion that left those pointing at nothing is precisely the
 * dangling-reference defect #1146 found on the other surface.
 *
 * Read best-effort: a missing or unreadable document simply cannot claim anything, and
 * making the gate depend on `AGENTS.md` being present would reject a legitimate tree.
 *
 * @param {string[]} skillNames
 * @returns {Record<string, string | null>} keyed by repo-relative path
 */
function readCopilotSurfaceDocs(skillNames) {
  /** @type {Record<string, string | null>} */
  const docs = {};
  for (const relative of ["AGENTS.md", ".github/copilot-instructions.md"]) {
    docs[relative] = readOrNull(path.join(repoRoot, ...relative.split("/")));
  }
  for (const name of skillNames) {
    docs[`${SKILL_SOURCE_DIR}/${name}/SKILL.md`] = readOrNull(
      path.join(skillSourceRoot, name, "SKILL.md"),
    );
  }
  return docs;
}

function main() {
  if (!fs.existsSync(agentRoot)) {
    console.error(`Missing ${AGENT_DIR}/ — nothing to verify.`);
    process.exit(1);
  }

  /** @type {Record<string, string | null>} */
  const agentFiles = {};
  for (const entry of fs.readdirSync(agentRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    agentFiles[entry.name.slice(0, -3)] = readOrNull(path.join(agentRoot, entry.name));
  }

  const names = Object.keys(agentFiles).sort();

  // Rule B asserts a COMMITTED index, so a failure to reach git is not something
  // to shrug off with a filesystem fallback — that fallback is the #1168 defect.
  /** @type {Set<string>} */
  let tracked;
  try {
    tracked = trackedMemoryPaths();
  } catch (error) {
    console.error(
      `Cannot ask git which files under ${MEMORY_DIR}/ are tracked: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    console.error(
      "agents:verify asserts a COMMITTED memory index, which only git can answer, so it needs to " +
        "run inside a git checkout (#1168).",
    );
    process.exit(1);
  }

  // Same reasoning as the git probe above: an unreadable store directory is a
  // defect to report, never an empty list to shrug at (#1206).
  /** @type {ReturnType<typeof readMemoryStores>} */
  let memoryStores;
  try {
    memoryStores = readMemoryStores();
  } catch (error) {
    console.error(
      `Cannot read the agent-memory stores under ${MEMORY_DIR}/: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    console.error(
      "A store directory that cannot be read is not a store that is under budget — fix the " +
        "permissions or the path rather than letting the budget check silently not run (#1206).",
    );
    process.exit(1);
  }

  const { names: skillNames, unreadable: unreadableSkillRoots } = readSkillNames();
  if (unreadableSkillRoots.length > 0 && skillNames.length === 0) {
    console.error(
      `Cannot enumerate skills: neither ${SKILL_DIR}/ nor ${SKILL_SOURCE_DIR}/ yielded a listing.`,
    );
    for (const message of unreadableSkillRoots) console.error(`  ${message}`);
    console.error(
      "Two rules depend on that list — an agent invoking a skill that does not exist (#1162) and " +
        "the transitive MCP-reachability walk (#1180) — and both go quiet on an empty one. No " +
        "skills found is not the same as no skills readable (#1215).",
    );
    process.exit(1);
  }
  // Same reasoning as the git and memory-store probes above: a second agent surface that
  // cannot be read is not a second agent surface with nothing wrong (#1215, #1282).
  /** @type {Record<string, string | null>} */
  let copilotAgentFiles;
  try {
    copilotAgentFiles = readCopilotAgentFiles();
  } catch (error) {
    const err = /** @type {NodeJS.ErrnoException} */ (error);
    if (err.code === "ENOENT") {
      // Knowable: the directory is not there, and a repository with no Copilot surface is
      // legitimate — so the per-file and parity rules skip. What does NOT skip is
      // `checkSurfaceDocumented`, which fails if any document still tells a reader the
      // surface exists. That is what stops a wholesale `rm -rf` from silencing every rule
      // here (#1215). An earlier comment on this line claimed parity emits one problem per
      // Claude agent, which the empty-roster early return makes false.
      copilotAgentFiles = {};
    } else {
      console.error(
        `Cannot read the Copilot agent surface at ${COPILOT_AGENT_DIR}/: ${
          err.message ?? String(error)
        }`,
      );
      console.error(
        "GitHub Copilot loads those definitions and this repository can never observe that read, " +
          "so an unverified surface is exactly the state #1282 exists to end. See " +
          "docs/decisions/0009-two-agent-surfaces-one-gate.md.",
      );
      process.exit(1);
    }
  }

  const report = verifyAgents({
    agentFiles,
    copilotAgentFiles,
    copilotSurfaceDocs: readCopilotSurfaceDocs(skillNames),
    mcpServerNames: readMcpServerNames(),
    skillNames,
    skillFiles: readSkillFiles(skillNames),
    claudeMd: readOrNull(path.join(repoRoot, "CLAUDE.md")),
    memoryIndexes: selectMemoryIndexes(names, (indexPath) => tracked.has(indexPath)),
    memoryStores,
  });
  console.log(`Agent frontmatter: ${names.length} agent(s) in ${AGENT_DIR}/ — ${names.join(", ")}`);
  const copilotNames = Object.keys(copilotAgentFiles).sort();
  console.log(
    `Copilot surface: ${copilotNames.length} agent(s) in ${COPILOT_AGENT_DIR}/ — ${
      copilotNames.join(", ") || "(none)"
    }`,
  );
  for (const store of memoryStores) {
    // "absent" and "unreadable" are different states and the log must not blur
    // them: an empty harness-created store legitimately has no index and exits 0,
    // so printing the failure arm's vocabulary at it reads as a defect that isn't.
    const size =
      store.index !== null
        ? `${Buffer.byteLength(store.index, "utf8")}B`
        : store.indexPresent
          ? "unreadable"
          : "absent";
    console.log(
      `Memory store ${MEMORY_DIR}/${store.store}/: ${store.files.length} file(s), index ${size}`,
    );
  }

  for (const warning of report.warnings) console.warn(`WARNING: ${warning}`);

  if (!report.ok) {
    console.error("\nAgent frontmatter check FAILED:");
    for (const problem of report.problems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  console.log("\nAll agent frontmatter is valid and CLAUDE.md's table matches disk.");
}

main();
