/**
 * Pure decision logic for the Claude Code subagent frontmatter check (Issue #1146).
 *
 * ## Why this exists
 *
 * A subagent's frontmatter is paid on **every** delegation and is almost
 * impossible to get feedback on. There is no error when a field is misspelled,
 * no error when a model alias is wrong, and — the case that motivated this —
 * no error when YAML silently eats half a `description`.
 *
 * That last one is not hypothetical. #1142 found a skill whose unquoted
 * description ended `...a PR that says "Closes #N".` and was truncated at
 * *"Closes"*, because in an unquoted YAML scalar ` #` opens an inline comment.
 * The file on disk looked perfect. The `description` is the ONLY input to
 * auto-delegation, so a truncated one silently mis-routes work forever.
 *
 * Rather than re-implement that rule, this module reuses `parseFrontmatter`
 * from `skill-links-core.mjs` — the same parser, with the same ` #` detection,
 * already unit-tested by #1142. What is added here is only what is specific to
 * *agents* rather than skills:
 *
 *  - block-sequence values (`mcpServers:` is a YAML list; the skill parser
 *    deliberately ignores indented lines because skills have no list fields),
 *  - the `model:` alias vocabulary,
 *  - the `tools` / `disallowedTools` contradiction check,
 *  - `mcpServers` entries that name a server `.mcp.json` does not define,
 *  - unknown top-level keys, which is how `mcpServer:` or `dissallowedTools:`
 *    would otherwise ship and be ignored in silence,
 *  - the body/`tools` contradiction "told to invoke a skill, given no `Skill`
 *    tool" (#1162 — see `SKILL_TOOL`), which is the same failure class as the
 *    `mcp__*` one and shipped in six of seven agents at once,
 *  - and the cross-file invariant that `CLAUDE.md`'s agent table lists exactly
 *    the agents that exist on disk. #1145 deleted an agent and #1146 found a
 *    dangling reference to it still in another agent's body, so that drift is
 *    demonstrated, not theoretical.
 *
 * Everything here is pure: callers inject file contents, so every branch is
 * unit-testable without a repository.
 */

import { LENSES } from "./adversarial-tally-core.mjs";
import { verifyCopilotSurface } from "./copilot-agent-surface-core.mjs";
import { parseFrontmatter } from "./skill-links-core.mjs";

/** Directory Claude Code scans for project subagents. */
export const AGENT_DIR = ".claude/agents";

/** Directory Claude Code scans for project skills. */
export const SKILL_DIR = ".claude/skills";

/**
 * Where a skill's body actually lives. `.claude/skills/<name>` is a symlink into
 * this directory (#1142), so a failure message has to name the real file — telling
 * someone to edit the symlink is telling them to edit the wrong path.
 */
export const SKILL_SOURCE_DIR = ".github/skills";

/**
 * Model aliases Claude Code accepts in `model:`, plus `inherit` (the default,
 * meaning "the session model"). A full model ID such as `claude-opus-5` is also
 * legal, so anything containing a `-` is allowed through as an explicit ID
 * rather than rejected — the check is aimed at typos like `sonnnet`, not at
 * second-guessing a pinned model.
 */
export const MODEL_ALIASES = ["inherit", "haiku", "sonnet", "opus", "fable"];

/**
 * Frontmatter keys this repo's agents use. An unrecognised key is reported as
 * a WARNING, not a failure: Claude Code supports more fields than METIS
 * currently uses (`permissionMode`, `maxTurns`, `skills`, `hooks`, `effort`,
 * `isolation`, `color`, `background`, `initialPrompt`), and a check that failed
 * on an unused-but-valid field would block adopting one.
 */
export const KNOWN_FIELDS = [
  "name",
  "description",
  "tools",
  "disallowedTools",
  "model",
  "mcpServers",
  "memory",
  "permissionMode",
  "maxTurns",
  "skills",
  "hooks",
  "effort",
  "isolation",
  "color",
  "background",
  "initialPrompt",
];

/** Memory scopes Claude Code accepts in `memory:`. */
export const MEMORY_SCOPES = ["user", "project", "local"];

/** Root of the project-scope agent memory stores, one directory per agent name. */
export const MEMORY_DIR = ".claude/agent-memory";

/** The index file inside a store — the only part loaded on every dispatch. */
export const MEMORY_INDEX_FILE = "MEMORY.md";

/**
 * Scopes whose store lives inside the repository and can therefore be asserted
 * from here. `user` stores live under `~/.claude/agent-memory/` — per-machine,
 * outside the tree. `local` stores live under `.claude/agent-memory-local/` and
 * are deliberately *not* committed. Only `project` is both in-tree and tracked,
 * and tracked is the part that matters: see `checkMemoryStore` rule B.
 */
export const REPO_SCOPED_MEMORY = ["project"];

/** The tools Claude Code's memory protocol actually instructs an agent to use. */
export const MEMORY_WRITE_TOOLS = ["Write", "Edit"];

/**
 * Tool names that resolve to **nothing** in this Claude Code build, so naming
 * one in `tools:` is dead text (Issue #1168).
 *
 * Measured on CLI 2.1.220 by reading the resolved tool list off the
 * `system`/`init` line of `claude -p --agent <name> --output-format stream-json`,
 * which is a mechanical list rather than a model's self-report:
 *
 *  - `tools: Read, Bash, Glob, Grep` resolved to exactly `["Read","Bash"]`.
 *  - A **default session with no agent and no restrictions** — the widest tool
 *    set the build offers — contained no `Glob` and no `Grep` either, and no
 *    settings file removes them. The registry exposes `ToolSearch` instead.
 *    (Precisely: this is **non-exposure**, not absence. `strings` on the 2.1.220
 *    binary does show a `Glob` definition behind a conditional. Whether exposure
 *    is gated on configuration was not determined — and does not matter to this
 *    rule, because in every shape measured here the declaration is dead text.)
 *  - A live `code-review` dispatch calling them got
 *    *"No such tool available: Glob. Glob is not available in this session — find
 *    files with `find` via the Bash tool instead."* — a designed error with a
 *    designed fallback, i.e. a deliberate removal rather than a transient gap.
 *
 * This is the #1162/#1163 class again: a capability declared in frontmatter that
 * the harness never delivers, failing only at call time deep inside a dispatch.
 *
 * **This list is build-specific and will go stale.** If a later build restores
 * these tools the rule turns into a false positive — which is the safe direction,
 * because it fails loudly and names the measurement to redo, rather than silently
 * blessing an instruction that does nothing.
 */
export const UNAVAILABLE_TOOLS = ["Glob", "Grep"];

/**
 * Is a tool reachable for an agent with this allowlist and denylist, **as far as
 * frontmatter alone can tell**?
 *
 * `disallowedTools` is applied first, so it beats both an allowlist entry and the
 * inherit-everything default (#1163, measured).
 *
 * `toolBases` distinguishes three states, and the distinction is load-bearing:
 *
 *  - `null`/`undefined` — no `tools:` key at all, which inherits every tool.
 *  - a non-empty array — an allowlist, which genuinely restricts: `tools: Read,
 *    Bash` resolved to exactly `["Read","Bash"]` (#1168, measured).
 *  - an **empty array** — a `tools:` key present with no value. Measured, that
 *    resolves to a tool list of length **0**, not to inheritance, so nothing is
 *    reachable. The previous implementation collapsed this into the `null` case
 *    and reported the opposite of the truth.
 *
 * **Two things this cannot decide, so callers must not ask it to:**
 *
 *  1. Whether the build implements the tool at all — see `UNAVAILABLE_TOOLS`. An
 *     allowlist entry is a declaration, never a guarantee.
 *  2. Whether the **memory protocol** injects a write tool past an allowlist that
 *     omits it. It does — use `isMemoryWriteReachable` for that question.
 *
 * @param {string} tool bare tool name, e.g. "Write"
 * @param {string[] | null | undefined} toolBases base names from `tools:`; null
 *   means the key is absent, `[]` means present-but-empty
 * @param {string[]} disallowedBases base names from `disallowedTools:`
 * @returns {boolean}
 */
export function isToolReachable(tool, toolBases, disallowedBases) {
  if (disallowedBases.includes(tool)) return false;
  if (toolBases === null || toolBases === undefined) return true;
  return toolBases.includes(tool);
}

/**
 * Can an agent with a declared `memory:` scope reach this write tool?
 *
 * Only `disallowedTools` can take it away. An allowlist that merely *omits*
 * `Write`/`Edit` does **not**, because Claude Code's memory protocol injects them
 * for an agent that declares a memory scope.
 *
 * #1163 assumed the allowlist arm applied too, but its probe subject
 * (`code-review`) held an allowlist omission *and* a denylist at once, so the
 * observation could not attribute the denial to either arm. Measured separately
 * for #1168 on CLI 2.1.220, again off the `system`/`init` tool list — a clean 2x2
 * that attributes it:
 *
 * | `tools:`          | `disallowedTools:` | `memory:` | resolved                      |
 * |-------------------|--------------------|-----------|-------------------------------|
 * | `Read, Bash`      | —                  | `project` | `Read, Bash, ` **`Write, Edit`** |
 * | `Read, Bash`      | —                  | —         | `Read, Bash`                  |
 * | *(omitted)*       | `Write, Edit`      | `project` | full set, **no** Write/Edit    |
 *
 * Rows 1 and 2 differ only in `memory:`, so the injection is attributable to it.
 * Row 3 is #1163's finding, and it survives: the denial still wins.
 *
 * So the writability rule fires on the **denylist only**. Narrowing it costs
 * nothing today — no agent has the allowlist-omission shape — and prevents a
 * false positive against the first one that does.
 *
 * It takes no allowlist parameter deliberately: there is no allowlist argument to
 * pass, so the arm cannot be quietly reintroduced at a call site.
 *
 * @param {string} tool one of `MEMORY_WRITE_TOOLS`
 * @param {string[]} [disallowedBases] base names from `disallowedTools:`
 * @returns {boolean}
 */
export function isMemoryWriteReachable(tool, disallowedBases = []) {
  return !disallowedBases.includes(tool);
}

/**
 * Split the NUL-separated output of `git ls-files -z` into paths.
 *
 * `-z` rather than newline-separated output because a newline is a legal
 * character in a filename, and because without `-z` git quotes and escapes any
 * path outside plain ASCII — which would silently stop matching
 * `memoryIndexPath()`. Kept pure and here rather than in the runner so the
 * parsing has tests; the runner only supplies the bytes.
 *
 * @param {string} stdout
 * @returns {string[]}
 */
export function parseTrackedPaths(stdout) {
  if (typeof stdout !== "string") return [];
  return stdout.split("\0").filter((entry) => entry.length > 0);
}

/**
 * The repo-relative path of an agent's project-scope memory index.
 *
 * @param {string} name agent file stem
 * @returns {string}
 */
export function memoryIndexPath(name) {
  return `${MEMORY_DIR}/${name}/${MEMORY_INDEX_FILE}`;
}

/**
 * Which of these agents has a project-scope memory store with a **committed**
 * `MEMORY.md` index?
 *
 * Two things are deliberately not the signal:
 *
 *  - The *directory*. The harness creates an empty one at dispatch (#1163), so an
 *    unpopulated store is indistinguishable from a working one by `ls` alone.
 *  - **Presence on disk.** #1163 implemented the probe as `fs.existsSync`, which
 *    an *untracked* `MEMORY.md` satisfies — silencing the rule while the store
 *    stays invisible to every other checkout, i.e. exactly the guarantee the
 *    failure message promises. The probe must therefore ask git (#1168).
 *
 * The probe stays injected rather than read here so that this — the one decision
 * that says whether a declared store is real — is unit-testable without a
 * repository, instead of living in the runner where nothing could falsify it. The
 * runner supplies a git-backed probe; see `parseTrackedPaths`.
 *
 * @param {string[]} agentNames
 * @param {(repoRelativePath: string) => boolean} isTracked
 * @returns {string[]}
 */
