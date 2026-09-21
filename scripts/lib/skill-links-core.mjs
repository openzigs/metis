/**
 * Pure decision logic for the skill-discovery link check (Issue #1142).
 *
 * ## Why this exists
 *
 * METIS keeps ONE copy of every skill body, in `.github/skills/<name>/SKILL.md`
 * — the GitHub Copilot convention, and the path that every `.github/agents/*`
 * and `.claude/agents/*` file already references by name.
 *
 * Claude Code, however, only discovers project skills under `.claude/skills/`.
 * Its docs say a skill entry "can be a symlink to a directory elsewhere on
 * disk. Claude Code follows the symlink and reads `SKILL.md` from the target
 * directory". So `.claude/skills/<name>` is a symlink to
 * `../../.github/skills/<name>` and both ecosystems read the same bytes. There
 * is no generated copy, so there is nothing that can drift.
 *
 * That arrangement has exactly two failure modes, and this module exists to
 * catch both in CI rather than in a session six weeks later:
 *
 *  1. **A skill is added to `.github/skills/` and nobody links it.** It stays
 *     invisible to Claude Code — silently, because a missing skill looks
 *     identical to a skill the model chose not to use. This is precisely the
 *     state #1142 was filed to fix, so it needs a guard or it comes straight
 *     back.
 *
 *  2. **The link does not survive a checkout.** Git records a symlink as a
 *     blob with mode 120000 whose contents are the target path. A client with
 *     `core.symlinks=false` — the Git for Windows default when the user lacks
 *     the create-symlink privilege — materializes that blob as a REGULAR FILE
 *     containing the path text. `.claude/skills/code-issue` is then a file,
 *     not a directory, and discovery fails again.
 *
 * The two are worth separating, because they need different reactions. (1) is
 * a repository defect: the fix is to add the link and it is the same on every
 * platform. (2) is a local checkout limitation: the repository is correct, the
 * working tree is degraded, and the fix is `git config core.symlinks true`
 * followed by a re-checkout. So `classifyEntry` reports them as distinct
 * states and the caller decides severity, rather than collapsing both into
 * "broken".
 *
 * Everything here is pure: callers inject the git index listing and the
 * filesystem probe results, so the whole matrix — including the Windows
 * unmaterialized case — is unit-testable on any platform.
 */

/** Directory holding the single source of truth for skill bodies. */
export const SOURCE_DIR = ".github/skills";

/** Directory Claude Code scans for project skills. */
export const LINK_DIR = ".claude/skills";

/** Git file mode denoting a symbolic link. */
export const SYMLINK_MODE = "120000";

/**
 * Shortest acceptable `description`. Claude Code matches skills semantically
 * on the description alone, so a title-shaped one ("Code issue workflow")
 * either never fires or fires on everything. 40 characters is not a quality
 * bar, but it does reject the degenerate case.
 */
export const MIN_DESCRIPTION_LENGTH = 40;

/**
 * Claude Code truncates `description` + `when_to_use` at 1536 characters in
 * the skill listing. Anything past that is paid for and then cut off.
 */
export const MAX_DESCRIPTION_LENGTH = 1536;

/**
 * The symlink target a given skill's link entry must contain.
 *
 * `.claude/skills/<name>` is two levels deep, so the relative hop back to the
 * repository root is `../..`. Storing the target RELATIVE (rather than
 * absolute) is what makes the link survive clones into any directory.
 *
 * @param {string} name skill directory name
 * @returns {string}
 */
export function expectedLinkTarget(name) {
  return `../../${SOURCE_DIR}/${name}`;
}

/**
 * Parse the leading YAML frontmatter of a SKILL.md into a flat key/value map.
 *
 * Deliberately minimal — it understands exactly the shape skills use: a `---`
 * fence, `key: value` lines, `#` comments, and optionally quoted scalars. It
 * is not a YAML parser and does not try to be; it exists so the check can
 * assert on `name` and `description` without adding a dependency to a package
 * that is otherwise dependency-free.
 *
 * It does faithfully reproduce one YAML rule that bites here: in an UNQUOTED
 * scalar, a space followed by `#` begins an inline comment and everything after
 * it is discarded. A description ending `...a PR that says "Closes #N".` loses
 * its tail — silently, and only in the loaded skill listing, so the file on
 * disk looks perfectly fine. Keys where that happened are reported in
 * `commentTruncated` so the caller can reject it rather than shipping a
 * half-description as the sole basis for auto-invocation.
 *
 * @param {string} text full file contents
 * @returns {{ found: boolean, fields: Record<string, string>, commentTruncated: string[] }}
 */
