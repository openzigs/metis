/**
 * Pure decision logic for changelog fragments (Issue #1191).
 *
 * ## Why this exists
 *
 * Every PR used to append to the same `## [Unreleased]` anchor in a single
 * `CHANGELOG.md`. Git merges line by line, so two PRs inserting at the same
 * anchor have *nothing* to merge — the collision is structural, not occasional.
 * On 2026-07-30 three PRs from one fan-out (#1187, #1188, #1189) collided
 * repeatedly; #1188 hit the same conflict three times, and because a dirty PR
 * schedules zero CI each resolution cost another ~20-minute `api` run.
 *
 * The fix is to stop sharing the file. Each PR writes one fragment at
 * `.changes/unreleased/<issue>-<slug>.md`. Two PRs never touch one path, so the
 * conflict class disappears by construction rather than by discipline. At
 * release the fragments are assembled into `CHANGELOG.md` under a version
 * heading and deleted.
 *
 * `merge=union` in `.gitattributes` remains as a stopgap for the legacy file,
 * but it is only half a fix and the measurement is worth recording here so
 * nobody re-derives it: GitHub does **not** apply `.gitattributes` merge
 * drivers when computing PR mergeability. Measured on 2026-07-31 with the rule
 * present on base *and* head, a PR whose only divergence was two appends to one
 * `CHANGELOG.md` anchor still reported `mergeable: CONFLICTING` and the squash
 * merge refused ("the merge commit cannot be cleanly created"), identical to
 * the control with no rule. The driver fixes the *local* `git merge origin/main`
 * and nothing else.
 *
 * ## The entry-size convention, and why it is enforced rather than requested
 *
 * The 996 entries in `[Unreleased]` reached 1.65 MB because entries became
 * essays duplicating the PR body — the longest was 7,786 characters on a single
 * line. A changelog entry is a few lines; the detail belongs in the PR and the
 * issue. `MAX_ENTRY_LINES` and `MAX_LINE_CHARS` are deliberately generous: they
 * are a backstop that every one of those essays trips and no reasonable entry
 * comes near, not a style rule.
 *
 * Everything here is pure — callers inject the changed-path list and the
 * fragment contents — so the whole matrix is unit-testable without a git tree.
 */

import { parseFrontmatter } from "./skill-links-core.mjs";
import { stripFrontmatter } from "./agent-frontmatter-core.mjs";

/** Directory holding one unreleased fragment per PR. */
export const FRAGMENT_DIR = ".changes/unreleased";

/**
 * Section headings, in Keep a Changelog order. Rendering follows this order
 * rather than the order fragments happen to be read in, so the assembled
 * section is byte-identical regardless of filesystem enumeration.
 *
 * All six are accepted because `CHANGELOG.md` already uses five of them
 * (`Added`, `Changed`, `Fixed`, `Removed`, `Security`); restricting the set to
 * the three named in the issue would reject entries the existing file contains.
 */
export const SECTIONS = ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"];

/** Non-blank body lines allowed in one fragment. */
export const MAX_ENTRY_LINES = 10;

/** Characters allowed on one body line. The record holder was 7,786. */
export const MAX_LINE_CHARS = 500;

/**
 * `<issue>-<slug>.md`. The issue number leads so that two PRs cannot collide on
 * a filename without also being the same issue, and the slug is kebab-case so
 * the path is identical on a case-insensitive filesystem.
 */
export const FRAGMENT_FILENAME = /^(\d+)-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;

/** Files inside `FRAGMENT_DIR` that are infrastructure, not fragments. */
export const NON_FRAGMENT_FILES = [".gitkeep", "README.md"];

/**
 * The ONE predicate for "is this basename inside `FRAGMENT_DIR` a fragment".
 *
 * Three sites need this answer — the diff side (`classifyChangedPaths`), the
 * disk side in `verify-changelog-fragment.mjs`, and the assembler in
 * `assemble-changelog.mjs` — and they originally each hand-rolled it. Two of
 * them disagreed about dotfiles, which was enough to pass the gate with no real
 * fragment: `.changes/unreleased/.sneaky.md` counted as "a fragment this branch
 * added" while never being read, parsed or validated. A gate whose two halves
 * filter differently is only as strong as its weakest half, so there is exactly
 * one function and all three call it.
 *
 * Deliberately loose: anything that is not infrastructure and not a dotfile IS
 * a fragment, even if its name is malformed. A malformed name must be READ and
 * REJECTED with a message, not silently skipped — skipping is how a file
 * escapes validation while still counting.
 *
 * @param {string} name basename inside `FRAGMENT_DIR`
 * @returns {boolean}
 */
