/**
 * #848 — keep a red nightly `ci.yml` run from going unnoticed. Pure logic plus an
 * injectable GitHub REST client; the env/argv glue lives in
 * `scripts/ci-nightly-report.mjs`, and the job that runs it is `nightly-report`
 * in `.github/workflows/ci.yml`.
 *
 * GitHub notifies only the user who last edited a workflow's `cron` line when a
 * scheduled run fails. Since #844 moved `postgres-adapter` and the `api` image
 * build/smoke off ordinary PRs onto `main` pushes and the nightly, a red nightly
 * is the only signal for whatever those path gates miss. So:
 *
 *   nightly red,   no open `ci-nightly` issue -> open one (run URL + failing jobs)
 *   nightly red,   an open `ci-nightly` issue -> comment on it (one thread per outage)
 *   nightly green, an open `ci-nightly` issue -> comment with the green run, close it
 *   nightly green, none open                  -> nothing
 *
 * A job result that is neither `success` nor `skipped` counts as FAILED — the
 * unknown case fails closed, so a new conclusion GitHub might add is reported
 * rather than read as green. `skipped` is acceptable: a job whose `if:` is false
 * on a schedule run did not fail.
 */

export const NIGHTLY_LABEL = "ci-nightly";
export const NIGHTLY_LABEL_COLOR = "d93f0b";
export const NIGHTLY_LABEL_DESCRIPTION = "Tracks a failing nightly CI run (opened by ci.yml, #848)";
export const NIGHTLY_ISSUE_TITLE = "Nightly CI is failing";

/** Job results that do not count as a failure. Everything else does. */
const ACCEPTABLE_RESULTS = new Set(["success", "skipped"]);

/** Job-API conclusions that name a job as failing (used for the detailed list). */
const FAILING_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out", "action_required"]);

/**
 * The jobs of a `needs` context (`${{ toJSON(needs) }}`) that did not pass, sorted.
 *
 * @param {Record<string, { result?: string } | undefined>} needs
 * @returns {string[]}
 */
export function failedJobs(needs) {
  if (needs === null || typeof needs !== "object" || Array.isArray(needs)) {
    throw new TypeError("needs must be an object of job id -> { result }");
  }
  return Object.entries(needs)
    .filter(([, value]) => !ACCEPTABLE_RESULTS.has(String(value?.result ?? "")))
    .map(([id]) => id)
    .sort();
}

/**
 * The display names of the run's failing jobs, from the Actions jobs API — this is
 * what separates `e2e (2/3)` from its siblings, which `needs` folds into one `e2e`.
 *
 * @param {Array<{ name?: string, conclusion?: string | null }>} jobs
 * @returns {string[]}
 */
export function failingJobNames(jobs) {
  return jobs
    .filter((j) => typeof j.name === "string" && FAILING_CONCLUSIONS.has(String(j.conclusion)))
    .map((j) => /** @type {string} */ (j.name))
    .sort();
}

/** Markdown code span that a job name cannot break out of. @param {string} s */
const code = (s) => `\`${s.replace(/`/g, "'")}\``;

/**
 * @param {{ runUrl: string, sha?: string, jobs: string[] }} input
 * @returns {string}
 */
export function failureBody({ runUrl, sha, jobs }) {
  const lines = [`The nightly \`ci.yml\` run failed: ${runUrl}`, ""];
  if (sha) lines.push(`Commit: ${sha}`, "");
  lines.push("Failing jobs:");
  if (jobs.length === 0) lines.push("- (none reported; read the run)");
  for (const job of jobs) lines.push(`- ${code(job)}`);
  lines.push(
    "",
    "Opened by the `nightly-report` job (#848). A later green nightly comments here and closes this issue.",
  );
  return lines.join("\n");
}

/**
 * @param {{ runUrl: string, sha?: string }} input
 * @returns {string}
 */
export function recoveryBody({ runUrl, sha }) {
  const lines = [`The nightly \`ci.yml\` run is green again: ${runUrl}`];
  if (sha) lines.push("", `Commit: ${sha}`);
  lines.push("", "Closing (#848).");
  return lines.join("\n");
}

/**
 * @typedef {object} IssueClient
 * @property {() => Promise<void>} ensureLabel
 * @property {() => Promise<{ number: number } | null>} findOpenIssue
 * @property {(input: { title: string, body: string, labels: string[] }) => Promise<{ number: number }>} createIssue
 * @property {(issue: number, body: string) => Promise<void>} comment
 * @property {(issue: number) => Promise<void>} closeIssue
 */