export function parseFrontmatter(text) {
  /** @type {Record<string, string>} */
  const fields = {};
  /** @type {string[]} */
  const commentTruncated = [];
  if (typeof text !== "string") return { found: false, fields, commentTruncated };

  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { found: false, fields, commentTruncated };

  let closed = false;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "---") {
      closed = true;
      break;
    }
    // Whole-line comments and blank lines carry no field.
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;

    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    // Only top-level scalars matter here; indented lines belong to a nested
    // structure this parser intentionally ignores.
    if (key !== line.slice(0, separator)) continue;

    let value = line.slice(separator + 1).trim();
    let quoted = false;
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
        quoted = true;
      }
    }
    if (!quoted) {
      const comment = value.indexOf(" #");
      if (comment >= 0) {
        value = value.slice(0, comment).trimEnd();
        commentTruncated.push(key);
      }
    }
    fields[key] = value;
  }

  return { found: closed, fields, commentTruncated };
}

/**
 * Validate one skill's frontmatter.
 *
 * @param {string} name skill directory name
 * @param {string | null} text SKILL.md contents, or null when unreadable
 * @returns {string[]} problem descriptions; empty means valid
 */
export function checkFrontmatter(name, text) {
  /** @type {string[]} */
  const problems = [];
  if (text === null || text === undefined) {
    problems.push(`${SOURCE_DIR}/${name}/SKILL.md is missing or unreadable`);
    return problems;
  }

  const { found, fields, commentTruncated } = parseFrontmatter(text);
  if (!found) {
    problems.push(`${name}: SKILL.md has no closed --- frontmatter block`);
    return problems;
  }

  if (commentTruncated.includes("description")) {
    problems.push(
      `${name}: the description is unquoted and contains " #", so YAML discards everything from the hash onward. ` +
        `Wrap the value in quotes.`,
    );
  }

  if (!fields.name) {
    problems.push(`${name}: frontmatter is missing "name"`);
  } else if (fields.name !== name) {
    problems.push(`${name}: frontmatter name is "${fields.name}" but the directory is "${name}"`);
  }

  const description = fields.description ?? "";
  if (description.length === 0) {
    problems.push(`${name}: frontmatter is missing "description"`);
  } else if (description.length < MIN_DESCRIPTION_LENGTH) {
    problems.push(
      `${name}: description is ${description.length} chars — under the ${MIN_DESCRIPTION_LENGTH}-char floor. ` +
        `It is the ONLY basis for auto-invocation, so write a trigger ("Use when ...") rather than a title.`,
    );
  } else if (description.length > MAX_DESCRIPTION_LENGTH) {
    problems.push(
      `${name}: description is ${description.length} chars — over the ${MAX_DESCRIPTION_LENGTH}-char listing cap, so the tail is truncated.`,
    );
  }

  return problems;
}

/**
 * The frontmatter key that stops a skill being auto-invoked, leaving `/<name>` as the only
 * way in.
 *
 * This is the guard three skills already carry, and #1282 turned that convention into a
 * check. It is a convention worth mechanising precisely because the three that have it are
 * **right**: `criteria-generator`, `test-planner` and `test-reviewer` name a
 * `test-orchestrator` agent that exists nowhere and `talos_*` tools from a server absent
 * from `.mcp.json`, and each says so in its description. `criteria-generator` states the
 * reason outright — *"Auto-invoking it would hand an agent tool names it cannot call."*
 * That is the correct handling of a skill kept for a real external instance, and nothing
 * but the next author's memory kept a fourth one from shipping without it.
 */
export const MODEL_INVOCATION_GUARD = "disable-model-invocation";