export function isFragmentBasename(name) {
  if (typeof name !== "string" || name.length === 0) return false;
  if (name.startsWith(".")) return false;
  return !NON_FRAGMENT_FILES.includes(name);
}

/**
 * A top-level markdown bullet. Every entry starts with one.
 *
 * All three CommonMark bullet markers are accepted. A hyphen-only grammar turns
 * ordinary writing into a hard CI failure, and there is no formatter upstream to
 * rewrite it: `.prettierignore` contains `*.md`, so prettier never normalises a
 * `*` into a `-` in this repository. A validator that rejects text which renders
 * correctly everywhere gets worked around rather than followed.
 */
const TOP_LEVEL_BULLET = /^[-*+]\s+\S/;

/** A bullet at any indent level; an indented one is a nested sub-point. */
const ANY_BULLET = /^\s*[-*+]\s+\S/;

/**
 * Markdown that is valid on its own but is not a valid ENTRY, each with what it
 * is and what to write instead.
 *
 * Every one of these is rejected because it breaks assembly, not because it is
 * unusual — a heading collides with the `### Added` headings the assembler
 * writes, a thematic break splits the section, and a fence or table at column 0
 * ends the bullet list the entry lives in. Indenting a fence or a table by two
 * spaces attaches it to the bullet above and is already accepted, so every
 * rejection here has a one-keystroke answer, and the message names it. A
 * rejection a writer cannot act on is the one that gets worked around.
 *
 * These are only consulted for lines that are neither a bullet nor an indented
 * continuation, so the patterns are anchored at column 0 on purpose.
 *
 * @type {Array<{ pattern: RegExp, what: string, instead: string }>}
 */
