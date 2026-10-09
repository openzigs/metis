/**
 * #954 — the walkthrough's "fixes to verify" list, generated rather than hand-written.
 *
 * Before #954 the list each run verified (`{{FIXES_TO_VERIFY}}` in the briefs) was a dict in a
 * fill helper that lived in a session scratchpad: someone read ~40 merged PRs, picked the ones
 * that mattered and decided which wave covered each. Nothing said in advance what a run would
 * verify, and nothing carried "still unconfirmed" from one run to the next.
 *
 * This module is the pure half of `scripts/walkthrough/fixes-since.mjs`:
 *
 *  1. `collectFixes` lists the PRs merged on the first-parent line since the previous run's
 *     METIS SHA, through an injected `io.git` / `io.gh` seam (the runner passes `execFileSync`
 *     wrappers; the tests pass fixtures).
 *  2. It keeps the walkthrough-relevant ones (`relevanceReason`): the PR or a closing issue is
 *     labelled `e2e-walkthrough`, or the PR touches a UI page, a route, or one of the feature
 *     libraries the walkthrough exercises. Dependabot is listed apart and flagged only when it
 *     bumps a runtime (production) dependency.
 *  3. It places each one in a wave and phase from `docs/walkthroughs/fix-phase-map.json`
 *     (`lookupPhase`). Anything the map does not place goes to `unmapped`, which the fill
 *     helper refuses to fill briefs past: nothing is silently dropped.
 *  4. It carries forward every fix the previous `run.json` did not record as `confirmed`.
 *
 * The result is a reviewable `fixes.json`; `renderScopeComment` turns it into the comment
 * posted on #706 before wave A, and `confirmedOpenIssues` lists, after a run, the issues it
 * confirmed that are still open.
 */

/** Statuses a run records for each fix it was asked to verify (`run.json` `fixes[].status`). */
export const FIX_STATUSES = /** @type {const} */ ([
  "confirmed",
  "partial",
  "regressed",
  "not-exercised",
]);

/** Waves a fix can be verified in: the six browser waves plus the BA re-ask over the API. */
export const FIX_WAVES = /** @type {const} */ (["A", "B", "C", "D", "E", "F", "BA"]);

/** The label every walkthrough finding carries. */
export const WALKTHROUGH_LABEL = "e2e-walkthrough";

/** Feature libraries the walkthrough exercises; a PR touching one is relevant. */
export const RELEVANT_LIB_DIRS = /** @type {const} */ ([
  "analysis",
  "spec-kit",
  "publishing",
  "docs-gen",
  "traceability",
  "impact-analysis",
  "code-graph",
]);

const RELEVANT_PATH_RES = [
  // A UI page or a Next.js route handler.
  /^ui\/src\/app\/(?:.+\/)?(?:page|route)\.(?:tsx|ts|jsx|js)$/,
  // A server route.
  /^server\/src\/routes\//,
  // A feature library the walkthrough exercises.
  new RegExp(`^server/src/lib/(?:${RELEVANT_LIB_DIRS.join("|")})/`),
];

/** A test file or a file under a tests directory. */
const TEST_FILE_RE = /(?:^|\/)(?:__tests__|tests?)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** A git object name: hex only, so it can never be read as an option by git. */
const SHA_RE = /^[0-9a-f]{7,40}$/i;