/**
 * MCP tool spellings that name their server unambiguously.
 *
 * Deliberately anchored to a literal marker rather than "looks like a tool name". A bare
 * `[a-z]+_[a-z_]+` sweep over these bodies matches `node_modules`, `user_story`, `api_spec`,
 * `read_file`, `fetch_webpage`, `browser_click` and `execution_subagent` — none of which is
 * an MCP server, and every one of which would make this check fire on a healthy skill. A
 * gate people have to route around is worse than no gate.
 *
 *  - `mcp__<server>__<tool>` — the Claude Code spelling.
 *  - `mcp_<server>_<tool>` — the Copilot spelling.
 *  - `<server>_*` — an explicit namespace glob. This is the form that catches `talos_*`,
 *    and it is authored on purpose: nobody writes a trailing `_*` by accident.
 *
 * The `mcp` prefix is filtered by the caller, **not** by a `(?!mcp\b)` lookahead in the
 * third pattern. That lookahead was tried and is inert: `_` is a word character, so the
 * `\b` after `mcp` never matches in `mcp_*` and the exclusion it appears to make never
 * fires. A deletability sweep is what exposed it — the caller's explicit check proved
 * deletable with the suite green, because the only test covering it used `mcp__*`, which
 * these patterns do not match at all. One filter, in one place, with a test that reaches it.
 *
 * @type {Array<RegExp>}
 */
const MCP_SERVER_PATTERNS = [
  /\bmcp__([a-z0-9][a-z0-9-]*)__/gi,
  /\bmcp_([a-z0-9][a-z0-9-]*)_[a-z0-9]/gi,
  /\b([a-z][a-z0-9-]*)_\*/gi,
];

/** A backticked or plain `<name>.agent.md` reference in a skill body. */
const AGENT_FILE_REFERENCE = /\b([a-z0-9][a-z0-9-]*)\.agent\.md\b/gi;

/**
 * Every MCP server a skill's text names, by any of the recognised spellings.
 *
 * @param {string} text
 * @returns {string[]} sorted, deduplicated, lower-cased server names
 */
export function extractMcpServerReferences(text) {
  /** @type {Set<string>} */
  const servers = new Set();
  if (typeof text !== "string") return [];
  for (const pattern of MCP_SERVER_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const server = match[1].toLowerCase();
      if (server !== "mcp") servers.add(server);
    }
  }
  return [...servers].sort();
}

/**
 * Every agent definition a skill's text names by filename.
 *
 * @param {string} text
 * @returns {string[]} sorted, deduplicated agent slugs
 */
export function extractAgentFileReferences(text) {
  /** @type {Set<string>} */
  const agents = new Set();
  if (typeof text !== "string") return [];
  for (const match of text.matchAll(AGENT_FILE_REFERENCE)) agents.add(match[1].toLowerCase());
  return [...agents].sort();
}

/**
 * Assert that a skill whose tooling this repository cannot reach is not auto-invocable.
 *
 * ## The failure it prevents
 *
 * A skill's `description` is the *only* input to auto-invocation. A skill that fires on
 * "plan the tests" and then instructs an agent to call `talos_list_criteria` has not failed
 * loudly — it has spent a delegation, produced a workflow nobody can execute, and pulled the
 * session away from the work. This is the declared-but-unreachable class this repository has
 * hit repeatedly: #1162 (`Skill` absent from six agents' allowlists), #1163 (a memory scope
 * with the write tools denied), #1168 (`Glob`/`Grep` that resolve to nothing), #1180
 * (`mcp__*` instructions to an agent with no MCP at all).
 *
 * ## Why the check is one-directional
 *
 * Unreachable tooling **requires** the guard; carrying the guard does not require
 * unreachable tooling. `repo-scaffold` sets it for its own reasons and is not flagged.
 * Someone could in principle silence this check by adding the guard everywhere — but that is
 * not a bypass, it is compliance: the skill genuinely stops auto-invoking, which is the
 * outcome the rule is protecting.
 *
 * ## Fail-closed inputs
 *
 * `mcpServerNames` or `agentSlugs` passed as `null` means the caller **could not enumerate**
 * them, which is a different state from "there are none" and must not read as "nothing is
 * unreachable". A repository legitimately has no `.mcp.json`; a repository whose `.mcp.json`
 * could not be parsed is a repository where this rule cannot be evaluated, and #1215 found
 * eight gates that treated the two the same.
 *
 * @param {object} input
 * @param {string} input.name skill directory name
 * @param {string | null} input.text SKILL.md contents
 * @param {string[] | null} input.mcpServerNames servers defined in `.mcp.json`; null when
 *   the file could not be enumerated
 * @param {string[] | null} input.agentSlugs agent definitions that exist; null when the
 *   agent directories could not be enumerated
 * @returns {string[]} problems
 */