const REJECTED_CONSTRUCTS = [
  {
    pattern: /^\d+[.)]\s+\S/,
    what: "an ordered-list item",
    instead: 'changelog entries are an unordered list — start the line with "- "',
  },
  {
    pattern: /^#{1,6}(?:\s|$)/,
    what: "a markdown heading",
    instead:
      'it would collide with the "### Added"-style headings the assembler writes — fold it into the bullet, or leave it for the PR body',
  },
  {
    pattern: /^(?:-{3,}|\*{3,}|_{3,})\s*$/,
    what: "a thematic break",
    instead: "it would split the assembled version section in two — delete it",
  },
  {
    pattern: /^(?:```|~~~)/,
    what: "an unindented code fence",
    instead:
      "at column 0 it ends the bullet list the entry lives in — indent the whole fence by two spaces to attach it to the bullet above",
  },
  {
    pattern: /^\|/,
    what: "an unindented table row",
    instead:
      "at column 0 it ends the bullet list the entry lives in — indent the table by two spaces, or leave it for the PR body",
  },
];

/** An indented, non-bullet line: the soft-wrapped tail of the bullet above it. */
const CONTINUATION = /^\s+\S/;

/**
 * Group body lines into one block per top-level bullet.
 *
 * A long entry is normally soft-wrapped across physical lines, so a "line" is
 * not an entry. Grouping first is what lets the assembler put the issue
 * reference at the END of an entry rather than in the middle of a wrapped
 * sentence — the first fragment ever written tripped exactly that.
 *
 * @param {string[]} lines non-blank body lines
 * @returns {string[][]} one array of lines per entry
 */
export function groupEntryBlocks(lines) {
  /** @type {string[][]} */
  const blocks = [];
  for (const line of lines) {
    if (TOP_LEVEL_BULLET.test(line) || blocks.length === 0) blocks.push([line]);
    else blocks[blocks.length - 1].push(line);
  }
  return blocks;
}

/**
 * Paths that never require a changelog fragment.
 *
 * The list is an ALLOWLIST OF EXEMPTIONS, so the gate is fail-closed: a path
 * nobody thought about requires an entry rather than silently escaping one.
 * That is the right default here because this repository's norm is that
 * essentially every merged PR earns a line, including infrastructure work.
 *
 * @type {Array<{ pattern: RegExp, why: string }>}
 */
export const EXEMPT_RULES = [
  { pattern: /^\.changes\//, why: "the fragments themselves" },
  { pattern: /^CHANGELOG\.md$/, why: "the assembled changelog" },
  { pattern: /^docs\//, why: "documentation" },
  { pattern: /^graphify-out\//, why: "generated code graph, owned by main's CI" },
  { pattern: /^\.claude\/agent-memory\//, why: "cross-session agent notes" },
  { pattern: /^eval-results\//, why: "recorded evaluation output" },
  { pattern: /^pnpm-lock\.yaml$/, why: "lockfile" },
  { pattern: /^e2e\//, why: "end-to-end specs" },
  { pattern: /(^|\/)tests?\//, why: "tests" },
  { pattern: /\.(test|spec)\.[cm]?[jt]sx?$/, why: "tests" },
];

/**
 * PR authors that are automation opening dependency-update PRs.
 *
 * ## Why an author exemption at all (Issue #1270)
 *
 * The gate above is fail-closed by path, which is right for humans and wrong for
 * a bot: dependabot opens a PR from a branch it generates, and it has no step in
 * which it could write `.changes/unreleased/<issue>-<slug>.md` — it has no issue
 * number and no place to put one. So the rule was not "describe your dependency
 * bump", it was "dependabot PRs never merge". Measured 2026-08-06: **all ten**
 * open dependabot PRs failed `changelog`, the oldest since 2026-08-02, including
 * every security-relevant bump in the queue.
 *
 * **A rule that no author in a class can satisfy is a fail-open wearing a red
 * badge.** It produces a permanently-failing check, which carries exactly as
 * much information as one nobody runs — the argument #1219 made about `Semgrep`
 * on `main`, from the other side.
 *
 * Of the three options in #1270 this is the second: exempt by AUTHOR rather than
 * by path. Exempting the manifests outright (option 1) would also exempt
 * hand-written dependency work, and #1240 and #1241 each moved CVSS 7.0+
 * advisories by hand and each wrote an entry worth having. Generating a fragment
 * from the bot's PR body (option 3) keeps the changelog complete but needs CI to
 * push a commit onto the bot's branch, which both widens the workflow token's
 * privilege and stops dependabot rebasing its own PR. The author rule removes
 * exactly the class that cannot comply and leaves the human rule untouched.
 *
 * ## The two spellings, and why matching is exact
 *
 * The same account has two renderings and BOTH are real inputs:
 *   - `dependabot[bot]` — `github.event.pull_request.user.login` in Actions,
 *     which is what CI passes;
 *   - `app/dependabot` — how `gh pr view --json author` renders a GitHub App,
 *     which is what a local verification run passes.
 *
 * Matching is an exact lookup on the lowercased login, never a substring test.
 * Both spellings contain a character (`[`, `/`) that a GitHub username cannot,
 * so neither is impersonable by a human account — but `includes("dependabot")`
 * would hand the exemption to `dependabot-mirror`, and a signal that cannot be
 * disambiguated by substring is one this repo has already been bitten by.
 * Bare `dependabot` is deliberately NOT accepted: no real caller produces it,
 * and it is the one spelling a human login could take.
 *
 * @type {string[]}
 */
export const AUTOMATED_DEPENDENCY_AUTHORS = ["dependabot[bot]", "app/dependabot"];

/**
 * Whether a PR author login is automation that cannot write a fragment.
 *
 * Anything that is not a string — `null`, `undefined`, an absent env var, a push
 * to `main` where there is no PR author at all — is NOT such an author, so the
 * gate stays in its strict mode. The default direction matters: an omitted
 * author means "check everything", not "skip the check". #1168 shipped because a
 * default meant *nothing to check*; this one means the opposite.
 *
 * @param {unknown} author PR author login
 * @returns {boolean}
 */
export function isAutomatedDependencyAuthor(author) {
  if (typeof author !== "string") return false;
  return AUTOMATED_DEPENDENCY_AUTHORS.includes(author.trim().toLowerCase());
}

/**
 * Paths an automated dependency author is exempt on.
 *
 * The exemption is the INTERSECTION of author and path, not the author alone,
 * and that is the whole design. `EXEMPT_RULES` above is documented as an
 * allowlist so that "a path nobody thought about requires an entry rather than
 * silently escaping one"; an author-only rule would abandon that for every path
 * at once the moment the login matched. Dependabot only ever edits a dependency
 * manifest, so the intersection costs it nothing — verified against the real
 * `gh pr view --json files` output of all ten PRs open on 2026-08-06, whose
 * union is exactly `package.json` at nine depths, `pnpm-lock.yaml`, and eleven
 * files under `.github/workflows/`.
 *
 * The set covers both ecosystems configured in `.github/dependabot.yml` — `npm`
 * at `/` and `/ui`, and `github-actions` at `/` — plus the two files those
 * ecosystems can touch that no open PR happens to touch today
 * (`pnpm-workspace.yaml`, composite `action.yml`). A bot PR reaching outside
 * this set FAILS, and says which path and where to add a rule: that is a
 * one-line fix by a human, whereas an author-only exemption would let a bot
 * rewrite `server/src/` with no entry and no signal.
 *
 * @type {Array<{ pattern: RegExp, why: string }>}
 */
export const DEPENDENCY_MANIFEST_RULES = [
  { pattern: /(^|\/)package\.json$/, why: "npm manifest" },
  { pattern: /(^|\/)pnpm-workspace\.yaml$/, why: "pnpm workspace manifest" },
  { pattern: /^\.github\/workflows\/[^/]+\.ya?ml$/, why: "workflow action pin" },
  { pattern: /^\.github\/actions\/[^/]+\/action\.ya?ml$/, why: "composite action pin" },
];

/**
 * Whether a repo-relative POSIX path is exempt from the fragment requirement.
 *
 * `viaAuthor` distinguishes the two reasons a path can be exempt so the runner
 * can REPORT the author exemption rather than apply it silently. A skip nobody
 * can see in the output is the shape that stops being noticed when it is wrong.
 *
 * @param {string} filePath
 * @param {{ author?: unknown }} [options] `author` is the PR author login, when known
 * @returns {{ exempt: boolean, why: string | null, viaAuthor: boolean }}
 */
export function classifyPath(filePath, { author = null } = {}) {
  for (const rule of EXEMPT_RULES) {
    if (rule.pattern.test(filePath)) return { exempt: true, why: rule.why, viaAuthor: false };
  }
  if (isAutomatedDependencyAuthor(author)) {
    for (const rule of DEPENDENCY_MANIFEST_RULES) {
      if (rule.pattern.test(filePath)) {
        return { exempt: true, why: `${rule.why}, bumped by an automated author`, viaAuthor: true };
      }
    }
  }
  return { exempt: false, why: null, viaAuthor: false };
}

/**
 * Split a changed-path list into the groups the gate reasons about.
 *
 * `ignoredInFragmentDir` exists so that a path the gate declines to treat as a
 * fragment can be REPORTED rather than silently dropped. An author who names a
 * file `.sneaky.md` — or, far more likely, edits the README — otherwise gets
 * "adds no changelog fragment" while looking straight at a file they just wrote
 * in that directory.
 *
 * `authorExempt` is the subset of `exempt` that is exempt ONLY because of who
 * opened the PR — it would require an entry from a human. It is reported, never
 * merely counted, so an author exemption that fires wrongly is visible in the
 * job log instead of showing up as a passing gate with nothing to say.
 *
 * @param {string[]} changedPaths repo-relative POSIX paths changed on the branch
 * @param {{ author?: unknown }} [options] `author` is the PR author login, when known
 * @returns {{ requiring: string[], exempt: string[], authorExempt: string[], fragments: string[], ignoredInFragmentDir: string[] }}
 */
export function classifyChangedPaths(changedPaths, { author = null } = {}) {
  /** @type {string[]} */
  const requiring = [];
  /** @type {string[]} */
  const exempt = [];
  /** @type {string[]} */
  const authorExempt = [];
  /** @type {string[]} */
  const fragments = [];
  /** @type {string[]} */
  const ignoredInFragmentDir = [];

  for (const filePath of changedPaths) {
    if (typeof filePath !== "string" || filePath.length === 0) continue;
    if (filePath.startsWith(`${FRAGMENT_DIR}/`)) {
      const base = filePath.slice(FRAGMENT_DIR.length + 1);
      if (isFragmentBasename(base)) fragments.push(filePath);
      else ignoredInFragmentDir.push(filePath);
      exempt.push(filePath);
      continue;
    }
    const verdict = classifyPath(filePath, { author });
    if (!verdict.exempt) {
      requiring.push(filePath);
      continue;
    }
    exempt.push(filePath);
    if (verdict.viaAuthor) authorExempt.push(filePath);
  }

  return { requiring, exempt, authorExempt, fragments, ignoredInFragmentDir };
}

/**
 * Parse and validate one fragment.
 *
 * The section and the issue number are carried in frontmatter so that assembly
 * never has to infer them. The issue number ALSO appears in the filename, and
 * the two are cross-checked: the filename is what guarantees two PRs cannot
 * collide, the frontmatter is what assembly reads, and a rename that moved one
 * without the other would silently mis-attribute an entry.
 *
 * @param {string} filename basename, e.g. `1191-changelog-fragments.md`
 * @param {string | null} text file contents
 * @returns {{ filename: string, ok: boolean, issue: number | null, section: string | null, entries: string[], problems: string[] }}
 */
export function parseFragment(filename, text) {
  /** @type {string[]} */
  const problems = [];
  /**
   * @param {number | null} [issue]
   * @param {string | null} [section]
   * @param {string[]} [entries]
   */
  const fail = (issue = null, section = null, entries = []) => ({
    filename,
    ok: false,
    issue,
    section,
    entries,
    problems,
  });

  const nameMatch = FRAGMENT_FILENAME.exec(filename);
  if (!nameMatch) {
    problems.push(
      `${FRAGMENT_DIR}/${filename}: filename must be "<issue>-<kebab-slug>.md", e.g. "1191-changelog-fragments.md".`,
    );
  }
  const filenameIssue = nameMatch ? Number(nameMatch[1]) : null;

  if (typeof text !== "string") {
    problems.push(`${FRAGMENT_DIR}/${filename} is missing or unreadable.`);
    return fail(filenameIssue);
  }

  const { found, fields } = parseFrontmatter(text);
  if (!found) {
    problems.push(
      `${FRAGMENT_DIR}/${filename}: no closed --- frontmatter block. It must open with "---", ` +
        `carry "issue:" and "section:", and close with "---".`,
    );
    return fail(filenameIssue);
  }

  // --- section ---
  const section = fields.section ?? "";
  if (section.length === 0) {
    problems.push(`${FRAGMENT_DIR}/${filename}: frontmatter is missing "section".`);
  } else if (!SECTIONS.includes(section)) {
    problems.push(
      `${FRAGMENT_DIR}/${filename}: section is "${section}"; expected one of ${SECTIONS.join(", ")}.`,
    );
  }

  // --- issue ---
  const rawIssue = fields.issue ?? "";
  let issue = null;
  if (rawIssue.length === 0) {
    problems.push(`${FRAGMENT_DIR}/${filename}: frontmatter is missing "issue".`);
  } else if (!/^\d+$/.test(rawIssue)) {
    problems.push(
      `${FRAGMENT_DIR}/${filename}: issue is "${rawIssue}"; expected a bare number such as 1191.`,
    );
  } else {
    issue = Number(rawIssue);
    if (filenameIssue !== null && filenameIssue !== issue) {
      problems.push(
        `${FRAGMENT_DIR}/${filename}: frontmatter issue ${issue} does not match the filename's ${filenameIssue}. ` +
          `Assembly reads the frontmatter, so a mismatch mis-attributes the entry.`,
      );
    }
  }

  // --- body ---
  const bodyLines = stripFrontmatter(text)
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);

  if (bodyLines.length === 0) {
    problems.push(
      `${FRAGMENT_DIR}/${filename}: no entry text. Write the changelog line(s) as markdown bullets under the frontmatter.`,
    );
  }
  if (bodyLines.length > MAX_ENTRY_LINES) {
    problems.push(
      `${FRAGMENT_DIR}/${filename}: ${bodyLines.length} entry lines, over the ${MAX_ENTRY_LINES}-line cap. ` +
        `A changelog entry is a few lines; the detail belongs in the PR and the issue.`,
    );
  }

  if (bodyLines.length > 0 && !TOP_LEVEL_BULLET.test(bodyLines[0])) {
    problems.push(
      `${FRAGMENT_DIR}/${filename}: the entry must start with a top-level bullet ("- ", "* " or "+ "), not ` +
        `${JSON.stringify(bodyLines[0].slice(0, 60))}.`,
    );
  }

  for (const line of bodyLines) {
    if (!ANY_BULLET.test(line) && !CONTINUATION.test(line)) {
      const construct = REJECTED_CONSTRUCTS.find((candidate) => candidate.pattern.test(line));
      problems.push(
        construct
          ? `${FRAGMENT_DIR}/${filename}: ${JSON.stringify(line.slice(0, 60))} is ${construct.what}, ` +
              `which a changelog entry cannot contain — ${construct.instead}.`
          : `${FRAGMENT_DIR}/${filename}: entry line is neither a bullet nor an indented continuation — ` +
              `${JSON.stringify(line.slice(0, 60))}. Start it with "- ", or indent it by two spaces to ` +
              `continue the bullet above.`,
      );
      continue;
    }
    if (line.length > MAX_LINE_CHARS) {
      problems.push(
        `${FRAGMENT_DIR}/${filename}: an entry line is ${line.length} characters, over the ${MAX_LINE_CHARS}-character cap. ` +
          `Summarise here and put the detail in the PR body.`,
      );
    }
    if (issue !== null && line.includes(`(#${issue})`)) {
      problems.push(
        `${FRAGMENT_DIR}/${filename}: the entry already contains "(#${issue})", which the assembler appends. ` +
          `Drop it — the frontmatter carries the issue number.`,
      );
    }
  }
  return {
    filename,
    ok: problems.length === 0,
    issue,
    section: SECTIONS.includes(section) ? section : null,
    entries: bodyLines,
    problems,
  };
}