export function selectMemoryIndexes(agentNames, isTracked) {
  if (!Array.isArray(agentNames) || typeof isTracked !== "function") return [];
  return agentNames.filter((name) => isTracked(memoryIndexPath(name)));
}

/**
 * Assert that a declared `memory:` scope names a store the agent can actually
 * use (Issue #1163).
 *
 * ## Why this is a failure and not a warning
 *
 * #1146 granted `memory: project` to `code-review` and `ui-vision` on sound
 * reasoning, while both also declared `disallowedTools: Write, Edit`. The result
 * was a capability that was declared and unreachable, and it failed **in
 * silence** — which is the whole problem. Measured first-hand on a live
 * `code-review` dispatch (#1163):
 *
 *  - Claude Code injects the **entire** memory protocol into the system prompt
 *    regardless: roughly a third of the agent's instructions, telling it to
 *    "write to it directly with the Write tool".
 *  - The harness creates the store **directory** at dispatch — it appeared
 *    empty and freshly timestamped mid-probe — but creates no `MEMORY.md`.
 *  - The agent's own `Write` call then fails with *"No such tool available:
 *    Write. Write exists but is not enabled in this context."* So the docs'
 *    claim that "Read, Write, and Edit tools are automatically enabled so the
 *    subagent can manage its memory files" does **not** override the agent's
 *    own `tools:`/`disallowedTools:`.
 *
 * Nothing errors unless the agent happens to attempt the write, so the only
 * visible symptom is a store that stays permanently empty. Hence two rules:
 *
 *  - **writability** — a declared scope whose write tools are **denied** can
 *    never be populated by the agent it belongs to. This is the root cause, and
 *    it is decidable from frontmatter alone. Note it is the *denial* that does
 *    it, not a mere allowlist omission: see `isMemoryWriteReachable` for the 2x2
 *    that separates the two arms (#1168).
 *  - **a tracked index** — a `project` store is shared *through version
 *    control*, and the harness contributes only an empty directory. With no
 *    tracked `MEMORY.md` every dispatch starts blank in every clone and
 *    worktree, so the declared store is not reachable in the sense that
 *    matters. An index that exists on disk but is untracked satisfies nothing
 *    while looking exactly like success — which is this repo's demonstrated
 *    failure mode, not a hypothetical: `ddbbc6ba` exists solely to commit 23
 *    orphaned memory files, and #1163's own branch found a memory file on disk
 *    and absent from `MEMORY.md`. Hence `memoryIndexes` must be sourced from
 *    git, not from `fs.existsSync` (#1168).
 *
 *    Note the probe answers the **index**, not `HEAD`: a `git add`-ed but
 *    not-yet-committed store passes. That is deliberate — requiring `HEAD` would
 *    false-fail the very commit that first adds a store, and a fresh clone (CI)
 *    still catches an index that never landed. The trade is that a tracked but
 *    locally *deleted* index now passes where `fs.existsSync` would have failed
 *    it; that state is loud in `git status` and is not the failure mode that has
 *    ever bitten this repo.
 *
 * Both are satisfied by `code-issue`, whose store demonstrably works.
 *
 * @param {object} input
 * @param {string} input.name agent file stem
 * @param {string | undefined} input.memory declared scope, "" or undefined when absent
 * @param {string[]} [input.disallowedBases] base names from `disallowedTools:`
 * @param {string[]} [input.memoryIndexes] agent names whose
 *   `.claude/agent-memory/<name>/MEMORY.md` is **tracked in git**
 * @returns {string[]} problems
 */
export function checkMemoryStore({ name, memory, disallowedBases = [], memoryIndexes = [] }) {
  /** @type {string[]} */
  const problems = [];
  if (typeof memory !== "string" || memory.length === 0) return problems;
  // An unrecognised scope is already reported by checkAgent; saying it twice in
  // different words is noise, and "no store for scope <typo>" is misleading.
  if (!MEMORY_SCOPES.includes(memory)) return problems;

  const reachable = MEMORY_WRITE_TOOLS.filter((tool) =>
    isMemoryWriteReachable(tool, disallowedBases),
  );
  if (reachable.length === 0) {
    problems.push(
      `${name}: declares memory: ${memory} but disallowedTools denies both Write and Edit, so the ` +
        `store can never be populated by the agent itself — Claude Code injects the whole memory ` +
        `protocol anyway and the failure is silent (#1163). Either stop denying a write tool, or ` +
        `drop the memory: declaration and have the agent report durable findings to its caller.`,
    );
  }

  if (REPO_SCOPED_MEMORY.includes(memory) && !memoryIndexes.includes(name)) {
    problems.push(
      `${name}: declares memory: ${memory} but ${memoryIndexPath(name)} is not tracked in git. ` +
        `A project-scope store is shared through version control and the harness creates only an ` +
        `empty directory at dispatch, so an index that is missing — or merely uncommitted — means ` +
        `every clone and worktree starts blank (#1163, #1168). Run ` +
        `"git add ${memoryIndexPath(name)}" and commit it, or drop the memory: declaration.`,
    );
  }

  return problems;
}

/**
 * The lossless overflow file for a store: superseded pointers move here instead
 * of being deleted (Issue #1206).
 *
 * Claude Code loads **only** `MEMORY.md` into a dispatch's context — the memory
 * protocol says so in as many words ("`MEMORY.md` is always loaded into your
 * conversation context"), and the per-memory files are read on demand. So a
 * sibling file in the same directory costs nothing per dispatch, which is what
 * makes it a safe place to retire an entry to. The pointer survives in the
 * repository; only its claim on the per-dispatch budget ends.
 */
export const MEMORY_ARCHIVE_FILE = "ARCHIVE.md";

/**
 * Is one path segment part of a memory entry's path?
 *
 * Dot-prefixed segments are excluded so a `.DS_Store` or a stray `.git/` cannot
 * fail a gate nobody can satisfy, and `..` is excluded so a pointer cannot climb
 * out of its own store. Exported because the runner applies the same rule when
 * it decides which *directories* to descend into — see `memoryEntryPath`.
 *
 * @param {string} segment
 * @returns {boolean}
 */
export function isMemoryPathSegment(segment) {
  return (
    typeof segment === "string" &&
    segment.length > 0 &&
    segment !== "." &&
    segment !== ".." &&
    !segment.startsWith(".")
  );
}

/**
 * **The one predicate both sides of the store check run** (Issue #1206).
 *
 * The bug this exists to prevent: the disk side used to enumerate through
 * `Dirent.isFile() && name.endsWith(".md")` while the pointer side accepted any
 * link target, and two enumeration predicates that disagree is #1192 exactly.
 * Measured on the real runner, that asymmetry gave four different answers to one
 * question — an unindexed non-`.md` file, an unindexed symlinked `.md`, and an
 * unindexed `.md` one directory down all exited **0 silently**, while the
 * identical regular top-level `.md` exited 1; and the mirror image was worse than
 * silence, reporting a pointer to a symlinked or subdirectory file that genuinely
 * exists as *"which does not exist"*. No mutation catches it, because the defect
 * is in a filter expression rather than in control flow.
 *
 * So both directions now key on this function's answer: the runner keeps a file
 * only if this returns a path, and `checkMemoryIndex` resolves a pointer only if
 * this returns a path — a pointer this rejects is reported as *not a memory
 * entry*, which is a different and accurate message from *does not exist*.
 *
 * Extension-agnostic on purpose. Restricting to `.md` is what made "file on disk,
 * loaded by nothing" invisible for every other extension, and that is the #1163
 * shape #1206 exists to catch.
 *
 * @param {string | null | undefined} rawPath store-relative, either separator
 * @returns {string | null} the canonical store-relative path, or null
 */
export function memoryEntryPath(rawPath) {
  if (typeof rawPath !== "string" || rawPath.length === 0) return null;
  const segments = rawPath.replace(/\\/g, "/").split("/");
  if (!segments.every(isMemoryPathSegment)) return null;
  const normalized = segments.join("/");
  if (normalized === MEMORY_INDEX_FILE || normalized === MEMORY_ARCHIVE_FILE) return null;
  return normalized;
}

/**
 * How many bytes of `MEMORY.md` a dispatch can actually read.
 *
 * **Provenance, so the number below is not folklore — and so its weakness is
 * visible.** The index is injected by the harness through the same path as a
 * file read, and that path truncates at ~25,000 bytes (24.41 KiB, which is where
 * #1206's "~24.4 KB" comes from). Past that the index is silently *not read* —
 * nothing errors, the files stay on disk, and every dispatch starts blind while
 * believing it has recall.
 *
 * **This figure is reported by #1206 and is not independently verifiable from
 * this repository.** Nothing here records the measurement, and the 543 bytes of
 * headroom quoted alongside it is *derived* from the limit rather than evidence
 * for it — so do not read the two as corroborating each other. It is a property
 * of the harness build, it can move, and confirming it would mean executing the
 * harness, not reading code.
 *
 * **How to re-measure it, so the caveat is actionable rather than permanent.**
 * Write a throwaway store whose `MEMORY.md` is padded to a known byte length and
 * whose *last* line carries a unique token; dispatch an agent scoped to it and
 * ask it to quote that line back. The largest padded size at which the token
 * comes back is the limit — bisect between a size that returns it and one that
 * does not. Whoever runs it should put the number, the date and the harness
 * version here and delete this paragraph's premise.
 *
 * That uncertainty is the whole reason the budget below is a **fraction** of
 * this rather than an independent magic number: a wrong limit stays wrong in one
 * place, and one edit moves everything derived from it.
 */
export const MEMORY_INDEX_READ_LIMIT_BYTES = 25_000;

/**
 * The budget, as a fraction of the read limit.
 *
 * 70% (17,500 bytes) buys the margin that a hard limit cannot. The measured
 * growth on this store was **+3,847 bytes and +16 entries in one day** — ~240
 * bytes of *file growth* per entry added (#1206), which is not the same as an
 * entry's length and is the larger of the two, since adding an entry also
 * reworks its neighbours — and a hand-compaction from 23,536 to 17,188 bytes was
 * undone inside 24 hours.
 *
 * A gate that fires *at* the cliff fires when the index is already unreadable.
 * The 30% reserve is 7,500 bytes: **~50 entries at the 150-byte cap**, or ~31 at
 * the observed 240-byte growth rate. That is runway enough to notice and archive
 * rather than to firefight, which is the only thing the reserve has to buy.
 */
export const MEMORY_INDEX_BUDGET_FRACTION = 0.7;

/**
 * The budget in bytes. Derived — do not write this number down anywhere else.
 *
 * The unit test on this pins **consistency, not computation**: `expect(BUDGET)
 * .toBe(Math.floor(LIMIT * FRACTION))` is a numeric equality, and a hand-typed
 * `17_500` satisfies it exactly as well as the expression does (measured — both
 * constants replaced by literals, 1064/1064 still green). What it does catch is
 * the *staleness* that hardcoding causes: with literals in place, moving
 * `MEMORY_INDEX_READ_LIMIT_BYTES` fails the test. Since the read limit is the one
 * input expected to move, that is most of the value — but the guarantee is "a
 * stale literal fails the next time the limit moves", not "a literal cannot be
 * written here".
 */
export const MEMORY_INDEX_BUDGET_BYTES = Math.floor(
  MEMORY_INDEX_READ_LIMIT_BYTES * MEMORY_INDEX_BUDGET_FRACTION,
);