export function checkModelInvocationGuard({ name, text, mcpServerNames, agentSlugs }) {
  /** @type {string[]} */
  const problems = [];
  // An unreadable body is `checkFrontmatter`'s message to give; saying it twice is noise.
  if (typeof text !== "string") return problems;

  const { fields } = parseFrontmatter(text);
  const guarded = (fields[MODEL_INVOCATION_GUARD] ?? "").trim().toLowerCase() === "true";

  const referencedServers = extractMcpServerReferences(text);
  const referencedAgents = extractAgentFileReferences(text);

  if (mcpServerNames === null || mcpServerNames === undefined) {
    if (referencedServers.length > 0) {
      problems.push(
        `${name}: names MCP server(s) ${referencedServers.join(", ")}, but the configured server ` +
          `list could not be read. "Could not enumerate" is not "nothing is unreachable" (#1215).`,
      );
    }
  }
  if (agentSlugs === null || agentSlugs === undefined) {
    if (referencedAgents.length > 0) {
      problems.push(
        `${name}: names agent file(s) ${referencedAgents.join(", ")}, but the agent directories ` +
          `could not be read, so their existence cannot be decided.`,
      );
    }
  }
  if (problems.length > 0) return problems;

  const missingServers = referencedServers.filter(
    (server) => !(/** @type {string[]} */ (mcpServerNames).includes(server)),
  );
  const missingAgents = referencedAgents.filter(
    (agent) => !(/** @type {string[]} */ (agentSlugs).includes(agent)),
  );

  if (missingServers.length === 0 && missingAgents.length === 0) return problems;
  if (guarded) return problems;

  /** @type {string[]} */
  const reasons = [];
  if (missingServers.length > 0) {
    reasons.push(
      `MCP server(s) ${missingServers.join(", ")} not defined in .mcp.json (configured: ${
        /** @type {string[]} */ (mcpServerNames).join(", ") || "none"
      })`,
    );
  }
  if (missingAgents.length > 0) {
    reasons.push(
      `agent file(s) ${missingAgents.map((agent) => `${agent}.agent.md`).join(", ")} do not exist`,
    );
  }

  problems.push(
    `${name}: names tooling this repository cannot reach — ${reasons.join("; ")} — but does not ` +
      `carry "${MODEL_INVOCATION_GUARD}: true". The description is the only input to ` +
      `auto-invocation, so without the guard this skill can fire on an ordinary request and hand ` +
      `an agent tool names it cannot call. Add the guard and say so in the description, the way ` +
      `criteria-generator does, or point the skill at tooling that exists (#1282).`,
  );
  return problems;
}

/**
 * Classify one skill's `.claude/skills/<name>` entry.
 *
 * `indexTarget` is what git RECORDS (authoritative, identical on every
 * platform). `worktree` is what the local checkout actually produced. Keeping
 * them apart is the whole point — see the module header.
 *
 * @param {object} input
 * @param {string} input.name
 * @param {string | null} input.indexMode git mode from `git ls-files -s`, null when absent
 * @param {string | null} input.indexTarget blob contents of the index entry, null when absent
 * @param {"symlink" | "file" | "directory" | "missing"} input.worktreeKind
 * @param {string | null} [input.worktreeContent] file contents when worktreeKind is "file"
 * @param {boolean} [input.skillMdReadable] whether `<link>/SKILL.md` resolves and reads
 * @returns {{ name: string, status: "ok" | "unmaterialized" | "broken", detail: string }}
 */