/**
 * Run the fragment gate over pre-gathered inputs.
 *
 * ## What counts as "this branch added a fragment"
 *
 * The intersection of three facts, not any one of them:
 *
 *  1. the branch touched the path (`changedPaths`),
 *  2. the file is on disk now and PARSED CLEAN (`fragmentFiles`), and
 *  3. it was NOT already present at the base ref (`baseFragments`).
 *
 * Gating on (1) alone is what let three different branches pass with no real
 * entry: a dotfile satisfied (1) but was never read, editing another PR's
 * already-merged fragment satisfied (1) while contributing nothing, and deleting
 * one satisfied (1) with the file gone. (3) is `--diff-filter=A` computed against
 * the base tree rather than read off diff letters, which is both simpler and
 * stricter — `AM` would still admit the typo-fix case, and fragments accumulate
 * here until a release, so the steady state is a directory full of other
 * people's fragments to touch.
 *
 * `baseFragments` is REQUIRED rather than defaulted. An omitted argument would
 * read as "nothing pre-exists", which is precisely the fail-open reading, and a
 * silently-defaulted input is how #1168 shipped.
 *
 * ## What the author exemption does NOT touch (#1270)
 *
 * Only the FIRST job. An automated dependency author still has every fragment on
 * disk parsed, and a malformed one still fails the gate. That separation is the
 * point: #1215's fail-open here was an unreadable `.changes/unreleased/` reading
 * as "nothing to check", and an exemption that short-circuited the whole function
 * would be the identical defect arriving by a different door. The author is
 * consulted in exactly one place — `classifyPath`, which decides whether a PATH
 * requires an entry — and nowhere else.
 *
 * @param {object} input
 * @param {string[]} input.changedPaths repo-relative POSIX paths changed on the branch
 * @param {Record<string, string | null>} input.fragmentFiles every present fragment, keyed by basename
 * @param {string[]} input.baseFragments fragment basenames already present at the base ref
 * @param {unknown} [input.author] PR author login; omitted means "unknown", which is the STRICT reading
 * @returns {{ ok: boolean, problems: string[], requiring: string[], authorExempt: string[], addedFragments: string[], contributed: string[], parsed: ReturnType<typeof parseFragment>[] }}
 */
