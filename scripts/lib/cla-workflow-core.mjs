/**
 * Pure audit core for the CLA-workflow gate (#1301).
 *
 * ## The bug this exists to make impossible
 *
 * `contributor-assistant/github-action` takes two inputs whose names read like
 * "which repository is this": `remote-organization-name` and
 * `remote-repository-name`. They do not mean that. They mean *"store the signature
 * file in a DIFFERENT repository"*, and setting **either one** — even to this
 * repository's own org and name — flips every signature read and write onto a
 * personal-access-token client:
 *
 *   * `src/persistence/persistence.ts` — `isRemoteRepoOrOrgConfigured()` returns true
 *     on `getRemoteRepoName() || getRemoteOrgName()`, and `getFileContent`,
 *     `createFile` and `updateFile` then all call `getPATOctokit()`;
 *   * `src/octokit.ts` — `getPATOctokit()` calls `core.setFailed("Please add a
 *     personal access token...")` when `PERSONAL_ACCESS_TOKEN` is absent.
 *
 * Same-repository storage is the action's default, so the correct configuration is to
 * set neither input. Verified in the pinned action at
 * `ca4a40a7d1004f18d9960b404b97e5f30a505a08` and in the `dist/index.js` it actually
 * executes.
 *
 * ## Why a gate rather than a comment in the workflow
 *
 * Both inputs are plausible-looking things to add back — the next person to read that
 * file will see a workflow that never names its own repository and will reach for
 * exactly these keys. And the failure is invisible until a *real outside contributor*
 * opens their first pull request and tries to sign, which in a first-party repository
 * may be months after the change that broke it. Nothing in `lint`, `typecheck`,
 * `test` or any CI job exercises the signing path. A comment does not fail a build.
 *
 * ## Why the rule is "input requires token", not "input forbidden"
 *
 * Storing signatures in a separate repository is a legitimate configuration; it just
 * requires the token. Writing the gate as the real precondition means a future
 * maintainer who genuinely wants remote storage is told what to add rather than being
 * told "no", and the gate stays true instead of becoming a rule people route around.
 *
 * ## Fail-closed, deliberately
 *
 * A workflow whose CLA step cannot be located at all is a FAILURE (`no-cla-step`),
 * not a skip. #1168 measured four gates in one week that passed because their default
 * meant "nothing to check"; an audit that returns clean when its subject has been
 * renamed out from under it is that same shape.
 */

/** Inputs that switch the action onto its personal-access-token code path. */
export const PAT_REQUIRING_INPUTS = Object.freeze([
  "remote-organization-name",
  "remote-repository-name",
]);

/** Environment variable those inputs then require. */
export const PAT_ENV_VAR = "PERSONAL_ACCESS_TOKEN";

/** Action whose step this gate audits, without its version suffix. */
export const CLA_ACTION = "contributor-assistant/github-action";

/**
 * Indentation of a line, in spaces. Tabs are not valid YAML indentation, so a line
 * containing one is reported as having no recognisable indent.
 *
 * @param {string} line
 * @returns {number}
 */
function indentOf(line) {
  const match = /^( *)\S/.exec(line);
  return match === null ? -1 : match[1].length;
}

/**
 * Column at which a step's keys begin, given any line belonging to that step.
 *
 * @param {string} line
 * @returns {number}
 */
function stepKeyIndent(line) {
  const match = /^( *)(- +)?/.exec(line);
  if (match === null) return indentOf(line);
  return match[1].length + (match[2] === undefined ? 0 : match[2].length);
}

/**
 * Immediate child keys of the block that starts at `startIndex`.
 *
 * Only lines at exactly the block's own indentation count, so the body of a folded
 * scalar (`custom-notsigned-prcomment: >-`) contributes nothing however many colons
 * it contains, and a nested mapping contributes only its own key.
 *
 * @param {string[]} lines whole file, split
 * @param {number} startIndex index of the line holding `with:` or `env:`
 * @returns {string[]} child key names, in file order
 */
function childKeys(lines, startIndex) {
  const parentIndent = indentOf(lines[startIndex]);
  /** @type {string[]} */
  const keys = [];
  let blockIndent = null;

  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim().length === 0) continue;
    const indent = indentOf(line);
    if (indent <= parentIndent) break;
    if (blockIndent === null) blockIndent = indent;
    if (indent !== blockIndent) continue;
    if (line.trim().startsWith("#")) continue;
    const match = /^ *([A-Za-z0-9_.-]+):/.exec(line);
    if (match !== null) keys.push(match[1]);
  }

  return keys;
}