/** A squash-merge subject ends with its PR number: `fix: … (#949)`. */
const PR_SUBJECT_RE = /\(#(\d+)\)\s*$/;

/** Dependabot's commit metadata names each bumped dependency's type. */
const RUNTIME_DEP_RE = /dependency-type:\s*direct:production/;

/**
 * @typedef {object} PhaseTarget
 * @property {string} wave
 * @property {string} phase
 * @property {string} [check]
 */

/**
 * A map entry that places a fix in no wave, on purpose: walkthrough tooling the operator
 * exercises, say. Listed in `fixes.json` `excluded` with its reason, so it is never silent.
 *
 * @typedef {object} PhaseSkip
 * @property {string} skip the reason
 */

/**
 * @typedef {object} PhaseMap
 * @property {Record<string, PhaseTarget | PhaseSkip>} issues keyed by issue number
 * @property {Record<string, PhaseTarget | PhaseSkip>} prs keyed by PR number
 */

/**
 * @typedef {object} Fix
 * @property {number} pr
 * @property {number[]} issues
 * @property {string} wave
 * @property {string} phase
 * @property {string} check
 * @property {string} [carried] the previous run's status, when carried forward
 */

/**
 * @typedef {object} UnmappedFix
 * @property {number} pr
 * @property {number[]} issues
 * @property {string} title
 * @property {string} reason why it is relevant
 */

/**
 * @typedef {object} DependabotPr
 * @property {number} pr
 * @property {string} title
 * @property {boolean} runtime true when it bumps a production dependency
 */

/**
 * @typedef {object} FixesDoc
 * @property {string} since
 * @property {string} head
 * @property {Fix[]} fixes
 * @property {UnmappedFix[]} unmapped
 * @property {Array<{ pr: number, issues: number[], reason: string }>} excluded placed in no
 *   wave by a `skip` map entry
 * @property {DependabotPr[]} dependabot
 * @property {number[]} skipped PRs merged in the range that are not walkthrough-relevant
 * @property {string[]} noPr first-parent commits with no PR number, as `<sha> <subject>`
 */

/**
 * @typedef {object} Io
 * @property {(args: string[]) => string} git
 * @property {(args: string[]) => string} gh
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isPositiveInt(value) {
  return Number.isInteger(value) && Number(value) > 0;
}

/**
 * @param {string} value
 * @returns {boolean}
 */
export function isSha(value) {
  return SHA_RE.test(value);
}

/**
 * Whether a changed file makes its PR walkthrough-relevant.
 *
 * @param {string} file repository-relative, `/`-separated
 * @returns {boolean}
 */
export function isRelevantPath(file) {
  // A test beside a route changes nothing a user can see.
  if (TEST_FILE_RE.test(file)) return false;
  return RELEVANT_PATH_RES.some((re) => re.test(file));
}

/**
 * Parse `git log --first-parent --format=%H%x1f%s%x1f%b%x1e`.
 *
 * @param {string} text
 * @returns {Array<{ sha: string, subject: string, body: string, pr: number | null }>}
 */
export function parseFirstParentLog(text) {
  return text
    .split("\x1e")
    .map((record) => record.replace(/^\s+/, ""))
    .filter((record) => record.trim() !== "")
    .map((record) => {
      const [sha = "", subject = "", body = ""] = record.split("\x1f");
      const m = PR_SUBJECT_RE.exec(subject);
      return { sha: sha.trim(), subject: subject.trim(), body, pr: m ? Number(m[1]) : null };
    });
}

/**
 * @param {string} login
 * @returns {boolean}
 */
export function isDependabot(login) {
  return /dependabot/i.test(login);
}

/**
 * @param {string} body the merge commit's body, which carries Dependabot's metadata
 * @returns {boolean}
 */
export function isRuntimeDependencyBump(body) {
  return RUNTIME_DEP_RE.test(body);
}

/**
 * Why a PR is walkthrough-relevant, or null when it is not.
 *
 * @param {{ labels: string[], issueLabels: string[][], files: string[] }} pr
 * @returns {string | null}
 */
export function relevanceReason(pr) {
  if (pr.labels.includes(WALKTHROUGH_LABEL)) return `PR labelled ${WALKTHROUGH_LABEL}`;
  if (pr.issueLabels.some((labels) => labels.includes(WALKTHROUGH_LABEL))) {
    return `closing issue labelled ${WALKTHROUGH_LABEL}`;
  }
  const file = pr.files.find(isRelevantPath);
  return file ? `touches ${file}` : null;
}

/**
 * Validate one map entry.
 *
 * @param {unknown} raw
 * @param {string} at
 * @param {string[]} errors
 * @returns {raw is PhaseTarget | PhaseSkip}
 */
function checkTarget(raw, at, errors) {
  if (!isPlainObject(raw)) {
    errors.push(`${at}: expected a JSON object`);
    return false;
  }
  const before = errors.length;
  if (raw.skip !== undefined) {
    if (Object.keys(raw).length !== 1) errors.push(`${at}: a "skip" entry takes no other field`);
    if (typeof raw.skip !== "string" || raw.skip.trim() === "") {
      errors.push(`${at}: "skip" must be a non-empty reason`);
    }
    return errors.length === before;
  }
  for (const key of Object.keys(raw)) {
    if (!["wave", "phase", "check"].includes(key)) errors.push(`${at}: unknown field "${key}"`);
  }
  if (!FIX_WAVES.includes(/** @type {any} */ (raw.wave))) {
    errors.push(`${at}: "wave" must be one of ${FIX_WAVES.join(", ")}`);
  }
  if (typeof raw.phase !== "string" || raw.phase.trim() === "") {
    errors.push(`${at}: "phase" must be a non-empty string`);
  }
  if (raw.check !== undefined && (typeof raw.check !== "string" || raw.check.trim() === "")) {
    errors.push(`${at}: "check" must be a non-empty string when present`);
  }
  return errors.length === before;
}

/**
 * Parse and validate `docs/walkthroughs/fix-phase-map.json`. Strict: an unknown key, a key that
 * is not a number, or a wave outside `FIX_WAVES` is an error. A top-level `$comment` is allowed.
 *
 * @param {string} text
 * @returns {{ map: PhaseMap | null, errors: string[] }}
 */
export function parsePhaseMap(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { map: null, errors: ["fix-phase-map.json: not valid JSON"] };
  }
  if (!isPlainObject(raw)) {
    return { map: null, errors: ["fix-phase-map.json: expected a JSON object"] };
  }
  /** @type {string[]} */
  const errors = [];
  for (const key of Object.keys(raw)) {
    if (!["$comment", "issues", "prs"].includes(key)) {
      errors.push(`fix-phase-map.json: unknown field "${key}"`);
    }
  }
  /** @type {PhaseMap} */
  const map = { issues: {}, prs: {} };
  for (const section of /** @type {const} */ (["issues", "prs"])) {
    const value = raw[section];
    if (value === undefined) continue;
    if (!isPlainObject(value)) {
      errors.push(`fix-phase-map.json: "${section}" must be an object keyed by number`);
      continue;
    }
    for (const [key, target] of Object.entries(value)) {
      const at = `fix-phase-map.json ${section}.${key}`;
      if (!/^[1-9]\d*$/.test(key)) {
        errors.push(`${at}: key must be a positive number`);
        continue;
      }
      if (checkTarget(target, at, errors)) map[section][key] = target;
    }
  }
  return errors.length > 0 ? { map: null, errors } : { map, errors: [] };
}