/**
 * Warn from 90% of budget (15,750 bytes). Deliberately close to the failure
 * point: a warning that fires the moment a compaction finishes is noise, and
 * noise is how a warning stops being read.
 */
export const MEMORY_INDEX_WARN_FRACTION = 0.9;

/** The warning threshold in bytes. Derived from the budget, like everything else. */
export const MEMORY_INDEX_WARN_BYTES = Math.floor(
  MEMORY_INDEX_BUDGET_BYTES * MEMORY_INDEX_WARN_FRACTION,
);

/**
 * Longest a single index entry may be, in bytes.
 *
 * The budget alone is a commons: it is spent by whoever writes last, and every
 * agent has an incentive to explain itself at length. 150 bytes is roughly the
 * mean entry on this store when the cap was introduced (140 bytes over 173
 * entries) and comfortably above its median (125), so it prices the outliers —
 * 42 entries exceeded it and the longest was **301 bytes**, two entries' worth of
 * budget spent by one. This is the same discipline #1191 applied to changelog
 * fragments, for the same reason.
 *
 * Bytes, not characters, because the budget is in bytes and an em dash is three
 * of them. Counting characters here would let a cap-conforming entry overrun the
 * budget it is meant to protect.
 */
export const MEMORY_ENTRY_MAX_BYTES = 150;

/**
 * UTF-8 byte length. The read limit and the budget are both byte quantities, and
 * this index is full of em dashes and arrows, so `String.length` would understate
 * every line it matters for.
 *
 * @param {string} text
 * @returns {number}
 */
export function utf8Bytes(text) {
  return typeof text === "string" ? Buffer.byteLength(text, "utf8") : 0;
}

/**
 * The shape of one index line: `- [Title](file.md) — hook`.
 *
 * The link target is captured so the pointer can be resolved against disk in both
 * directions. Anything else beginning with a `-` bullet is *malformed* rather than
 * ignored — see `parseMemoryPointers`.
 */
const MEMORY_POINTER_RE = /^-\s+\[([^\]]*)\]\(([^)\s]+)\)/;

/**
 * Split an index (or archive) into resolvable pointers and malformed bullets.
 *
 * Malformed bullets are reported rather than skipped, and that is not tidiness.
 * A bullet with no link satisfies neither the pointer rule (nothing to resolve)
 * nor, if it were skipped, the per-entry cap — so "skip what you cannot parse"
 * would leave one unbounded line able to spend the whole budget by itself. The
 * cap has to apply to every line that is trying to be an entry.
 *
 * Non-bullet lines — a heading, a blank line, an explanatory sentence — are
 * neither pointers nor malformed. They still count toward the budget, which is
 * measured over the whole file rather than over the entries.
 *
 * @param {string | null | undefined} text
 * @returns {{ pointers: Array<{ lineNumber: number, line: string, title: string, file: string, bytes: number }>, malformed: Array<{ lineNumber: number, line: string, bytes: number }> }}
 */
export function parseMemoryPointers(text) {
  /** @type {Array<{ lineNumber: number, line: string, title: string, file: string, bytes: number }>} */
  const pointers = [];
  /** @type {Array<{ lineNumber: number, line: string, bytes: number }>} */
  const malformed = [];
  if (typeof text !== "string") return { pointers, malformed };

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line.startsWith("-")) continue;
    const match = MEMORY_POINTER_RE.exec(line);
    if (match) {
      pointers.push({
        lineNumber: i + 1,
        line,
        title: match[1],
        file: match[2],
        bytes: utf8Bytes(lines[i]),
      });
    } else {
      malformed.push({ lineNumber: i + 1, line, bytes: utf8Bytes(lines[i]) });
    }
  }
  return { pointers, malformed };
}

/**
 * Assert that one agent-memory store's index stays readable, stays itemised, and
 * still points at what is on disk (Issue #1206).
 *
 * ## The failure this exists to prevent
 *
 * `MEMORY.md` is the only file loaded on every dispatch, and it is loaded through
 * a path that **truncates without erroring**. Past the limit the whole index stops
 * being read: no message, no missing-file error, just an agent that starts cold
 * believing it has recall. The partial form of this has already cost a run — one
 * memory file sat on disk while absent from the index, nothing loaded it, and a
 * second implementer was dispatched onto work a prior agent already had open.
 *
 * ## Why an absent or empty store passes
 *
 * The harness creates a store *directory* at dispatch whether or not the agent has
 * a `memory:` scope (#1163 measured this), so `.claude/agent-memory/code-review/`
 * exists and holds nothing. Failing on that would fail on every clean checkout.
 * "Nothing here" is a legitimate state; "something here that cannot be read" is
 * not, and the two are separated explicitly below rather than collapsed — a
 * default that means *nothing to check* is how four gates in this repo shipped
 * fail-open in one week (#1168, #1178, #1180, #1192).
 *
 * So each of these is a **failure**, not a pass:
 *
 *  - an index present on disk that cannot be read (a zero-length read is not the
 *    same as a small file),
 *  - memory files present with no index at all — they are unreachable,
 *  - an index whose pointers name files that do not exist,
 *  - files that exist and are named by neither the index nor the archive,
 *  - a pointer naming something that is not a memory entry at all,
 *  - the same pointer twice in the index, or in the index and the archive both.
 *
 * @param {object} input
 * @param {string} input.store store directory name, i.e. the agent name
 * @param {boolean} [input.indexPresent] a directory entry named `MEMORY.md` exists
 * @param {string | null} [input.index] its contents, or null when unreadable
 * @param {string | null} [input.archive] `ARCHIVE.md` contents, or null when absent
 * @param {string[]} [input.files] store-relative memory file paths, as
 *   `memoryEntryPath` canonicalises them — the runner has already excluded the
 *   index, the archive and anything that predicate rejects
 * @returns {{ problems: string[], warnings: string[] }}
 */
export function checkMemoryIndex({
  store,
  indexPresent = false,
  index = null,
  archive = null,
  files = [],
}) {
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const warnings = [];

  const storePath = `${MEMORY_DIR}/${store}`;
  const indexPath = `${storePath}/${MEMORY_INDEX_FILE}`;
  const archivePath = `${storePath}/${MEMORY_ARCHIVE_FILE}`;
  const fileNames = Array.isArray(files) ? files : [];

  // Absent or empty store — genuinely nothing to check. Note this arm requires
  // ALL THREE to be empty: an archive or a stray memory file with no index is a
  // store, and falls through to the rules below.
  if (!indexPresent && fileNames.length === 0 && archive === null) return { problems, warnings };

  if (indexPresent && typeof index !== "string") {
    problems.push(
      `${indexPath} exists but could not be read. An unreadable index is not an index under ` +
        `budget — it is a store whose entire recall is unavailable, and it must not pass (#1206).`,
    );
    return { problems, warnings };
  }

  if (!indexPresent) {
    problems.push(
      `${storePath}/ holds ${fileNames.length} memory file(s) but no ${MEMORY_INDEX_FILE}: ` +
        `${fileNames.slice(0, 5).join(", ")}${fileNames.length > 5 ? ", …" : ""}. The index is the ` +
        `only file a dispatch loads, so an unindexed file is never read (#1206).`,
    );
    return { problems, warnings };
  }

  const indexText = /** @type {string} */ (index);
  const bytes = utf8Bytes(indexText);
  if (bytes > MEMORY_INDEX_BUDGET_BYTES) {
    problems.push(
      `${indexPath} is ${bytes} bytes, over the ${MEMORY_INDEX_BUDGET_BYTES}-byte budget ` +
        `(${Math.round(MEMORY_INDEX_BUDGET_FRACTION * 100)}% of the ~${MEMORY_INDEX_READ_LIMIT_BYTES}-byte ` +
        `read limit). Past the read limit the index is silently NOT loaded and every ${store} ` +
        `dispatch starts blind. Move superseded entries to ${archivePath} — the archive is not ` +
        `loaded into context, so an entry can leave the index without leaving the repository.`,
    );
  } else if (bytes >= MEMORY_INDEX_WARN_BYTES) {
    warnings.push(
      `${indexPath} is ${bytes} bytes, ${MEMORY_INDEX_BUDGET_BYTES - bytes} under the ` +
        `${MEMORY_INDEX_BUDGET_BYTES}-byte budget. Archive superseded entries to ${archivePath} ` +
        `before it breaches (#1206).`,
    );
  }

  const { pointers, malformed } = parseMemoryPointers(indexText);

  for (const entry of malformed) {
    // A horizontal rule is the one malformed bullet whose author will not
    // recognise the generic diagnosis — "--- is a bullet" reads as nonsense. The
    // behaviour is unchanged and still fails closed; only the message differs.
    if (/^-{3,}$/.test(entry.line)) {
      problems.push(
        `${indexPath}:${entry.lineNumber} is a markdown horizontal rule, which parses as a bullet ` +
          `and can be neither resolved against disk nor exempted from the ` +
          `${MEMORY_ENTRY_MAX_BYTES}-byte cap. The index is a flat list of pointers — remove it.`,
      );
      continue;
    }
    problems.push(
      `${indexPath}:${entry.lineNumber} is a bullet but not a pointer. Every entry must be ` +
        `"- [Title](file.md) — hook" so it can be resolved against disk and measured against the ` +
        `${MEMORY_ENTRY_MAX_BYTES}-byte cap; an indented sub-bullet is a bullet too, and the index ` +
        `holds no nesting: ${truncateForMessage(entry.line)}`,
    );
  }

  for (const entry of pointers) {
    if (entry.bytes > MEMORY_ENTRY_MAX_BYTES) {
      problems.push(
        `${indexPath}:${entry.lineNumber} is ${entry.bytes} bytes, over the ` +
          `${MEMORY_ENTRY_MAX_BYTES}-byte per-entry cap. The index is a shared budget; one entry ` +
          `cannot spend it. Shorten the hook — the detail belongs in ${storePath}/${entry.file}. ` +
          `Entry: ${truncateForMessage(entry.line)}`,
      );
    }
  }

  // --- both directions, over ONE set of names --------------------------------
  // Index and archive are unioned rather than checked separately: archiving is
  // what the budget rule tells the reader to do, so an archived pointer has to
  // count as resolved or the two rules would contradict each other.
  //
  // Every name on BOTH sides goes through `memoryEntryPath` — the disk side does
  // the same in the runner. Two enumeration predicates that disagree is how this
  // gate shipped four different answers to one question (#1192, and see that
  // function). A pointer the predicate rejects gets its own message: "not a
  // memory entry" is a different fault from "does not exist", and reporting the
  // second for the first is what sent a reader hunting for a file that was there
  // all along.
  /** @type {Set<string>} */
  const indexed = new Set();
  for (const entry of pointers) {
    const resolved = memoryEntryPath(entry.file);
    if (resolved === null) {
      problems.push(
        `${indexPath}:${entry.lineNumber} points at "${entry.file}", which is not a memory entry ` +
          `in ${storePath}/. A pointer names one file inside the store: no leading or parent ` +
          `path segments, no dot-files, and neither ${MEMORY_INDEX_FILE} nor ${MEMORY_ARCHIVE_FILE} ` +
          `itself (#1206).`,
      );
      continue;
    }
    if (indexed.has(resolved)) {
      problems.push(
        `${indexPath}:${entry.lineNumber} lists "${resolved}" a second time. The index is a shared ` +
          `${MEMORY_INDEX_BUDGET_BYTES}-byte budget and a duplicate pays for the same memory twice ` +
          `(#1206).`,
      );
      continue;
    }
    indexed.add(resolved);
  }

  const archived = new Set(
    parseMemoryPointers(archive)
      .pointers.map((entry) => memoryEntryPath(entry.file))
      .filter(
        /** @returns {file is string} */
        (file) => file !== null,
      ),
  );
  const onDisk = new Set(fileNames);

  for (const file of [...indexed].sort()) {
    if (!onDisk.has(file)) {
      problems.push(
        `${indexPath} points at "${file}", which does not exist in ${storePath}/. A pointer that ` +
          `resolves to nothing is a memory the reader believes it has (#1206).`,
      );
    }
    // An entry in both files looks retired while still being loaded, so
    // "I archived it" would stop meaning "it left the index" — and that
    // equivalence is the only thing the archive rule has to be trusted on.
    if (archived.has(file)) {
      problems.push(
        `${indexPath} still lists "${file}" although ${archivePath} has retired it. An entry named ` +
          `by both is still loaded on every dispatch, so it is not retired — delete one of the ` +
          `two lines (#1206).`,
      );
    }
  }

  for (const file of [...onDisk].sort()) {
    if (indexed.has(file) || archived.has(file)) continue;
    problems.push(
      `${storePath}/${file} is in neither ${MEMORY_INDEX_FILE} nor ${MEMORY_ARCHIVE_FILE}, so ` +
        `nothing will ever load it. Index it, or archive the pointer to ${archivePath} (#1206).`,
    );
  }

  return { problems, warnings };
}