/**
 * Locate the CLA step and read the input and environment keys it declares.
 *
 * @param {string} text contents of the workflow file
 * @returns {{found: boolean, withKeys: string[], envKeys: string[]}}
 */
export function extractClaStep(text) {
  const lines = text.split(/\r?\n/);
  const stepIndex = lines.findIndex(
    (line) => !line.trim().startsWith("#") && line.includes(`uses:`) && line.includes(CLA_ACTION),
  );
  if (stepIndex === -1) return { found: false, withKeys: [], envKeys: [] };

  // A step's keys sit at the indentation of its FIRST key, which is not the
  // indentation of the line when that line opens the list item: in
  // `      - uses: ...` the dash is at column 6 and `uses` at column 8, and `with:`
  // will be at 8. Measuring the dash instead makes every sibling key look nested,
  // `withKeys` comes back empty, and the gate reports CLEAN on a workflow it never
  // read — the fail-open shape this module exists to prevent, found by its own test.
  const stepIndent = stepKeyIndent(lines[stepIndex]);
  /** @type {string[]} */
  let withKeys = [];
  /** @type {string[]} */
  let envKeys = [];

  for (let i = stepIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim().length === 0) continue;
    const indent = indentOf(line);
    // A new list item, or dedent out of this step, ends it.
    if (indent < stepIndent || line.trim().startsWith("- ")) break;
    if (indent !== stepIndent) continue;
    const trimmed = line.trim();
    if (trimmed === "with:") withKeys = childKeys(lines, i);
    if (trimmed === "env:") envKeys = childKeys(lines, i);
  }

  return { found: true, withKeys, envKeys };
}

/**
 * @typedef {object} ClaFinding
 * @property {"no-cla-step" | "pat-input-without-token"} kind
 * @property {string} detail  human-readable explanation
 */

/**
 * Audit one CLA workflow.
 *
 * @param {string | null} text workflow contents, or `null` when it could not be read
 * @returns {{findings: ClaFinding[], withKeys: string[], envKeys: string[]}}
 */
export function auditClaWorkflow(text) {
  if (typeof text !== "string") {
    return {
      findings: [
        {
          kind: "no-cla-step",
          detail: `the CLA workflow could not be read, so the ${CLA_ACTION} step could not be audited`,
        },
      ],
      withKeys: [],
      envKeys: [],
    };
  }

  const step = extractClaStep(text);
  if (!step.found) {
    return {
      findings: [
        {
          kind: "no-cla-step",
          detail: `no step using ${CLA_ACTION} was found; this gate audits that step and has nothing to audit`,
        },
      ],
      withKeys: [],
      envKeys: [],
    };
  }

  const hasToken = step.envKeys.includes(PAT_ENV_VAR);
  const findings = hasToken
    ? []
    : PAT_REQUIRING_INPUTS.filter((input) => step.withKeys.includes(input)).map((input) => ({
        /** @type {"pat-input-without-token"} */
        kind: "pat-input-without-token",
        detail:
          `\`${input}\` means "store signatures in a DIFFERENT repository" and puts every ` +
          `signature read and write on the ${PAT_ENV_VAR} client, which this workflow does ` +
          `not supply — the action calls core.setFailed on the first contributor who tries ` +
          `to sign. Same-repository storage is the default: delete the input.`,
      }));

  return { findings, withKeys: step.withKeys, envKeys: step.envKeys };
}

/**
 * @param {{findings: ClaFinding[]}} result
 * @returns {boolean}
 */
export function isClean(result) {
  return result.findings.length === 0;
}

/**
 * @param {{findings: ClaFinding[]}} result
 * @param {string} path workflow path, for the report
 * @returns {string}
 */
export function formatReport(result, path) {
  if (isClean(result)) {
    return `CLA workflow gate: ${path} is configured for same-repository signature storage.`;
  }
  const lines = [`CLA workflow gate: ${result.findings.length} problem(s) in ${path}`];
  for (const finding of result.findings) lines.push(`  [${finding.kind}] ${finding.detail}`);
  return lines.join("\n");
}