/**
 * The wave and phase for a fix: the first closing issue the map names, then the PR.
 *
 * @param {PhaseMap} map
 * @param {{ pr: number, issues: number[] }} fix
 * @returns {PhaseTarget | PhaseSkip | null}
 */
export function lookupPhase(map, fix) {
  for (const issue of fix.issues) {
    const hit = map.issues[String(issue)];
    if (hit) return hit;
  }
  return map.prs[String(fix.pr)] ?? null;
}

/**
 * Validate one fix entry, as it appears in `fixes.json` or (with a status) in `run.json`.
 *
 * @param {unknown} raw
 * @param {string} at
 * @param {{ withStatus: boolean, knownExtra?: string[] }} opts
 * @param {string[]} errors
 * @returns {boolean} true when valid
 */
export function checkFix(raw, at, opts, errors) {
  if (!isPlainObject(raw)) {
    errors.push(`${at}: expected a JSON object`);
    return false;
  }
  const before = errors.length;
  const known = new Set([
    "pr",
    "issues",
    "wave",
    "phase",
    "check",
    "carried",
    ...(opts.withStatus ? ["status", "evidence"] : []),
    ...(opts.knownExtra ?? []),
  ]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) errors.push(`${at}: unknown field "${key}"`);
  }
  if (!isPositiveInt(raw.pr)) errors.push(`${at}: "pr" must be a positive PR number`);
  if (!(Array.isArray(raw.issues) && raw.issues.every(isPositiveInt))) {
    errors.push(`${at}: "issues" must be an array of positive issue numbers`);
  }
  if (!FIX_WAVES.includes(/** @type {any} */ (raw.wave))) {
    errors.push(`${at}: "wave" must be one of ${FIX_WAVES.join(", ")}`);
  }
  for (const key of ["phase", "check"]) {
    if (typeof raw[key] !== "string" || /** @type {string} */ (raw[key]).trim() === "") {
      errors.push(`${at}: "${key}" must be a non-empty string`);
    }
  }
  if (raw.carried !== undefined && !FIX_STATUSES.includes(/** @type {any} */ (raw.carried))) {
    errors.push(`${at}: "carried" must be one of ${FIX_STATUSES.join(", ")} when present`);
  }
  if (opts.withStatus) {
    if (!FIX_STATUSES.includes(/** @type {any} */ (raw.status))) {
      errors.push(`${at}: "status" must be one of ${FIX_STATUSES.join(", ")}`);
    }
    if (raw.evidence !== undefined && (typeof raw.evidence !== "string" || raw.evidence === "")) {
      errors.push(`${at}: "evidence" must be a step id when present`);
    }
    // Every verdict but "not exercised" claims something was seen, so it names the step.
    if (raw.status !== "not-exercised" && FIX_STATUSES.includes(/** @type {any} */ (raw.status))) {
      if (raw.evidence === undefined) {
        errors.push(`${at}: "evidence" (a step id) is required when "status" is "${raw.status}"`);
      }
    }
  }
  return errors.length === before;
}