/**
 * Keep a failure message readable when the offending line is the problem.
 *
 * @param {string} line
 * @returns {string}
 */
function truncateForMessage(line) {
  return line.length <= 80 ? line : `${line.slice(0, 77)}...`;
}

/**
 * Run `checkMemoryIndex` over every store the runner found on disk.
 *
 * @param {Array<{ store: string, indexPresent?: boolean, index?: string | null, archive?: string | null, files?: string[] }>} stores
 * @returns {{ problems: string[], warnings: string[] }}
 */
export function checkMemoryIndexes(stores) {
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const warnings = [];
  if (!Array.isArray(stores)) return { problems, warnings };
  for (const store of [...stores].sort((a, b) => String(a.store).localeCompare(String(b.store)))) {
    const result = checkMemoryIndex(store);
    problems.push(...result.problems);
    warnings.push(...result.warnings);
  }
  return { problems, warnings };
}

/**
 * Cross-check the two independent answers to "which stores exist".
 *
 * `memoryIndexes` comes from **git** (`git ls-files`), `memoryStores` comes from
 * **disk** (`readdirSync`). They are gathered separately and they must agree, so
 * a caller that forgets to gather the second one — leaving `checkMemoryIndexes`
 * with an empty list and every budget rule silently unrun — is caught here rather
 * than exiting 0.
 *
 * That is the exact defect shape this repo shipped four times in a week: #1168's
 * `skillFiles` defaulting to `{}`, #1180's `readSkillNames` swallowing a missing
 * directory. Both were a default that means "nothing to check". A default cannot
 * be made safe on its own, so it is made *contradictory* instead: the two sources
 * disagreeing is itself the failure, and neither is allowed to win quietly.
 *
 * One-directional, and deliberately so. Git-tracked-but-not-on-disk is the
 * fail-open direction and fails here. On-disk-but-not-in-git is a store being
 * created in the working tree — a normal intermediate state, and already rule B's
 * business for any agent that declares the scope.
 *
 * @param {object} input
 * @param {string[]} [input.memoryIndexes] store names with a git-tracked index
 * @param {Array<{ store: string }>} [input.memoryStores] stores read from disk
 * @returns {string[]} problems
 */
export function checkMemoryStoresGathered({ memoryIndexes = [], memoryStores = [] }) {
  /** @type {string[]} */
  const problems = [];
  const gathered = new Set(
    (Array.isArray(memoryStores) ? memoryStores : []).map((entry) => entry?.store),
  );
  for (const name of Array.isArray(memoryIndexes) ? memoryIndexes : []) {
    if (gathered.has(name)) continue;
    problems.push(
      `${memoryIndexPath(name)} is tracked in git but no store was read from ${MEMORY_DIR}/, so ` +
        `the budget and per-entry checks did not run for "${name}". Either the directory is ` +
        `missing from this checkout or the caller failed to gather it — both must fail loudly ` +
        `rather than read as "under budget" (#1206).`,
    );
  }
  return problems;
}

/**
 * The literal token a memory-less agent uses to hand a durable finding to its
 * caller. Matched as a literal rather than a pattern because it is a protocol
 * marker: the agent bodies, the receiver rule and the caller's instruction all
 * have to agree on the same characters.
 */
export const DURABLE_FINDING_MARKER = "Durable finding:";

/**
 * The file a dispatching agent is guaranteed to have loaded, and therefore the
 * only place a receiver instruction can be relied on to arrive.
 */
export const CALLER_CONTRACT_FILE = "CLAUDE.md";

/**
 * Which agents' bodies promise `Durable finding:` output?
 *
 * The **body** only, exactly like the skill rule: a `description` mentioning the
 * channel is prose *about* the agent, not an instruction *to* it.
 *
 * @param {Record<string, string | null>} agentFiles contents keyed by agent name
 * @returns {string[]} sorted agent names
 */
export function findDurableFindingPromisers(agentFiles) {
  if (agentFiles === null || typeof agentFiles !== "object") return [];
  return Object.keys(agentFiles)
    .filter((name) => {
      const text = agentFiles[name];
      return typeof text === "string" && stripFrontmatter(text).includes(DURABLE_FINDING_MARKER);
    })
    .sort();
}

/**
 * Assert that the `Durable finding:` channel has a receiver the caller actually
 * loads (Issue #1168).
 *
 * ## Why this is a rule and not a convention
 *
 * #1163 removed `memory:` from `code-review` and `ui-vision` — correctly, since
 * their write tools are denied — and replaced the capability with a protocol:
 * the agent emits `Durable finding:` lines and **the caller persists them**. The
 * receiving instruction was then written into exactly one place,
 * `.github/skills/code-issue/SKILL.md`, which only a `code-issue` dispatch loads.
 *
 * But `code-issue` is not what dispatches a review. #1145 retired the
 * orchestrator subagent so that *the main session* sequences work and dispatches
 * `code-review` and `ui-vision` directly — and a review-only dispatch has no
 * `code-issue` in the loop at all. So on the path that actually calls these
 * agents, the receiver was documented nowhere. Demonstrated live on PR #1165: the
 * reviewer emitted three `Durable finding:` lines, could not persist them, and
 * they survived only because a human-facing session happened to notice.
 *
 * `CLAUDE.md` is the one file reloaded into every non-Explore subagent *and* read
 * by the main session, which is what makes it the only reliable receiver
 * location — and also why the instruction there must stay short, since it is paid
 * per delegation.
 *
 * The check is one-directional on purpose. A promise with no receiver loses data;
 * a receiver with no promiser is merely a spare instruction, and failing on it
 * would block removing the last promiser.
 *
 * @param {object} input
 * @param {Record<string, string | null>} input.agentFiles contents keyed by name
 * @param {string | null} [input.claudeMd] `CLAUDE.md` contents
 * @returns {string[]} problems
 */
export function checkDurableFindingReceiver({ agentFiles, claudeMd = null }) {
  const promisers = findDurableFindingPromisers(agentFiles);
  if (promisers.length === 0) return [];
  // Deliberately a bare substring test, so be precise about what it buys: it
  // catches the receiver being DELETED, not the bullet being gutted to a passing
  // mention. Any occurrence satisfies it — including one in a code fence. Also
  // requiring the store path was considered and rejected: MEMORY_DIR is named by
  // a neighbouring CLAUDE.md bullet anyway, so the conjunction would still pass a
  // gutted receiver while adding brittleness against reasonable rewordings. A
  // semantic check would need to judge prose, which a gate cannot do (#1169).
  if (typeof claudeMd === "string" && claudeMd.includes(DURABLE_FINDING_MARKER)) return [];

  return [
    `${promisers.join(", ")}: the body promises "${DURABLE_FINDING_MARKER}" output for the caller ` +
      `to persist, but ${CALLER_CONTRACT_FILE} never mentions it, so the caller is never told to ` +
      `receive it. The main session dispatches these agents directly (#1145), and it does not load ` +
      `any agent's skill — so a receiver documented only in a skill is documented nowhere on the ` +
      `path that calls them, and the finding dies with the subagent's context (#1168). Either ` +
      `document the receiver in ${CALLER_CONTRACT_FILE} or stop promising the channel.`,
  ];
}

/**
 * The literal the `Agent` tool takes to give a dispatched agent its **own** git
 * worktree.
 *
 * A literal rather than a pattern, for the same reason as
 * `DURABLE_FINDING_MARKER`: this is a protocol token, not prose. The instruction
 * written into a dispatch site and the parameter the tool actually accepts have
 * to be the same characters, so a rule that accepted `isolation: worktree` or
 * `isolation: 'worktree'` would be blessing a dispatch that does not isolate.
 * The false-positive direction — a rewording that means the right thing and
 * fails this check — is the safe one: it fails loudly and names the fix.
 */
export const WORKTREE_ISOLATION_MARKER = 'isolation: "worktree"';

/**
 * The agent the adversarial panel fans out — once per lens, concurrently, into
 * one tree until #1277.
 */
export const PANEL_VOTER_AGENT = "adversarial-reviewer";

/**
 * Telling an isolated voter to read a blob at `HEAD` is the one instruction that
 * `isolation: "worktree"` turns from harmless into actively wrong, so the two
 * rules ship together.
 *
 * Measured while implementing #1277, by the panel run on #1277 itself: the
 * harness creates each agent's worktree on a fresh branch **from `origin/main`**
 * (`git reflog show worktree-agent-<id>` prints "Created from origin/main"), and
 * `git worktree add` refuses a branch already checked out elsewhere — which the
 * implementer's branch always is. So a voter's `HEAD` is structurally the
 * *baseline*, and `git show HEAD:<path>` hands it the **pre-change** file. Two of
 * the three lenses independently filed that as blocking, each demonstrating it
 * from inside its own worktree.
 *
 * The literal is deliberately narrow. `origin/main...HEAD` is *not* banned: the
 * dispatcher legitimately runs `git diff --name-only origin/main...HEAD` in its
 * own tree to compute `shouldRunAdversarialPass`, and banning it there would be
 * the over-blocking failure this panel has a lens for. `git show HEAD:` has only
 * ever meant "read this blob at HEAD", and in a panel document it is only ever
 * addressed to a voter.
 */
export const PANEL_HEAD_BLOB_ANTIPATTERN = "git show HEAD:";

/**
 * The lens list, as **one** interpretation shared by both halves of this rule.
 *
 * The site finder and the checker read the same `lenses` input for different
 * purposes — one filters bodies with it, the other prints it in every failure
 * message — and two normalisations that disagree is #1192's defect shape. Here it
 * did not merely disagree: the finder guarded with `Array.isArray` and the checker
 * did not, so a non-array made the finder return no sites and then the checker's
 * own "no sites" message threw on `.join`. One function, one answer.
 *
 * @param {readonly string[] | unknown} lenses
 * @returns {string[]}
 */
function normalizeLenses(lenses) {
  return Array.isArray(lenses) ? lenses.filter((lens) => typeof lens === "string") : [];
}

