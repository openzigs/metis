/**
 * Pure scanning core for the two defects #1383 found in the quickstart.
 *
 * ## Why this exists
 *
 * `docs/USER_GUIDE.md` told a new reader to clone from a person's name rather than a URL — a
 * personal name standing where a command belongs, in the first code block anyone
 * copies. Walking the same quickstart literally then turned up three more lines that
 * cannot run at all: `npm run prisma:generate`, `prisma:migrate` and `prisma:seed`
 * name scripts that `package.json` does not define. None of it was caught because
 * nobody had followed the document end to end since the scripts were renamed.
 *
 * A one-off sweep fixes the file once. These two scanners are what stops the next
 * rename, or the next pasted home path, from putting it back — they run from
 * `doc-quickstart-core.test.mjs` over the tracked tree, so `pnpm test` is the gate and
 * no entry has to be added to the `pnpm lint` chain.
 *
 * ## Two scanners, two failure modes
 *
 * - {@link findDeveloperHomePaths} — a path under someone's home directory. It leaks
 *   a developer's account name into a tree destined to be public (#1293) and it is
 *   never runnable on the reader's machine, which is the same defect as the clone
 *   line wearing different clothes.
 * - {@link findScriptReferences} — a `npm run <name>` or `pnpm <name>` invocation. The
 *   caller resolves each against `package.json`; a name that resolves to nothing is a
 *   command the document promises and the repository does not honour.
 *
 * ## Self-match
 *
 * The home-path pattern is structural — it matches *any* account name that is not a
 * documented placeholder — so this file can describe the defect without containing
 * one. The tests build their sample offenders by concatenation for the same reason
 * (`"/" + "Users/jdoe/x"` is an offender at runtime and not in the source), which
 * keeps the scan over `scripts/` honest: nothing here needs exempting from its own
 * gate. The sibling company-identifier gate solves the identical problem the same way.
 */

/**
 * Account names that read as a placeholder rather than a person.
 *
 * `runner` is what a CI home directory is actually called, and `you` / `dev` / `user`
 * / `username` / `other` are the forms already in use across the docs and the
 * `scripts/lib` tests. An angle-bracket placeholder such as `<you>` never reaches this
 * set: {@link HOME_PATH_PATTERN} does not match angle brackets, so that spelling is
 * structurally clean and is the preferred way to write one.
 *
 * @type {ReadonlySet<string>}
 */
export const PLACEHOLDER_HOME_NAMES = new Set([
  "dev",
  "me",
  "other",
  "runner",
  "user",
  "username",
  "you",
]);

/**
 * Matches a home directory belonging to a named account, with something under it.
 *
 * A regex LITERAL, not `new RegExp` — Semgrep's `detect-non-literal-regexp` blocks the
 * constructed form and is right to: a pattern that arrives as data is a ReDoS surface
 * the moment anyone widens where the data comes from.
 *
 * Three obligations, each load-bearing:
 *
 * - The lookbehind rejects a `/Users/` that is the tail of a longer path. Without it
 *   the SCIM route `/scim/v2/Users/u1` in the server tests reads as account `u1`.
 * - The optional `/mnt/<letter>` prefix catches the WSL spelling of a Windows home,
 *   which is how a runner-setup script once carried one.
 * - The trailing `/` requires something to live under the home directory. A bare
 *   `/home/` or a sentence ending in `/Users` is not a path to anyone's machine.
 *
 * @type {RegExp}
 */
export const HOME_PATH_PATTERN =
  /(?<![A-Za-z0-9_])(?:\/mnt\/[a-z])?\/(?:Users|home)\/([A-Za-z0-9._-]+)\//g;

/**
 * Matches `npm run <script>` or `pnpm <script>` alone on a line.
 *
 * Deliberately narrow. A line carrying flags — `pnpm --filter @metis/server prisma
 * generate` — addresses a workspace package rather than a root script, and resolving
 * those would mean reading every package manifest to answer a question the quickstart
 * does not raise. Matching only the bare form keeps every reported miss a real one.
 *
 * A trailing `# comment` is allowed because the docs annotate commands that way.
 *
 * @type {RegExp}
 */
export const SCRIPT_REFERENCE_PATTERN =
  /^[ \t]*(?:(npm)[ \t]+run|(pnpm))[ \t]+([a-z][a-z0-9:_-]*)[ \t]*(?:#.*)?$/gm;

/**
 * pnpm subcommands that are the tool's own, not entries in `scripts`.
 *
 * `pnpm install` is a valid instruction in a document even though no script is named
 * `install`; `npm run install` would not be, which is why this set applies only to the
 * `pnpm` form. Names that are BOTH a builtin and a script (`test`, `build`) resolve
 * either way, so listing them changes nothing.
 *
 * @type {ReadonlySet<string>}
 */
export const PNPM_BUILTIN_COMMANDS = new Set([
  "add",
  "audit",
  "build",
  "dlx",
  "exec",
  "install",
  "licenses",
  "link",
  "list",
  "outdated",
  "publish",
  "rebuild",
  "remove",
  "run",
  "start",
  "store",
  "test",
  "update",
  "why",
]);

/**
 * The 1-based line number containing a byte offset.
 *
 * @param {string} text
 * @param {number} index
 * @returns {number}
 */
export function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === "\n") line += 1;
  }
  return line;
}

/**
 * @typedef {object} HomePathHit
 * @property {string} match the matched path prefix, up to and including the trailing slash
 * @property {string} account the account name the home directory belongs to
 * @property {number} line 1-based line number
 */

/**
 * Every developer home path in `text`, placeholders excluded.
 *
 * @param {string} text
 * @returns {HomePathHit[]}
 */
export function findDeveloperHomePaths(text) {
  /** @type {HomePathHit[]} */
  const hits = [];
  for (const match of text.matchAll(HOME_PATH_PATTERN)) {
    const account = match[1];
    if (PLACEHOLDER_HOME_NAMES.has(account)) continue;
    hits.push({
      match: match[0],
      account,
      line: lineOf(text, match.index ?? 0),
    });
  }
  return hits;
}

/**
 * @typedef {object} ScriptReference
 * @property {"npm" | "pnpm"} manager which tool the document tells the reader to run
 * @property {string} script the script name invoked
 * @property {number} line 1-based line number
 */

/**
 * Every bare `npm run <script>` / `pnpm <script>` invocation in `text`.
 *
 * @param {string} text
 * @returns {ScriptReference[]}
 */
export function findScriptReferences(text) {
  /** @type {ScriptReference[]} */
  const refs = [];
  for (const match of text.matchAll(SCRIPT_REFERENCE_PATTERN)) {
    refs.push({
      manager: match[1] === "npm" ? "npm" : "pnpm",
      script: match[3],
      line: lineOf(text, match.index ?? 0),
    });
  }
  return refs;
}

/**
 * Whether a reference names something the reader can actually run.
 *
 * @param {ScriptReference} reference
 * @param {ReadonlySet<string>} scriptNames names defined in the root `package.json`
 * @returns {boolean}
 */
export function isResolvableReference(reference, scriptNames) {
  if (scriptNames.has(reference.script)) return true;
  return reference.manager === "pnpm" && PNPM_BUILTIN_COMMANDS.has(reference.script);
}