export function classifyEntry({
  name,
  indexMode,
  indexTarget,
  worktreeKind,
  worktreeContent = null,
  skillMdReadable = false,
}) {
  const expected = expectedLinkTarget(name);

  // --- Repository-level invariant, checked first: is the link committed? ---
  if (indexMode === null || indexMode === undefined) {
    return {
      name,
      status: "broken",
      detail:
        `${LINK_DIR}/${name} is not tracked. Claude Code only discovers skills under ${LINK_DIR}/, ` +
        `so this skill is invisible to it. Fix: ln -s ${expected} ${LINK_DIR}/${name}`,
    };
  }
  if (indexMode !== SYMLINK_MODE) {
    return {
      name,
      status: "broken",
      detail:
        `${LINK_DIR}/${name} is committed with mode ${indexMode}, not ${SYMLINK_MODE} (symlink). ` +
        `A committed copy would fork the skill body and drift from ${SOURCE_DIR}/${name}.`,
    };
  }
  if (indexTarget !== expected) {
    return {
      name,
      status: "broken",
      detail: `${LINK_DIR}/${name} points at "${indexTarget}", expected "${expected}".`,
    };
  }

  // --- Working-tree materialization: correct repo, possibly degraded checkout ---
  if (worktreeKind === "symlink" || worktreeKind === "directory") {
    if (skillMdReadable) {
      return { name, status: "ok", detail: `${LINK_DIR}/${name} -> ${expected}` };
    }
    return {
      name,
      status: "broken",
      detail: `${LINK_DIR}/${name} resolves but ${SOURCE_DIR}/${name}/SKILL.md does not read.`,
    };
  }

  // A regular file whose contents are exactly the target path is the
  // signature of a `core.symlinks=false` checkout, not a corrupt repository.
  if (worktreeKind === "file" && worktreeContent?.trim() === expected) {
    return {
      name,
      status: "unmaterialized",
      detail:
        `${LINK_DIR}/${name} checked out as a plain file holding "${expected}" — this client has ` +
        `core.symlinks=false, so Claude Code cannot discover the skill in THIS working tree. ` +
        `The commit is correct. Fix locally: git config core.symlinks true && git checkout -- ${LINK_DIR}`,
    };
  }

  return {
    name,
    status: "broken",
    detail: `${LINK_DIR}/${name} is a ${worktreeKind} in the working tree; expected a symlink to ${expected}.`,
  };
}

/**
 * Run the whole check over pre-gathered inputs.
 *
 * @param {object} input
 * @param {string[]} input.skillNames directory names under `.github/skills`
 * @param {Record<string, { mode: string, target: string }>} input.indexEntries keyed by skill name
 * @param {Record<string, { kind: "symlink" | "file" | "directory" | "missing", content?: string | null, skillMdReadable?: boolean }>} input.worktree keyed by skill name
 * @param {Record<string, string | null>} input.skillFiles SKILL.md contents keyed by skill name
 * @param {string[]} [input.extraLinkNames] tracked entries under `.claude/skills` with no source dir
 * @param {string[] | null} [input.mcpServerNames] servers defined in `.mcp.json`, for the
 *   #1282 guard rule. `null` means the list could not be enumerated, which is a different
 *   state from an empty list and is reported rather than shrugged at.
 * @param {string[] | null} [input.agentSlugs] agent definitions that exist on either
 *   surface, same convention.
 * @returns {{ ok: boolean, results: Array<{name: string, status: string, detail: string}>, problems: string[], warnings: string[] }}
 */
export function verifySkillLinks({
  skillNames,
  indexEntries,
  worktree,
  skillFiles,
  extraLinkNames = [],
  mcpServerNames = null,
  agentSlugs = null,
}) {
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const warnings = [];
  /** @type {Array<{name: string, status: string, detail: string}>} */
  const results = [];

  if (skillNames.length === 0) {
    problems.push(
      `No skills found under ${SOURCE_DIR}/ — the skill library is the source of truth.`,
    );
  }

  for (const name of [...skillNames].sort()) {
    const index = indexEntries[name];
    const tree = worktree[name] ?? { kind: "missing" };
    const result = classifyEntry({
      name,
      indexMode: index?.mode ?? null,
      indexTarget: index?.target ?? null,
      worktreeKind: tree.kind,
      worktreeContent: tree.content ?? null,
      skillMdReadable: tree.skillMdReadable ?? false,
    });
    results.push(result);

    if (result.status === "broken") problems.push(result.detail);
    if (result.status === "unmaterialized") warnings.push(result.detail);

    problems.push(...checkFrontmatter(name, skillFiles[name] ?? null));
    problems.push(
      ...checkModelInvocationGuard({
        name,
        text: skillFiles[name] ?? null,
        mcpServerNames,
        agentSlugs,
      }),
    );
  }

  for (const name of [...extraLinkNames].sort()) {
    problems.push(
      `${LINK_DIR}/${name} is tracked but ${SOURCE_DIR}/${name} does not exist — a dangling link, or a skill body that escaped the source of truth.`,
    );
  }

  return { ok: problems.length === 0, results, problems, warnings };
}