/**
 * Parse and validate a `fixes.json` written by `fixes-since` (and reviewed by a human).
 *
 * @param {string} text
 * @returns {{ doc: FixesDoc | null, errors: string[] }}
 */
export function parseFixesDoc(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { doc: null, errors: ["fixes.json: not valid JSON"] };
  }
  if (!isPlainObject(raw)) return { doc: null, errors: ["fixes.json: expected a JSON object"] };
  /** @type {string[]} */
  const errors = [];
  const fields = [
    "since",
    "head",
    "fixes",
    "unmapped",
    "excluded",
    "dependabot",
    "skipped",
    "noPr",
  ];
  for (const key of Object.keys(raw)) {
    if (!fields.includes(key)) errors.push(`fixes.json: unknown field "${key}"`);
  }
  for (const key of ["since", "head"]) {
    if (typeof raw[key] !== "string" || !isSha(/** @type {string} */ (raw[key]))) {
      errors.push(`fixes.json: "${key}" must be a commit SHA`);
    }
  }
  if (!Array.isArray(raw.fixes)) {
    errors.push(`fixes.json: "fixes" must be an array`);
  } else {
    const seen = new Set();
    raw.fixes.forEach((fix, i) => {
      const at = `fixes.json fixes[${i}]`;
      if (checkFix(fix, at, { withStatus: false }, errors)) {
        const pr = /** @type {Fix} */ (fix).pr;
        if (seen.has(pr)) errors.push(`${at}: duplicate PR #${pr}`);
        seen.add(pr);
      }
    });
  }
  for (const key of ["unmapped", "excluded", "dependabot", "skipped", "noPr"]) {
    if (!Array.isArray(raw[key])) errors.push(`fixes.json: "${key}" must be an array`);
  }
  if (errors.length > 0) return { doc: null, errors };
  return { doc: /** @type {FixesDoc} */ (/** @type {unknown} */ (raw)), errors: [] };
}