export function verifyChangelogFragments({
  changedPaths,
  fragmentFiles,
  baseFragments,
  author = null,
}) {
  if (!Array.isArray(baseFragments)) {
    throw new TypeError(
      "verifyChangelogFragments requires baseFragments — the fragment basenames already on the base ref. " +
        "Pass [] only when the base genuinely has none; omitting it would silently count another PR's fragment as this branch's.",
    );
  }

  /** @type {string[]} */
  const problems = [];
  const { requiring, authorExempt, fragments, ignoredInFragmentDir } = classifyChangedPaths(
    changedPaths,
    { author },
  );

  const parsed = Object.keys(fragmentFiles)
    .sort()
    .map((name) => parseFragment(name, fragmentFiles[name]));
  for (const fragment of parsed) problems.push(...fragment.problems);

  const parsedOk = new Set(parsed.filter((fragment) => fragment.ok).map((f) => f.filename));
  const onBase = new Set(baseFragments);

  /** @type {string[]} */
  const contributed = [];
  /** @type {string[]} */
  const rejectedWithReason = [];
  for (const filePath of fragments) {
    const name = filePath.slice(FRAGMENT_DIR.length + 1);
    if (onBase.has(name)) {
      rejectedWithReason.push(
        `${filePath} — already on the base ref. Editing or deleting another PR's fragment is not your entry.`,
      );
    } else if (!Object.prototype.hasOwnProperty.call(fragmentFiles, name)) {
      rejectedWithReason.push(`${filePath} — not on disk. This branch removed it.`);
    } else if (!parsedOk.has(name)) {
      rejectedWithReason.push(`${filePath} — present but does not parse; see the problem above.`);
    } else {
      contributed.push(filePath);
    }
  }
  for (const filePath of ignoredInFragmentDir) {
    rejectedWithReason.push(
      `${filePath} — not a fragment: ${FRAGMENT_DIR}/ dotfiles and ${NON_FRAGMENT_FILES.join("/")} are infrastructure. ` +
        `Name it <issue>-<slug>.md.`,
    );
  }

  if (requiring.length > 0 && contributed.length === 0) {
    const sample = requiring.slice(0, 5).map((p) => `      ${p}`);
    if (requiring.length > 5) sample.push(`      ... and ${requiring.length - 5} more`);
    // Anything touched in the fragment directory that did not count is named
    // here. The first implementation printed "1 fragment(s) on this branch,
    // 0 fragment(s) in .changes/unreleased/" and passed anyway; the same
    // evidence now produces the failure and says which file and why.
    const touched =
      rejectedWithReason.length > 0
        ? `\n    This branch touches ${rejectedWithReason.length} file(s) in ${FRAGMENT_DIR}/, none of which counts:\n` +
          rejectedWithReason.map((line) => `      ${line}`).join("\n")
        : "";
    // An automated author cannot act on "create a fragment", so it is told the
    // thing a human CAN act on instead: the exemption is scoped to dependency
    // manifests on purpose, and widening it is one line in this file.
    const botNote = isAutomatedDependencyAuthor(author)
      ? `\n    Author ${String(author)} is exempt on dependency manifests only, and the path(s) above are not\n` +
        `    among them. Either this bot has started editing something new — in which case add a rule to\n` +
        `    DEPENDENCY_MANIFEST_RULES in scripts/lib/changelog-fragments-core.mjs — or the change genuinely\n` +
        `    warrants an entry a human must write.`
      : "";
    problems.push(
      `This branch changes ${requiring.length} non-exempt file(s) but adds no changelog fragment:\n` +
        `${sample.join("\n")}${touched}${botNote}\n` +
        `    Fix: create ${FRAGMENT_DIR}/<issue>-<slug>.md with "issue:" and "section:" frontmatter\n` +
        `    and the entry as markdown bullets. See .changes/README.md.`,
    );
  }

  return {
    ok: problems.length === 0,
    problems,
    requiring,
    authorExempt,
    addedFragments: fragments,
    contributed,
    parsed,
  };
}