/**
 * @typedef {{ action: "created" | "commented" | "closed" | "none", issue: number | null, failed: string[] }} ReportResult
 */

/**
 * Open, update or close the tracking issue for one nightly run.
 *
 * @param {object} input
 * @param {Record<string, { result?: string } | undefined>} input.needs
 * @param {string} input.runUrl
 * @param {string} [input.sha]
 * @param {string[] | null} [input.detailedJobs] failing job names from the jobs API, if read
 * @param {IssueClient} input.client
 * @returns {Promise<ReportResult>}
 */
export async function reportNightly({ needs, runUrl, sha, detailedJobs, client }) {
  const failed = failedJobs(needs);
  const open = await client.findOpenIssue();

  if (failed.length === 0) {
    if (!open) return { action: "none", issue: null, failed };
    await client.comment(open.number, recoveryBody({ runUrl, sha }));
    await client.closeIssue(open.number);
    return { action: "closed", issue: open.number, failed };
  }

  // Prefer the precise names (one per matrix shard); fall back to the `needs` ids
  // when the jobs API was unavailable or listed nothing failing.
  const jobs = detailedJobs && detailedJobs.length > 0 ? detailedJobs : failed;
  const body = failureBody({ runUrl, sha, jobs });
  if (open) {
    await client.comment(open.number, body);
    return { action: "commented", issue: open.number, failed };
  }
  await client.ensureLabel();
  const created = await client.createIssue({
    title: NIGHTLY_ISSUE_TITLE,
    body,
    labels: [NIGHTLY_LABEL],
  });
  return { action: "created", issue: created.number, failed };
}

/**
 * A minimal GitHub REST client over `fetch`, injectable for tests.
 *
 * @param {object} options
 * @param {string} options.token
 * @param {string} options.repository `owner/name`
 * @param {string} [options.apiUrl]
 * @param {typeof fetch} [options.fetchImpl]
 */
export function createGitHubClient({
  token,
  repository,
  apiUrl = "https://api.github.com",
  fetchImpl = fetch,
}) {
  if (!token) throw new Error("a GitHub token is required (GH_TOKEN)");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "")) {
    throw new Error(`repository must be owner/name, got ${JSON.stringify(repository)}`);
  }
  const base = `${apiUrl.replace(/\/+$/, "")}/repos/${repository}`;

  /**
   * @param {string} method
   * @param {string} path
   * @param {unknown} [body]
   * @param {{ allow404?: boolean }} [opts]
   * @returns {Promise<any>}
   */
  async function request(method, path, body, { allow404 = false } = {}) {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (allow404 && res.status === 404) return null;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`GitHub API ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    }
    return res.status === 204 ? null : res.json();
  }

  const label = encodeURIComponent(NIGHTLY_LABEL);

  return {
    async ensureLabel() {
      const existing = await request("GET", `/labels/${label}`, undefined, { allow404: true });
      if (existing) return;
      await request("POST", "/labels", {
        name: NIGHTLY_LABEL,
        color: NIGHTLY_LABEL_COLOR,
        description: NIGHTLY_LABEL_DESCRIPTION,
      });
    },

    /** @returns {Promise<{ number: number } | null>} the most recently created open one */
    async findOpenIssue() {
      const list = await request(
        "GET",
        `/issues?state=open&labels=${label}&sort=created&direction=desc&per_page=100`,
      );
      // The issues endpoint also returns pull requests; a PR is never the tracker.
      const issue = (Array.isArray(list) ? list : []).find(
        (/** @type {any} */ i) => !i.pull_request && Number.isInteger(i.number),
      );
      return issue ? { number: issue.number } : null;
    },

    /** @param {{ title: string, body: string, labels: string[] }} input */
    async createIssue(input) {
      const created = await request("POST", "/issues", input);
      return { number: created.number };
    },

    /** @param {number} issue @param {string} body */
    async comment(issue, body) {
      await request("POST", `/issues/${issue}/comments`, { body });
    },

    /** @param {number} issue */
    async closeIssue(issue) {
      await request("PATCH", `/issues/${issue}`, { state: "closed", state_reason: "completed" });
    },

    /**
     * @param {string | number} runId
     * @returns {Promise<Array<{ name?: string, conclusion?: string | null }>>}
     */
    async listRunJobs(runId) {
      if (!/^\d+$/.test(String(runId))) throw new Error(`run id must be numeric, got ${runId}`);
      const res = await request("GET", `/actions/runs/${runId}/jobs?filter=latest&per_page=100`);
      return Array.isArray(res?.jobs) ? res.jobs : [];
    },
  };
}