/**
 * The fixes a previous run left unconfirmed, to verify again.
 *
 * @param {{ fixes?: Array<Fix & { status: string }> } | null | undefined} previousRun
 * @returns {Fix[]}
 */
export function carryForward(previousRun) {
  return (previousRun?.fixes ?? [])
    .filter((f) => f.status !== "confirmed")
    .map((f) => ({
      pr: f.pr,
      issues: [...f.issues],
      wave: f.wave,
      phase: f.phase,
      check: f.check,
      carried: f.status,
    }));
}

/**
 * Order fixes by wave (run order), then PR.
 *
 * @param {Fix[]} fixes
 * @returns {Fix[]}
 */
export function orderFixes(fixes) {
  return [...fixes].sort(
    (a, b) =>
      FIX_WAVES.indexOf(/** @type {any} */ (a.wave)) -
        FIX_WAVES.indexOf(/** @type {any} */ (b.wave)) || a.pr - b.pr,
  );
}

/**
 * @param {string} text
 * @param {string} what
 * @returns {any}
 */
function parseGhJson(text, what) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`gh returned invalid JSON for ${what}`);
  }
}

/**
 * List, classify and place every PR merged on the first-parent line in `since..head`.
 *
 * @param {{ since: string, head?: string, map: PhaseMap, previousRun?: { fixes?: Array<Fix & { status: string }> } | null, io: Io }} opts
 * @returns {FixesDoc}
 */
export function collectFixes(opts) {
  const head = opts.head ?? "HEAD";
  if (!isSha(opts.since)) throw new Error(`--since must be a commit SHA, got "${opts.since}"`);
  if (head !== "HEAD" && !isSha(head)) throw new Error(`--head must be a commit SHA`);
  const { io, map } = opts;

  const headSha = io.git(["rev-parse", head]).trim();
  const commits = parseFirstParentLog(
    io.git(["log", "--first-parent", "--format=%H%x1f%s%x1f%b%x1e", `${opts.since}..${head}`]),
  );

  /** @type {Fix[]} */
  const fixes = [];
  /** @type {UnmappedFix[]} */
  const unmapped = [];
  /** @type {FixesDoc["excluded"]} */
  const excluded = [];
  /** @type {DependabotPr[]} */
  const dependabot = [];
  /** @type {number[]} */
  const skipped = [];
  /** @type {string[]} */
  const noPr = [];
  /** @type {Map<number, { title: string, labels: string[] }>} */
  const issueCache = new Map();

  for (const commit of commits) {
    if (commit.pr === null) {
      noPr.push(`${commit.sha.slice(0, 8)} ${commit.subject}`);
      continue;
    }
    const pr = parseGhJson(
      io.gh([
        "pr",
        "view",
        String(commit.pr),
        "--json",
        "number,title,author,labels,closingIssuesReferences",
      ]),
      `PR #${commit.pr}`,
    );
    const title = String(pr.title ?? commit.subject);
    if (isDependabot(String(pr.author?.login ?? ""))) {
      dependabot.push({ pr: commit.pr, title, runtime: isRuntimeDependencyBump(commit.body) });
      continue;
    }
    /** @type {number[]} */
    const issues = (pr.closingIssuesReferences ?? [])
      .map((/** @type {{ number: number }} */ r) => r.number)
      .filter(isPositiveInt)
      .sort((/** @type {number} */ a, /** @type {number} */ b) => a - b);
    const issueInfo = issues.map((n) => {
      let info = issueCache.get(n);
      if (!info) {
        const raw = parseGhJson(
          io.gh(["issue", "view", String(n), "--json", "title,labels"]),
          `issue #${n}`,
        );
        info = {
          title: String(raw.title ?? ""),
          labels: (raw.labels ?? []).map((/** @type {{ name: string }} */ l) => l.name),
        };
        issueCache.set(n, info);
      }
      return info;
    });
    const files = io
      .git(["diff-tree", "--no-commit-id", "--name-only", "-r", "-m", "--first-parent", commit.sha])
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);
    const reason = relevanceReason({
      labels: (pr.labels ?? []).map((/** @type {{ name: string }} */ l) => l.name),
      issueLabels: issueInfo.map((i) => i.labels),
      files,
    });
    if (!reason) {
      skipped.push(commit.pr);
      continue;
    }
    const target = lookupPhase(map, { pr: commit.pr, issues });
    if (!target) {
      unmapped.push({ pr: commit.pr, issues, title, reason });
      continue;
    }
    if ("skip" in target) {
      excluded.push({ pr: commit.pr, issues, reason: target.skip });
      continue;
    }
    fixes.push({
      pr: commit.pr,
      issues,
      wave: target.wave,
      phase: target.phase,
      check: target.check ?? issueInfo[0]?.title ?? title,
    });
  }

  const fresh = new Set(fixes.map((f) => f.pr));
  for (const carried of carryForward(opts.previousRun)) {
    if (!fresh.has(carried.pr)) fixes.push(carried);
  }

  return {
    since: opts.since,
    head: headSha,
    fixes: orderFixes(fixes),
    unmapped,
    excluded,
    dependabot,
    skipped: skipped.sort((a, b) => a - b),
    noPr,
  };
}