/**
 * Which files tell a reader to dispatch the adversarial panel?
 *
 * **Derived, not listed.** A file is a dispatch site when its *body* names the
 * voter agent and names **every** lens in `LENSES` — and `LENSES` is imported
 * from `adversarial-tally-core.mjs`, the code that grades the panel, rather than
 * copied here. Renaming a lens therefore re-targets this rule automatically
 * instead of quietly un-targeting it; a hardcoded list of filenames is the
 * #1187 half-migration shape, which is the very thing AC4 of #1277 asked whether
 * a gate could replace.
 *
 * The body only, `description` excluded, exactly like `findDurableFindingPromisers`:
 * a description mentioning the panel is prose *about* a file, not an instruction
 * *in* it.
 *
 * The voter's own definition is excluded explicitly rather than by relying on it
 * not naming itself. It names all three lenses because it *is* briefed on all
 * three, and it is the agent being dispatched — not a place anyone reads to learn
 * how to dispatch it.
 *
 * @param {object} input
 * @param {Record<string, string | null>} [input.agentFiles] contents by agent name
 * @param {Record<string, string | null>} [input.skillFiles] SKILL.md contents by skill name
 * @param {readonly string[]} [input.lenses] the panel's lens slugs
 * @returns {Array<{ path: string, body: string }>} sorted, agents before skills
 */
export function findPanelDispatchSites({ agentFiles = {}, skillFiles = {}, lenses = LENSES }) {
  /** @type {Array<{ path: string, body: string }>} */
  const sites = [];
  const lensList = normalizeLenses(lenses);
  // No lenses is not "every file qualifies" — `every` over an empty list is true,
  // which would make every file naming the agent a dispatch site. A default that
  // silently widens is the mirror of one that silently empties (#1215).
  if (lensList.length === 0) return sites;

  /**
   * @param {string} sitePath
   * @param {string | null | undefined} text
   */
  function consider(sitePath, text) {
    if (typeof text !== "string") return;
    const body = stripFrontmatter(text);
    if (!body.includes(PANEL_VOTER_AGENT)) return;
    if (!lensList.every((lens) => body.includes(lens))) return;
    sites.push({ path: sitePath, body });
  }

  for (const name of Object.keys(agentFiles).sort()) {
    if (name === PANEL_VOTER_AGENT) continue;
    consider(`${AGENT_DIR}/${name}.md`, agentFiles[name]);
  }
  for (const name of Object.keys(skillFiles).sort()) {
    consider(`${SKILL_SOURCE_DIR}/${name}/SKILL.md`, skillFiles[name]);
  }
  return sites;
}

/**
 * Assert that every place instructing a panel dispatch also instructs
 * `isolation: "worktree"` (Issue #1277).
 *
 * ## The defect
 *
 * All three lenses ran concurrently against **one shared worktree**, and
 * `test-falsifiability` mutates it — proving a test falsifiable means reverting
 * the change and watching the test go red, which is the single most valuable
 * thing this panel does. Measured on #1275: during a 17-word deletability sweep
 * (17 mutate/restore cycles) the other two voters read the tree mid-flight and
 * filed the mutation as findings — `over-blocking` reported the tree dirty
 * because a vocabulary word was deleted, `instruction-correctness` read a
 * vocabulary entry as corrupted. Neither was in the diff. An artefact is
 * indistinguishable from a finding until someone checks, so a verifier that
 * manufactures them spends the trust the panel exists to earn.
 *
 * ## Why this is a gate and not a paragraph
 *
 * The instruction has to be repeated in every file that tells someone to fan the
 * panel out, and this repository has already shipped the failure that follows:
 * an instruction duplicated in prose gets updated in one copy and not the others
 * (#1187). Three sites carry it today. Nothing but a check keeps the third in
 * step with the first.
 *
 * ## What it buys, precisely — and what it does not
 *
 * It fires on: the marker deleted from any existing site; a **new** site added
 * without it; the voter agent existing with nothing telling anyone to dispatch
 * it; a site dispatching a voter agent that does not exist.
 *
 * It does **not** fire on a site that keeps the characters while gutting the
 * meaning ("do not pass `isolation: "worktree"`"). That is the same limit
 * `checkDurableFindingReceiver` documents and accepts: judging whether prose
 * means what it says needs a model, and a gate that tried would be a gate nobody
 * could satisfy (#1169).
 *
 * It is also inert in a repository with no panel at all — no voter agent and no
 * site — which is what lets the runner's throwaway fixture pass. That is a real
 * hole only if the voter agent can be removed silently, and it cannot:
 * `checkClaudeMdTable` pins the agent set to `CLAUDE.md`'s table, so deleting the
 * agent is a two-file change that fails here the moment either half lands alone.
 *
 * @param {object} input
 * @param {Record<string, string | null>} [input.agentFiles] contents by agent name
 * @param {Record<string, string | null>} [input.skillFiles] SKILL.md contents by skill name
 * @param {readonly string[]} [input.lenses] the panel's lens slugs
 * @returns {string[]} problems
 */
export function checkPanelWorktreeIsolation({ agentFiles = {}, skillFiles = {}, lenses = LENSES }) {
  /** @type {string[]} */
  const problems = [];
  // Normalised once and reused for both the filtering and the failure messages,
  // so the two halves cannot form different opinions of the same input.
  const lensList = normalizeLenses(lenses);
  const sites = findPanelDispatchSites({ agentFiles, skillFiles, lenses: lensList });
  // Key presence, not readability: an unreadable agent file is `checkAgent`'s
  // message to give, and saying it twice in different words is noise.
  const voterDefined = Object.prototype.hasOwnProperty.call(agentFiles, PANEL_VOTER_AGENT);
  const voterPath = `${AGENT_DIR}/${PANEL_VOTER_AGENT}.md`;

  if (voterDefined && sites.length === 0) {
    problems.push(
      `${voterPath} exists but no agent body or SKILL.md names both "${PANEL_VOTER_AGENT}" and all ` +
        `${lensList.length} lenses (${lensList.join(", ")}), so nothing tells a caller how to dispatch ` +
        `the panel — and the "${WORKTREE_ISOLATION_MARKER}" rule this check exists for has nothing ` +
        `left to assert. A rule with no subject reads exactly like a rule that passed (#1215). ` +
        `Restore the dispatch instructions, or delete the agent and its ${CALLER_CONTRACT_FILE} row.`,
    );
  }

  if (!voterDefined && sites.length > 0) {
    problems.push(
      `${sites.map((site) => site.path).join(", ")} instruct dispatching "${PANEL_VOTER_AGENT}", ` +
        `but ${voterPath} does not exist. Either the agent was renamed and its dispatch sites were ` +
        `not, or the sites are stale (#1277).`,
    );
  }

  for (const site of sites) {
    if (site.body.includes(WORKTREE_ISOLATION_MARKER)) continue;
    problems.push(
      `${site.path} instructs a parallel "${PANEL_VOTER_AGENT}" fan-out over all ` +
        `${lensList.length} lenses but never names \`${WORKTREE_ISOLATION_MARKER}\`. The ` +
        `test-falsifiability lens mutates the tree to prove a test falsifiable, so voters sharing ` +
        `one worktree read each other's in-flight mutations and report them as findings — measured ` +
        `on #1275, two of four objections were artefacts of a third voter's deletability sweep ` +
        `(#1277). Dispatch each voter with \`${WORKTREE_ISOLATION_MARKER}\`, using those exact ` +
        `characters so this check can see it.`,
    );
  }

  // --- the instruction isolation makes wrong ---------------------------------
  // Checked over the voter's own definition too, not just the dispatch sites:
  // that file is where a voter is actually told how to measure, and it is the one
  // panel document the dispatch-site rule deliberately excludes.
  const voterBody =
    typeof agentFiles[PANEL_VOTER_AGENT] === "string"
      ? stripFrontmatter(/** @type {string} */ (agentFiles[PANEL_VOTER_AGENT]))
      : null;
  const measurementDocs = [
    ...sites,
    ...(voterBody === null ? [] : [{ path: voterPath, body: voterBody }]),
  ];
  for (const doc of measurementDocs) {
    if (!doc.body.includes(PANEL_HEAD_BLOB_ANTIPATTERN)) continue;
    problems.push(
      `${doc.path} tells a panel voter to measure with \`${PANEL_HEAD_BLOB_ANTIPATTERN}<path>\`, ` +
        `but a voter dispatched with \`${WORKTREE_ISOLATION_MARKER}\` gets a worktree created ` +
        `from origin/main — git will not check out a branch already checked out by the ` +
        `implementer — so its HEAD is the BASELINE and that blob is the pre-change file. A voter ` +
        `obeying this reads the unfixed code and files "the fix was never applied" in good faith; ` +
        `both non-mutating lenses did exactly that on #1277's own panel. Name the reviewed commit ` +
        `SHA in the dispatch and measure with "git show <tip-sha>:<path>" instead.`,
    );
  }

  return problems;
}

/**
 * A `description` shorter than this is a title, not a trigger. Claude Code
 * routes auto-delegation on the description alone, so "Code reviewer" either
 * never fires or fires on everything. Same floor the skill check uses, for the
 * same reason.
 */
export const MIN_DESCRIPTION_LENGTH = 40;

/**
 * Extract YAML block-sequence fields from frontmatter, e.g.
 *
 * ```yaml
 * mcpServers:
 *   - github
 *   - playwright
 * ```
 *
 * `parseFrontmatter` intentionally ignores indented lines, so it reports
 * `mcpServers` as an empty scalar. This fills that gap for the one shape
 * agents actually use. Inline flow sequences (`mcpServers: [github]`) are
 * handled too, because that form is equally valid YAML and someone will write
 * it.
 *
 * @param {string} text full file contents
 * @returns {Record<string, string[]>} keyed by field name
 */
export function parseBlockLists(text) {
  /** @type {Record<string, string[]>} */
  const lists = {};
  if (typeof text !== "string") return lists;

  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return lists;

  /** @type {string | null} */
  let currentKey = null;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "---") break;

    const itemMatch = /^\s+-\s*(.*)$/.exec(line);
    if (itemMatch && currentKey) {
      const value = stripQuotes(itemMatch[1].trim());
      if (value.length > 0) lists[currentKey].push(value);
      continue;
    }

    const separator = line.indexOf(":");
    if (separator <= 0 || line[0] === " " || line[0] === "\t") {
      currentKey = null;
      continue;
    }

    const key = line.slice(0, separator).trim();
    const rest = line.slice(separator + 1).trim();

    if (rest.length === 0) {
      // A bare `key:` opens a block sequence — or is simply empty. Either way
      // start collecting; an empty list is a meaningful, reportable state.
      currentKey = key;
      lists[key] = [];
      continue;
    }

    currentKey = null;
    if (rest.startsWith("[") && rest.endsWith("]")) {
      lists[key] = rest
        .slice(1, -1)
        .split(",")
        .map((part) => stripQuotes(part.trim()))
        .filter((part) => part.length > 0);
    }
  }

  return lists;
}

/**
 * Remove one matched pair of surrounding quotes.
 *
 * @param {string} value
 * @returns {string}
 */