/** Accepts `1.2.0` or `v1.2.0`, with an optional pre-release suffix. */
const VERSION_PATTERN = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

/** `YYYY-MM-DD`. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Render one version section from parsed fragments.
 *
 * The issue reference is appended here rather than written by hand, which is
 * what makes the frontmatter `issue` field load-bearing: every assembled entry
 * carries its traceability link and no author can forget one.
 *
 * @param {object} input
 * @param {ReturnType<typeof parseFragment>[]} input.fragments valid fragments
 * @param {string} input.version e.g. `1.1.0` or `v1.1.0`
 * @param {string} input.date `YYYY-MM-DD`
 * @returns {string} the rendered section, newline-terminated
 */
export function renderVersionSection({ fragments, version, date }) {
  const versionMatch = VERSION_PATTERN.exec(String(version ?? "").trim());
  if (!versionMatch) {
    throw new Error(`Invalid version ${JSON.stringify(version)} — expected semver such as 1.1.0.`);
  }
  if (!DATE_PATTERN.test(String(date ?? "").trim())) {
    throw new Error(`Invalid date ${JSON.stringify(date)} — expected YYYY-MM-DD.`);
  }
  if (fragments.length === 0) {
    throw new Error(`No fragments to assemble — nothing to release.`);
  }

  const lines = [`## [v${versionMatch[1]}] - ${date}`, ""];

  for (const section of SECTIONS) {
    const inSection = fragments
      .filter((fragment) => fragment.section === section)
      .sort((a, b) => (a.issue ?? 0) - (b.issue ?? 0) || a.filename.localeCompare(b.filename));
    if (inSection.length === 0) continue;

    lines.push(`### ${section}`, "");
    for (const fragment of inSection) {
      for (const block of groupEntryBlocks(fragment.entries)) {
        // The reference belongs at the end of the entry's prose, which is the
        // last line before any nested sub-point — not at the end of the first
        // physical line, which would land mid-sentence in a wrapped entry.
        const nested = block.findIndex((line, i) => i > 0 && ANY_BULLET.test(line));
        const refAt = nested > 0 ? nested - 1 : block.length - 1;
        block.forEach((line, i) => {
          lines.push(
            i === refAt && fragment.issue !== null
              ? `${line.trimEnd()} (#${fragment.issue})`
              : line.trimEnd(),
          );
        });
      }
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

/**
 * Insert a rendered version section into `CHANGELOG.md`.
 *
 * The section lands directly BELOW `## [Unreleased]` and above the previous
 * top version, which is where Keep a Changelog puts it. The existing
 * `[Unreleased]` body is left untouched: #1191 migrates forward and explicitly
 * does not rewrite the 996 entries already there.
 *
 * @param {string} changelogText
 * @param {string} rendered output of `renderVersionSection`
 * @returns {string}
 */
export function insertVersionSection(changelogText, rendered) {
  const text = typeof changelogText === "string" ? changelogText : "";
  const lines = text.split("\n");

  const unreleasedIndex = lines.findIndex((line) => /^##\s+\[Unreleased\]/i.test(line));
  let insertAt;
  if (unreleasedIndex >= 0) {
    const next = lines.findIndex((line, i) => i > unreleasedIndex && /^##\s+/.test(line));
    insertAt = next >= 0 ? next : lines.length;
  } else {
    const first = lines.findIndex((line) => /^##\s+/.test(line));
    insertAt = first >= 0 ? first : lines.length;
  }

  const block = `${rendered.trimEnd()}\n\n`.split("\n");
  // `block` ends with a trailing "" from the split; dropping it keeps exactly
  // one blank line between the new section and whatever follows.
  block.pop();
  return [...lines.slice(0, insertAt), ...block, ...lines.slice(insertAt)].join("\n");
}