/**
 * One fix as a Markdown list line, shared by the scope comment and the briefs.
 *
 * @param {Fix} fix
 * @returns {string}
 */
export function fixLine(fix) {
  const closes = fix.issues.length ? ` (closes ${fix.issues.map((n) => `#${n}`).join(", ")})` : "";
  const carried = fix.carried ? ` *Carried forward: ${fix.carried} last run.*` : "";
  return `- PR #${fix.pr}${closes}, Phase ${fix.phase}: ${fix.check}${carried}`;
}

/**
 * The comment posted on #706 before wave A: every fix the run will verify, grouped by wave.
 *
 * @param {FixesDoc} doc
 * @param {{ run: number | string }} opts
 * @returns {string}
 */
export function renderScopeComment(doc, opts) {
  const lines = [
    `## Walkthrough run ${opts.run}: fixes to verify`,
    "",
    `METIS \`${doc.head.slice(0, 8)}\`, PRs merged since \`${doc.since.slice(0, 8)}\`` +
      ` plus fixes the previous run left unconfirmed. Generated by` +
      " `scripts/walkthrough/fixes-since.mjs`.",
    "",
  ];
  const ordered = orderFixes(doc.fixes);
  for (const wave of FIX_WAVES) {
    const list = ordered.filter((f) => f.wave === wave);
    if (list.length === 0) continue;
    lines.push(`### Wave ${wave} (${list.length})`, "", ...list.map(fixLine), "");
  }
  if (ordered.length === 0) lines.push("No fixes to verify.", "");
  if (doc.excluded.length > 0) {
    lines.push(
      `### Not verified by a wave (${doc.excluded.length})`,
      "",
      ...doc.excluded.map((e) => `- PR #${e.pr}: ${e.reason}`),
      "",
    );
  }
  const runtime = doc.dependabot.filter((d) => d.runtime);
  if (runtime.length > 0) {
    lines.push(
      "### Runtime dependency bumps",
      "",
      ...runtime.map((d) => `- PR #${d.pr}: ${d.title}`),
      "",
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Issues a run confirmed that are still open, to close with a link to the results comment.
 *
 * @param {{ fixes?: Array<{ status: string, issues: number[] }> }} run
 * @param {Io} io
 * @returns {number[]}
 */
export function confirmedOpenIssues(run, io) {
  const confirmed = [
    ...new Set((run.fixes ?? []).filter((f) => f.status === "confirmed").flatMap((f) => f.issues)),
  ].sort((a, b) => a - b);
  return confirmed.filter((n) => {
    const raw = parseGhJson(io.gh(["issue", "view", String(n), "--json", "state"]), `issue #${n}`);
    return raw.state === "OPEN";
  });
}