function stripQuotes(value) {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Split a comma-separated scalar list (`tools: Read, Bash, Grep`) into entries.
 *
 * `Agent(Explore, Plan)` is legal in `tools:` — the parenthesised part
 * restricts which subagent types may be spawned — so commas inside parentheses
 * must not split. Getting that wrong would report `Agent(Explore` as a tool.
 *
 * A YAML **flow sequence** (`tools: [Read, Bash]`, `tools: []`) is equally valid
 * and someone will write it, so the brackets are stripped first. Without that,
 * `[Read, Bash]` parses as the two tools `[Read` and `Bash]` and `[]` as a single
 * tool named `[]` — the latter is what made an explicitly-empty allowlist look
 * non-empty (#1168).
 *
 * @param {string} value
 * @returns {string[]}
 */
export function splitToolList(value) {
  if (typeof value !== "string" || value.trim().length === 0) return [];
  const trimmed = value.trim();
  const unwrapped =
    trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  if (unwrapped.trim().length === 0) return [];
  /** @type {string[]} */
  const entries = [];
  let depth = 0;
  let current = "";
  for (const char of unwrapped) {
    if (char === "(") depth += 1;
    if (char === ")") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) {
      entries.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  entries.push(current.trim());
  return entries.filter((entry) => entry.length > 0);
}

/**
 * The bare tool name, with any `Agent(...)` restriction stripped, so that
 * `Agent(Explore)` and `Agent` compare equal against a denylist.
 *
 * @param {string} entry
 * @returns {string}
 */
export function toolBaseName(entry) {
  const paren = entry.indexOf("(");
  return (paren >= 0 ? entry.slice(0, paren) : entry).trim();
}

/**
 * The built-in tool that grants skill invocation.
 *
 * A subagent gets `Skill` **by default only when `tools:` is omitted** — an
 * explicit allowlist is a whitelist. Every METIS agent declares one, which is
 * how six of seven came to be instructed to invoke a procedure they had no tool
 * to reach (#1162): #1142 made the skills discoverable, #1144/#1146 rewrote the
 * bodies to say "invoke the skill, do not `Read` the SKILL.md", and nothing
 * added the tool.
 *
 * Measured on CLI 2.1.220 with a throwaway agent and a canary skill, not
 * assumed:
 *
 *  - `tools: Read, Skill` — session init reports `tools: ["Read","Skill"]`, and
 *    a genuine `Agent`-tool subagent dispatch invoked `/probe-canary` and
 *    returned the token planted in its body. So it works, and it works for a
 *    real subagent, not merely for a session started with `--agent`.
 *  - `tools: Read` — init reports `tools: ["Read"]`, and the dispatched subagent
 *    replied "There is no `Skill` tool ... available to me".
 *
 * In **both** arms the skill still appeared in the session's `slash_commands`.
 * Discoverability is therefore not evidence of invocability, which is precisely
 * why this has to be a check and not a careful reading of the config.
 */
export const SKILL_TOOL = "Skill";

/**
 * Body text, i.e. everything after the closing `---` of the frontmatter block.
 *
 * Scanning the whole file instead would let a `description` mentioning a skill
 * satisfy — or trip — the skill rule, and the description is prose about the
 * agent rather than an instruction to it.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripFrontmatter(text) {
  if (typeof text !== "string") return "";
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return text;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "---") return lines.slice(i + 1).join("\n");
  }
  return "";
}

/**
 * "invoke `/x`" / "invoke the `/x` skill" — the leading slash makes the intent
 * unambiguous, so the name is taken at face value and checked for existence.
 */
const INVOKE_SLASH_SKILL = /invoke[a-z]*\s+(?:the\s+)?`?\/([a-z0-9][a-z0-9-]*)`?/gi;

/** "invoke the `x` skill" — backticks plus the literal word "skill". */
const INVOKE_BACKTICKED_SKILL = /invoke[a-z]*\s+(?:the\s+)?`([a-z0-9][a-z0-9-]*)`\s+skill\b/gi;

/**
 * "invoke the x skill", unmarked. Counted only when `x` is a real skill —
 * otherwise prose like "invoke the same skill twice" would fail the build.
 */
const INVOKE_BARE_SKILL = /invoke[a-z]*\s+(?:the\s+)?([a-z0-9][a-z0-9-]*)\s+skill\b/gi;

/**
 * A backticked `/x` anywhere in the body. Also gated on being a real skill: a
 * body may legitimately mention `/mcp` or an HTTP route, and the trailing
 * backtick already excludes multi-segment paths like `/projects/:id/hooks`.
 */
const BACKTICKED_SLASH_NAME = /`\/([a-z0-9][a-z0-9-]*)`/g;

/**
 * Skills an agent body tells the agent to invoke.
 *
 * Two lists come back because they answer different questions. `references`
 * drives the `Skill`-tool rule and must be generous — any instruction to invoke
 * anything is enough. `marked` drives the does-this-skill-exist rule and must
 * be conservative: only names written with a slash or in backticks, so free
 * prose can never invent a skill name and fail the build.
 *
 * @param {string} text full agent file contents
 * @param {string[]} [knownSkillNames] skills that exist on disk
 * @returns {{ references: string[], marked: string[] }} both sorted
 */
export function extractSkillReferences(text, knownSkillNames = []) {
  const body = stripFrontmatter(text);
  /** @type {Set<string>} */
  const references = new Set();
  /** @type {Set<string>} */
  const marked = new Set();

  for (const pattern of [INVOKE_SLASH_SKILL, INVOKE_BACKTICKED_SKILL]) {
    for (const match of body.matchAll(pattern)) {
      const skill = match[1].toLowerCase();
      references.add(skill);
      marked.add(skill);
    }
  }

  for (const pattern of [INVOKE_BARE_SKILL, BACKTICKED_SLASH_NAME]) {
    for (const match of body.matchAll(pattern)) {
      const skill = match[1].toLowerCase();
      if (knownSkillNames.includes(skill)) references.add(skill);
    }
  }

  return {
    references: [...references].sort(),
    marked: [...marked].sort(),
  };
}

/**
 * A named MCP tool, in either spelling this repo has ever used: the harness's own
 * `mcp__server__tool` (and the `mcp__server__*` / `mcp__*` allowlist patterns), and
 * the single-underscore `mcp_server_tool` form the skills inherited from their
 * Copilot origins.
 *
 * Deliberately requires an underscore straight after `mcp`, which is what keeps it
 * off the three things that are *talk about* MCP rather than a call: the word "MCP"
 * in prose, the `mcpServers:` frontmatter key, and the `.mcp.json` filename. A
 * skill is allowed to explain that MCP exists; it is not allowed to hand a
 * no-MCP agent a tool name to call.
 *
 * This is the **allowlist** reading, where the bare `mcp__*` is a real grant. Skill
 * prose is scanned with `MCP_TOOL_INSTRUCTION_PATTERN` instead, which drops it.
 */
export const MCP_TOOL_PATTERN =
  /\bmcp_{1,2}(?:\*|[a-z0-9][a-z0-9-]*)(?:_{1,2}(?:\*|[a-z0-9][a-z0-9-]*))*/i;

/**
 * The same token, minus the bare-wildcard form `mcp__*` — for scanning skill *prose*
 * rather than a `tools:` entry.
 *
 * The two readings genuinely differ. In an allowlist, `mcp__*` is the broadest grant
 * there is, so `isMcpToolName` must keep matching it. In a skill body it is not a
 * call: `mcp__*` is precisely the string you have to write to *explain* the no-MCP
 * rule, so matching it forced a `<!-- mcp: main-session only -->` onto sentences that
 * were documenting the restriction rather than instructing past it. That overloaded
 * the marker with two meanings and blunted the `grep -c` audit this design nominates.
 *
 * Requiring a named server segment keeps every real reference (`mcp__github__*`,
 * `mcp_github_pull_request_read`) and drops only the bare wildcard.
 */
export const MCP_TOOL_INSTRUCTION_PATTERN =
  /\bmcp_{1,2}[a-z0-9][a-z0-9-]*(?:_{1,2}(?:\*|[a-z0-9][a-z0-9-]*))*/i;

/**
 * Opt-out marker for one line of a skill body (Issue #1180).
 *
 * A skill is **not owned by one agent**: the main session loads the same file and
 * does hold every MCP tool, so an `mcp_*` instruction addressed to it is correct
 * and deleting it would lose real information. This marker is how that line says
 * who it is for. It is per-line and literal on purpose — an exemption that spanned
 * a section, or that a reviewer had to infer from tone, is an exemption nobody
 * would notice growing. `grep -c` over it is the audit.
 */
export const MCP_MAIN_SESSION_MARKER = "<!-- mcp: main-session only -->";

/**
 * Does this `tools:` entry name an MCP tool or MCP wildcard?
 *
 * @param {string} entry
 * @returns {boolean}
 */
export function isMcpToolName(entry) {
  if (typeof entry !== "string") return false;
  return MCP_TOOL_PATTERN.test(entry.trim());
}

/**
 * Can this agent reach **any** MCP tool, as far as frontmatter can tell?
 *
 * An allowlist naming no `mcp__*` pattern strips every MCP tool (#1146, measured),
 * and an absent allowlist inherits them all. The present-but-empty case resolves to
 * zero tools (#1168), so it is correctly "no MCP" — `checkAgent` reports the more
 * useful zero-tools problem for that shape separately.
 *
 * @param {string[]} toolEntries entries from `tools:`
 * @param {boolean} declaresTools whether a `tools:` key is present at all
 * @returns {boolean}
 */
export function hasMcpTools(toolEntries, declaresTools) {
  if (!declaresTools) return true;
  return Array.isArray(toolEntries) && toolEntries.some((entry) => isMcpToolName(entry));
}

/**
 * Every line of a skill body that names an MCP tool, with its 1-based line number
 * in the **whole file** so the message can be pasted at an editor.
 *
 * The frontmatter is skipped for the same reason `extractSkillReferences` skips an
 * agent's: a `description` is prose *about* the skill, read by the router, not an
 * instruction *to* whoever loads it.
 *
 * @param {string} text full SKILL.md contents
 * @returns {Array<{ line: number, token: string, text: string }>}
 */
export function findMcpInstructions(text) {
  if (typeof text !== "string") return [];
  const lines = text.split(/\r?\n/);

  let start = 0;
  if (lines[0]?.trim() === "---") {
    const close = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    // An unterminated fence means the whole file is frontmatter, exactly as
    // `stripFrontmatter` reads it. Scanning it anyway would report a description.
    if (close < 0) return [];
    start = close + 1;
  }

  /** @type {Array<{ line: number, token: string, text: string }>} */
  const hits = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];
    // Same line, not the same paragraph: a marker one line below the token does not
    // exempt it. Reflow the sentence rather than adding a second marker.
    if (line.includes(MCP_MAIN_SESSION_MARKER)) continue;
    // The instruction-side pattern, so a line explaining the rule with the literal
    // `mcp__*` does not need a marker. Safe to reuse: no `g`/`y` flag, so there is
    // no `lastIndex` to leak between lines.
    const match = MCP_TOOL_INSTRUCTION_PATTERN.exec(line);
    if (match) hits.push({ line: i + 1, token: match[0], text: line.trim() });
  }
  return hits;
}

/**
 * Every skill an agent can reach through its skill instructions, as a fixed point
 * over the same edge map, keyed by skill with the shortest path that reaches it.
 *
 * A skill body may hand off to another skill — `code-review` Step 10 hands off to
 * `resolve-pr-comments`, and that is the only such edge in the tree today. Stopping
 * at one hop would mean a `mcp_*` line re-added to a handed-off skill passes the
 * gate in silence: the original #1180 defect, restored, past the check built to
 * prevent it. So the closure is computed rather than judged, for the same reason the
 * agent→skill edge is (the issue's hand-reasoned guess about `epic-planner` was
 * wrong).
 *
 * Breadth-first so the recorded path is the shortest one, which is what the message
 * should name. The `paths` map doubles as the visited set, so the self-reference
 * nearly every skill body contains — and any cycle — terminates on the first hop.
 *
 * @param {string[]} directReferences skills the agent body itself names
 * @param {Record<string, string | null>} skillFiles SKILL.md contents by name
 * @param {string[]} [knownSkillNames] skills that exist on disk
 * @returns {Map<string, string[]>} reachable skill -> path from the agent
 */
export function resolveSkillClosure(directReferences, skillFiles, knownSkillNames = []) {
  // Union rather than either alone: the unmarked "invoke the x skill" and `/x` forms
  // are counted only for names known to exist, and `skillFiles` is keyed by exactly
  // the skills on disk — so a caller that passes neither list still resolves handoffs.
  const known = [...new Set([...knownSkillNames, ...Object.keys(skillFiles)])];
  /** @type {Map<string, string[]>} */
  const paths = new Map();
  // The queue carries each skill's path rather than just its name, so the walk never
  // has to look a path back up — which would need an `?? []` for a case that cannot
  // happen, since nothing is queued that was not first recorded in `paths`.
  /** @type {Array<{ skill: string, path: string[] }>} */
  const queue = [];
  for (const skill of directReferences) {
    if (paths.has(skill)) continue;
    paths.set(skill, [skill]);
    queue.push({ skill, path: [skill] });
  }
  for (let head = 0; head < queue.length; head += 1) {
    const { skill, path } = queue[head];
    const text = skillFiles[skill];
    if (typeof text !== "string") continue;
    for (const next of extractSkillReferences(text, known).references) {
      if (paths.has(next)) continue;
      const nextPath = [...path, next];
      paths.set(next, nextPath);
      queue.push({ skill: next, path: nextPath });
    }
  }
  return paths;
}

/**
 * Assert that no skill an agent is told to invoke instructs a tool that agent
 * cannot call (Issue #1180).
 *
 * ## Why this is transitive and not "skill mentions MCP"
 *
 * This is the fourth instance of one class — a capability declared in one file and
 * unreachable in another — after #1162 (`Skill` missing from `tools:`), #1163
 * (`memory:` with no writable store) and #1168 (`Glob`/`Grep` declared but never
 * exposed). Each of the first three was closed with a rule for that instance. What
 * makes this one different is that **neither file is wrong on its own**:
 *
 *  - `.claude/agents/code-review.md` correctly says it has no MCP tools.
 *  - `.github/skills/code-review/SKILL.md` correctly describes the MCP procedure
 *    for the main session, which does hold them.
 *
 * Only the *edge* between them is wrong, so only a check that walks the edge can
 * see it. `extractSkillReferences` (#1162) already builds that edge to answer "is
 * `Skill` in `tools:`", and reusing it means the two rules can never disagree about
 * which skills an agent invokes.
 *
 * The cost of not having this was real rather than theoretical: every `code-review`
 * dispatch across a week reinvented the `gh` path from scratch, twice rediscovering
 * that `gh api --input` silently demotes `-f`/`-F` flags to query parameters (HTTP
 * 414) and that `event=APPROVE` is a 422 on your own PR.
 *
 * ## An unreadable body is UNKNOWN, not clean (#1215)
 *
 * This used to `continue` on any skill with no text, on the reasoning that
 * `checkAgent`'s marked-skill rule already reports an invocation of a skill that does
 * not exist. That reasoning holds for a name that is not a skill — and silently fails
 * open for one that **is**. Measured against the real runner: a tree in which
 * `probe-skill/SKILL.md` instructs `mcp_github_pull_request_review_write` exits 1,
 * and the identical tree with that one file removed — or replaced by a directory, so
 * the read throws `EISDIR` — exits **0**. The skill *directory* still exists, so the
 * name is known, the marked-skill rule is satisfied, and the rule this function
 * implements simply does not run. Nothing prints.
 *
 * So the two states are separated: a name that is not a skill is still skipped (the
 * marked-skill rule owns it, and saying it twice in different words is noise), while a
 * skill that exists and cannot be read is a problem. "Known" is the SAME union
 * `resolveSkillClosure` walks — `knownSkillNames` plus the keys of `skillFiles`, which
 * the runner populates for every discovered skill with `null` when the body is
 * unreadable — so the two halves cannot drift into disagreeing about what a skill is
 * (#1192).
 *
 * @param {object} input
 * @param {string} input.name agent file stem
 * @param {boolean} input.hasMcp whether the agent can reach any MCP tool
 * @param {string[]} [input.skillReferences] skills the body says to invoke
 * @param {Record<string, string | null>} [input.skillFiles] SKILL.md contents by name
 * @param {string[]} [input.knownSkillNames] skills that exist on disk
 * @returns {string[]} problems
 */
export function checkSkillMcpReachability({
  name,
  hasMcp,
  skillReferences = [],
  skillFiles = {},
  knownSkillNames,
}) {
  /** @type {string[]} */
  const problems = [];
  if (hasMcp) return problems;

  for (const [skill, path] of resolveSkillClosure(skillReferences, skillFiles, knownSkillNames)) {
    const text = skillFiles[skill];
    if (typeof text !== "string") {
      // "Exists but unreadable" is a KEY PRESENT with a null value — the runner's
      // `readSkillFiles(names)` writes one entry per discovered skill directory and
      // stores `null` when the body cannot be read, so the presence of the key is
      // exactly the statement "this is a skill". A name with no key at all is either
      // not a skill (the marked-skill rule owns that message, and saying it twice in
      // different words is noise) or a caller that supplies no bodies — the documented
      // `skillFiles = {}` seam, which `checkAgent`'s own tests exercise deliberately.
      // Keying off `knownSkillNames` instead would fire on that seam and turn a
      // legitimate injection point into a failure.
      if (!Object.prototype.hasOwnProperty.call(skillFiles, skill)) continue;
      const reachedVia =
        path.length > 1 ? ` (reached via ${path.map((step) => `"/${step}"`).join(" -> ")})` : "";
      problems.push(
        `${name}: the body says to invoke "/${skill}"${reachedVia}, and that skill exists, but ` +
          `its ${SKILL_SOURCE_DIR}/${skill}/SKILL.md could not be read — so the #1180 ` +
          `MCP-reachability rule did not run over it. An unreadable skill body is UNKNOWN, not ` +
          `clean: the identical tree with a readable body instructing an "mcp__*" tool fails ` +
          `this check, so skipping it here would let the violation through in silence (#1215). ` +
          `Restore the file, or remove the skill directory if it is dead.`,
      );
      continue;
    }
    const hits = findMcpInstructions(text);
    if (hits.length === 0) continue;

    const first = hits[0];
    // Name the handoff explicitly when the skill is reached indirectly: "your body
    // never mentions this skill" is the first thing the reader will otherwise think.
    const via =
      path.length > 1
        ? `the body says to invoke "/${path[0]}", which hands off to ` +
          `${path
            .slice(1)
            .map((step) => `"/${step}"`)
            .join(" -> ")}, but `
        : `the body says to invoke "/${skill}", but `;
    problems.push(
      `${name}: ${via}` +
        `${SKILL_SOURCE_DIR}/${skill}/SKILL.md:${first.line} instructs "${first.token}" — and this ` +
        `agent's tools allowlist names no "mcp__*" pattern, so every MCP tool is stripped from it ` +
        `(#1146). The skill hands it a procedure it cannot run, and it has to improvise the "gh" ` +
        `equivalent mid-dispatch (#1180). Rewrite the instruction to a "gh" command, or append ` +
        `"${MCP_MAIN_SESSION_MARKER}" to the line if it is genuinely addressed to the main ` +
        `session, which does hold MCP tools. (${hits.length} offending line(s).)`,
    );
  }

  return problems;
}

/**
 * Validate one agent definition.
 *
 * @param {object} input
 * @param {string} input.name agent file stem, e.g. "code-review"
 * @param {string | null} input.text file contents, or null when unreadable
 * @param {string[]} [input.mcpServerNames] servers defined in `.mcp.json`
 * @param {string[]} [input.skillNames] skills present in `.claude/skills/`
 * @param {Record<string, string | null>} [input.skillFiles] SKILL.md contents keyed
 *   by skill name. Absent means the MCP-reachability rule cannot run; the runner
 *   always supplies it, and `verify-agent-frontmatter-runner.test.mjs` executes the
 *   real gate so that wiring cannot rot unnoticed.
 * @param {string[]} [input.memoryIndexes] agent names with a committed
 *   `.claude/agent-memory/<name>/MEMORY.md`
 * @returns {{ problems: string[], warnings: string[] }}
 */
export function checkAgent({
  name,
  text,
  mcpServerNames = [],
  skillNames = [],
  skillFiles = {},
  memoryIndexes = [],
}) {
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const warnings = [];

  if (text === null || text === undefined) {
    problems.push(`${AGENT_DIR}/${name}.md is missing or unreadable`);
    return { problems, warnings };
  }

  const { found, fields, commentTruncated } = parseFrontmatter(text);
  if (!found) {
    problems.push(`${name}: has no closed --- frontmatter block`);
    return { problems, warnings };
  }
  const lists = parseBlockLists(text);

  // --- description: the sole input to auto-delegation -----------------------
  if (commentTruncated.includes("description")) {
    problems.push(
      `${name}: the description is unquoted and contains " #", so YAML discards everything from the hash onward. ` +
        `Wrap the value in quotes. (This is the #1142 bug: a description ending 'says "Closes #N".' truncates at "Closes".)`,
    );
  }
  for (const key of commentTruncated) {
    if (key === "description") continue;
    warnings.push(
      `${name}: "${key}" is unquoted and contains " #", so YAML truncates it at the hash.`,
    );
  }

  if (!fields.name) {
    problems.push(`${name}: frontmatter is missing "name"`);
  } else if (fields.name !== name) {
    problems.push(`${name}: frontmatter name is "${fields.name}" but the file is ${name}.md`);
  }

  const description = fields.description ?? "";
  if (description.length === 0) {
    problems.push(`${name}: frontmatter is missing "description"`);
  } else if (description.length < MIN_DESCRIPTION_LENGTH) {
    problems.push(
      `${name}: description is ${description.length} chars — under the ${MIN_DESCRIPTION_LENGTH}-char floor. ` +
        `It is the ONLY basis for auto-delegation, so write a trigger, not a title.`,
    );
  }

  // --- model ---------------------------------------------------------------
  const model = fields.model ?? "";
  if (model.length === 0) {
    warnings.push(
      `${name}: no "model" — defaults to inherit (the session model, top tier). State it explicitly.`,
    );
  } else if (!MODEL_ALIASES.includes(model) && !model.includes("-")) {
    problems.push(
      `${name}: model "${model}" is not one of ${MODEL_ALIASES.join(", ")} and is not a full model ID.`,
    );
  }

  // --- memory --------------------------------------------------------------
  const memory = fields.memory ?? "";
  if (memory.length > 0 && !MEMORY_SCOPES.includes(memory)) {
    problems.push(`${name}: memory "${memory}" is not one of ${MEMORY_SCOPES.join(", ")}.`);
  }

  // --- tools / disallowedTools --------------------------------------------
  // `tools:` absent and `tools:` present-but-empty are different states with
  // OPPOSITE meanings, so they must not both collapse into an empty array
  // (#1168). Absent inherits every tool; empty resolves to zero tools.
  const declaresTools = typeof fields.tools === "string";
  // `tools:` may be a scalar (`Read, Bash`), a flow sequence (`[Read, Bash]`) or a
  // **block sequence** — and `parseFrontmatter` reports the last of those as an
  // empty scalar, because it deliberately ignores indented lines. Measured on CLI
  // 2.1.220, a block sequence is a genuine allowlist (`tools:` / `  - Read` /
  // `  - Bash` resolved to `["Read","Bash"]`), so its items have to be recovered
  // from `parseBlockLists` — otherwise a working, legal shape that this repo
  // already uses for `mcpServers:` would be rejected as declaring zero tools.
  const blockTools = Object.prototype.hasOwnProperty.call(lists, "tools") ? lists.tools : null;
  const scalarTools = splitToolList(fields.tools ?? "");
  const tools = scalarTools.length > 0 ? scalarTools : (blockTools ?? []);
  // Same recovery for the denylist. Without it a block-sequence `disallowedTools:`
  // reads as empty, which would silently switch OFF the memory writability rule —
  // the mirror of the bug above, failing open instead of closed.
  const blockDisallowed = Object.prototype.hasOwnProperty.call(lists, "disallowedTools")
    ? lists.disallowedTools
    : null;
  const scalarDisallowed = splitToolList(fields.disallowedTools ?? "");
  const disallowed = scalarDisallowed.length > 0 ? scalarDisallowed : (blockDisallowed ?? []);
  if (!declaresTools) {
    warnings.push(
      `${name}: no "tools" allowlist — the agent inherits every tool, including Write and Edit.`,
    );
  } else if (tools.length === 0) {
    problems.push(
      `${name}: "tools" is present but lists nothing, which resolves to zero tools rather than to ` +
        `inherit-everything — measured on CLI 2.1.220, both "tools:" and "tools: []" yield a tool ` +
        `list of length 0, so the agent can do nothing at all (#1168). List the tools it needs ` +
        `(a scalar, a flow sequence or a block sequence all work), or remove the key entirely to ` +
        `inherit them.`,
    );
  }
  const toolBases = tools.map(toolBaseName);
  const disallowedBases = disallowed.map(toolBaseName);
  // null vs [] is the distinction above, preserved for the reachability predicate.
  const allowlist = declaresTools ? toolBases : null;
  for (const denied of disallowedBases) {
    if (toolBases.includes(denied)) {
      problems.push(
        `${name}: "${denied}" is in both tools and disallowedTools. disallowedTools is applied first, ` +
          `so the allowlist entry is dead — remove one.`,
      );
    }
  }

  // A declared tool the build does not expose is dead text that fails only at
  // call time, deep inside a dispatch (#1168). Non-exposure, not absence — see
  // the UNAVAILABLE_TOOLS docstring.
  const deadTools = UNAVAILABLE_TOOLS.filter((tool) => toolBases.includes(tool));
  if (deadTools.length > 0) {
    problems.push(
      `${name}: tools lists ${deadTools.join(", ")}, which this Claude Code build does not ` +
        `expose — the name resolves to nothing and fails only at call time with "No such tool ` +
        `available", deep inside a dispatch. Measured on CLI 2.1.220: a default session with no ` +
        `agent and no restrictions offers neither (#1168). Remove ` +
        `${deadTools.length > 1 ? "them" : "it"} — search with grep/find via Bash, or dispatch ` +
        `Explore for a wide sweep.`,
    );
  }

  // --- skill invocation ----------------------------------------------------
  // Gated on a non-empty allowlist: with `tools:` absent Skill is inherited, and
  // with it present-but-empty the zero-tools problem above is the honest report.
  // `isToolReachable` rather than bare membership so `disallowedTools: Skill` is
  // caught too — that shape also trips the allowed-and-denied rule above, whose
  // message is the accurate one for it.
  const skills = extractSkillReferences(text, skillNames);
  if (
    skills.references.length > 0 &&
    tools.length > 0 &&
    !isToolReachable(SKILL_TOOL, allowlist, disallowedBases)
  ) {
    problems.push(
      `${name}: the body says to invoke ${skills.references.map((skill) => `/${skill}`).join(", ")} ` +
        `but tools does not list "${SKILL_TOOL}". An explicit tools allowlist is a whitelist, so this agent ` +
        `cannot invoke any skill — add ${SKILL_TOOL} or delete the instruction (#1162).`,
    );
  }
  if (skillNames.length > 0) {
    for (const skill of skills.marked) {
      if (!skillNames.includes(skill)) {
        problems.push(
          `${name}: the body says to invoke "/${skill}", which is not a skill in ${SKILL_DIR}/ ` +
            `(known: ${skillNames.join(", ")}).`,
        );
      }
    }
  }

  // --- transitive MCP reachability across the agent -> skill edge (#1180) ---
  // Deliberately uses `skills.references`, the same generous list that drives the
  // `Skill`-tool rule: if the body is instruction enough to demand a Skill tool, it
  // is instruction enough to hand the agent an uncallable procedure. The rule then
  // takes that list to a fixed point over skill -> skill handoffs.
  problems.push(
    ...checkSkillMcpReachability({
      name,
      hasMcp: hasMcpTools(toolBases, declaresTools),
      skillReferences: skills.references,
      skillFiles,
      knownSkillNames: skillNames,
    }),
  );

  // --- memory store reachability (#1163, narrowed by #1168) ----------------
  // Deliberately after the tool lists, like the skill check above: whether a
  // declared store can ever be written is a function of `disallowedTools`. The
  // allowlist is NOT passed, because the memory protocol injects Write/Edit past
  // an allowlist that omits them — see `isMemoryWriteReachable`.
  problems.push(...checkMemoryStore({ name, memory, disallowedBases, memoryIndexes }));

  // --- mcpServers ----------------------------------------------------------
  if (Object.prototype.hasOwnProperty.call(lists, "mcpServers")) {
    for (const server of lists.mcpServers) {
      if (!mcpServerNames.includes(server)) {
        problems.push(
          `${name}: mcpServers lists "${server}", which .mcp.json does not define ` +
            `(known: ${mcpServerNames.join(", ") || "none"}).`,
        );
      }
    }
  }

  // --- unknown keys --------------------------------------------------------
  for (const key of Object.keys(fields)) {
    if (!KNOWN_FIELDS.includes(key)) {
      warnings.push(`${name}: unrecognised frontmatter key "${key}" — check the spelling.`);
    }
  }

  return { problems, warnings };
}

/**
 * Extract the agent names listed in `CLAUDE.md`'s agent table.
 *
 * The table's first column is a backticked agent name. Rows are matched
 * structurally rather than by locating a heading, so re-ordering or renaming
 * the surrounding section — which #1144 will do — does not break this.
 *
 * @param {string} claudeMd
 * @returns {string[]}
 */
export function extractTableAgents(claudeMd) {
  if (typeof claudeMd !== "string") return [];
  /** @type {string[]} */
  const names = [];
  for (const line of claudeMd.split(/\r?\n/)) {
    const match = /^\|\s*`([a-z0-9-]+)`\s*\|/.exec(line.trim());
    if (match && !names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

/**
 * Assert that `CLAUDE.md`'s agent table and `.claude/agents/` name the same
 * set. A row for a deleted agent tells every session to dispatch something
 * that no longer resolves; a missing row hides a working agent.
 *
 * @param {object} input
 * @param {string | null} input.claudeMd
 * @param {string[]} input.agentNames
 * @returns {string[]} problems
 */
export function checkClaudeMdTable({ claudeMd, agentNames }) {
  /** @type {string[]} */
  const problems = [];
  if (claudeMd === null || claudeMd === undefined) {
    problems.push("CLAUDE.md is missing or unreadable — cannot verify the agent table.");
    return problems;
  }

  const listed = extractTableAgents(claudeMd);
  for (const name of agentNames) {
    if (!listed.includes(name)) {
      problems.push(`CLAUDE.md's agent table has no row for "${name}", which exists on disk.`);
    }
  }
  for (const name of listed) {
    if (!agentNames.includes(name)) {
      problems.push(
        `CLAUDE.md's agent table lists "${name}", but ${AGENT_DIR}/${name}.md does not exist.`,
      );
    }
  }
  return problems;
}

/**
 * Run the whole check over pre-gathered inputs.
 *
 * @param {object} input
 * @param {Record<string, string | null>} input.agentFiles contents keyed by agent name
 * @param {string[]} [input.mcpServerNames] servers defined in `.mcp.json`
 * @param {string[]} [input.skillNames] skills present in `.claude/skills/`
 * @param {Record<string, string | null>} [input.skillFiles] SKILL.md contents keyed
 *   by skill name, for the #1180 MCP-reachability rule
 * @param {string | null} [input.claudeMd] CLAUDE.md contents
 * @param {string[]} [input.memoryIndexes] agent names with a committed
 *   `.claude/agent-memory/<name>/MEMORY.md`. Defaults to none, so a declared
 *   store fails loudly rather than being skipped when a caller forgets it.
 * @param {Array<{ store: string, indexPresent?: boolean, index?: string | null, archive?: string | null, files?: string[] }>} [input.memoryStores]
 *   stores read from disk, for the #1206 budget and per-entry rules. Defaulting
 *   to `[]` would be the fail-open shape, so it is cross-checked against
 *   `memoryIndexes` — see `checkMemoryStoresGathered`.
 * @param {Record<string, string | null>} [input.copilotAgentFiles] contents of
 *   `.github/agents/<slug>.agent.md` keyed by slug, for the #1282 second-surface rules.
 *   An empty map skips them, which is legitimate — a repo need not have a Copilot
 *   surface — and `checkSurfaceDocumented` is what stops it from being a fail-open.
 * @param {Record<string, string | null>} [input.copilotSurfaceDocs] documents that
 *   reference `.github/agents/`, keyed by repo-relative path: the second source of truth
 *   that turns deleting the whole surface into a failure rather than a silence.
 * @returns {{ ok: boolean, problems: string[], warnings: string[] }}
 */
export function verifyAgents({
  agentFiles,
  mcpServerNames = [],
  skillNames = [],
  skillFiles = {},
  claudeMd = null,
  memoryIndexes = [],
  memoryStores = [],
  copilotAgentFiles = {},
  copilotSurfaceDocs = {},
}) {
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const warnings = [];

  const agentNames = Object.keys(agentFiles).sort();
  if (agentNames.length === 0) {
    problems.push(`No agent definitions found under ${AGENT_DIR}/.`);
  }

  for (const name of agentNames) {
    const result = checkAgent({
      name,
      text: agentFiles[name],
      mcpServerNames,
      skillNames,
      skillFiles,
      memoryIndexes,
    });
    problems.push(...result.problems);
    warnings.push(...result.warnings);
  }

  problems.push(...checkClaudeMdTable({ claudeMd, agentNames }));
  problems.push(...checkDurableFindingReceiver({ agentFiles, claudeMd }));
  // --- panel voters must not share one worktree (#1277) ----------------------
  // Runs over both maps because a dispatch instruction lives in whichever file
  // the caller loads: `.claude/agents/code-issue.md` for the agent, its SKILL.md
  // for the procedure, and the panel's own skill for anyone invoking it directly.
  problems.push(...checkPanelWorktreeIsolation({ agentFiles, skillFiles }));

  // --- the second agent surface (#1282) --------------------------------------
  // `.github/agents/*.agent.md` is read by GitHub Copilot, which this repository
  // cannot observe, so nothing here fails when it goes stale — which is how it
  // drifted four days behind. Only the runtime-INDEPENDENT invariants are asserted
  // (frontmatter validity, the agents:/handoffs: reference graph, roster parity);
  // prose parity between twins deliberately is not. ADR 0009 has the boundary and
  // why generating one surface from the other was rejected.
  problems.push(
    ...verifyCopilotSurface({
      copilotFiles: copilotAgentFiles,
      claudeFiles: agentFiles,
      surfaceDocs: copilotSurfaceDocs,
    }).problems,
  );

  // --- memory index budget (#1206) -------------------------------------------
  problems.push(...checkMemoryStoresGathered({ memoryIndexes, memoryStores }));
  const memoryReport = checkMemoryIndexes(memoryStores);
  problems.push(...memoryReport.problems);
  warnings.push(...memoryReport.warnings);

  return { ok: problems.length === 0, problems, warnings };
}
