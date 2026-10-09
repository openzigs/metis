/**
 * #953 — the live `/speckit.taskstoissues` export: a real GitHub issue client,
 * guarded the same way as the draft pull request (`draft-pull-request.ts`).
 *
 * Safety rules, each mirroring the draft-PR path:
 *  - **Target.** A live run never takes an owner/repo from the request: the
 *    target is the one the dry run resolved from project/server configuration
 *    (`SpecKitConfig.tasksToIssuesRepo`, the saved publish target, then
 *    `SPECKIT_TASKS_DEFAULT_REPO`). It is refused when it is one of the
 *    project's analysed repositories (soft-deleted ones included) or, on a live
 *    run, the fork `parent`/`source` of an analysed GitHub repository. The
 *    upstream lookup fails closed. Only the public GitHub API is used.
 *  - **Credential.** A `${vault:label}` reference only — never a token — bound
 *    to one secret id (#577) and judged as a new destination (#344): the caller
 *    must own the secret unless they hold `vault.reveal`. The token is read at
 *    use and never returned, logged or put in an error.
 *  - **Dry-run parity.** A live run must present the dry run's `tasks.md`
 *    version and `planDigest`; the runner refuses 409 before creating anything
 *    when either no longer matches, so the live run files exactly the titles
 *    that were previewed. A live run without them is refused 409.
 *  - **Size.** One export creates at most `SPECKIT_EXPORT_MAX_ISSUES` issues.
 *  - **Audit.** A completed export, a failed one (with how many issues it had
 *    created) and a refused one each write an audit entry — a refusal at the
 *    planning stage included (the runner audits those); the credential
 *    binding is audited by the vault layer.
 *  - **Claims (#962).** Each task is claimed before GitHub is called. A claim
 *    is kept on an ambiguous failure (network error, 5xx, malformed 2xx) and
 *    expires after `SPECKIT_EXPORT_CLAIM_TTL_MS`; either way the next run, or
 *    "Clear stuck export" ({@link clearStuckTasksExport}), looks for the issue
 *    on the guarded target before creating it, and adopts it when found —
 *    only an issue the token's own user filed, updated since the task was
 *    first claimed (a takeover never moves that time).
 * Rate limiting is applied at the route (`spec-kit-export-rate-limit.ts`).
 */
import { z } from "zod";
import { GITHUB_API_VERSION, type AuthPayload, type CredentialCheckResult } from "@metis/shared";
import { createChildLogger } from "../../logger.js";
import { getVaultService } from "../../vault/vault-service.js";
import { assertBindingWriteWindowOpen } from "../../vault/binding-write-mark.js";
import { readBoundSecret } from "../../connectors/vault-resolver.js";
import { resolvePublishTarget } from "../../publishing/host-allowlist.js";
import { acquirePublishOctokit } from "../../publishing/octokit-factory.js";
import {
  analysedRepos,
  bindPublishCredential,
  checkCredential,
  refuseIfAnalysed,
  statusOf,
  upstreamsOfAnalysed,
} from "../../publishing/analysed-repo-guard.js";
import { PublishError, type PublishOctokitLike } from "../../publishing/types.js";
import { resolveFeatureBySlug } from "../features.js";
import { SpecKitArtifactError } from "../artifacts.js";
import {
  auditTasksExportRefused,
  clearStuckTaskExports,
  GITHUB_LABEL_MAX_LENGTH,
  markIssueNotCreated,
  resolveTasksExportRepo,
  runTasksToIssues,
  type ClearStuckExportResult,
  type IssueClient,
  type TasksToIssuesResult,
} from "./taskstoissues.js";

const log = createChildLogger("speckit-taskstoissues-github");

/** What the refusal message calls this feature. */
const WHAT = "Spec Kit issue exports";

export const SPECKIT_EXPORT_DEFAULT_MAX_ISSUES = 50;

/** Per-export cap on created issues, tunable via `SPECKIT_EXPORT_MAX_ISSUES`. */
export function maxIssuesPerExport(): number {
  const n = Number.parseInt(process.env.SPECKIT_EXPORT_MAX_ISSUES ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : SPECKIT_EXPORT_DEFAULT_MAX_ISSUES;
}

/** The request-body fields of `speckit.taskstoissues` beyond the runner's own. */
export const tasksExportBodySchema = z.object({
  secretRef: z.string().min(1).max(256).optional(),
  expectedPlan: z
    .object({
      tasksVersion: z.number().int().positive(),
      digest: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict()
    .optional(),
  /** #962 — "Clear stuck export": reconcile and clear abandoned task claims. */
  clearStuckClaims: z.literal(true).optional(),
});

export interface TasksExportInput {
  projectId: string;
  featureSlug: string;
  actorId: string;
  actorRole: AuthPayload["role"];
  force: boolean;
  parentEpicNumber?: number;
  /** A request-chosen `owner/repo`. Honoured on a dry run only. */
  repo?: { owner: string; name: string };
  secretRef?: string;
  expectedPlan?: { tasksVersion: number; digest: string };
}

export type TasksExportPreview = TasksToIssuesResult & {
  /** Whether the given vault reference binds to a secret; never the secret itself. */
  credentialCheck: CredentialCheckResult;
};

/**
 * Dry run: plan the export, refuse an analysed-repository target up front
 * (name equality — no network call), and say whether the credential binds.
 */
export async function previewTasksExport(input: TasksExportInput): Promise<TasksExportPreview> {
  const result = await runTasksToIssues({
    projectId: input.projectId,
    featureSlug: input.featureSlug,
    force: input.force,
    actorId: input.actorId,
    dryRun: true,
    publishAvailable: true,
    ...(input.repo ? { repo: input.repo } : {}),
    ...(input.parentEpicNumber !== undefined ? { parentEpicNumber: input.parentEpicNumber } : {}),
  });
  if (result.repo.owner && result.repo.name) {
    refuseIfAnalysed(
      (await analysedRepos(input.projectId)).names,
      [`${result.repo.owner}/${result.repo.name}`],
      WHAT,
    );
  }
  return { ...result, credentialCheck: await checkCredential(input.secretRef) };
}

/** Live run: every guard above, then the runner with a real client. */
export async function exportTasksToGitHub(input: TasksExportInput): Promise<TasksToIssuesResult> {
  const seen: { featureId: string | null } = { featureId: null };
  let target: { client: IssueClient; repo: { owner: string; name: string } };
  try {
    target = await openGuardedTarget(input, seen, { requirePlan: true });
  } catch (err) {
    auditRefused(input, seen.featureId, err);
    throw err;
  }
  // The runner audits its own refusals (the planning stage's included) and a
  // failure part-way through creating issues.
  return runTasksToIssues({
    projectId: input.projectId,
    featureSlug: input.featureSlug,
    force: input.force,
    actorId: input.actorId,
    repo: target.repo,
    client: target.client,
    dryRun: false,
    ...(input.expectedPlan ? { expectedPlan: input.expectedPlan } : {}),
    maxCreates: maxIssuesPerExport(),
    publishAvailable: true,
    ...(input.parentEpicNumber !== undefined ? { parentEpicNumber: input.parentEpicNumber } : {}),
  });
}

/**
 * #962 — "Clear stuck export": the live run's guards (configured target only,
 * never the analysed repository or its upstream, a vault-bound token), then
 * each abandoned claim reconciled against that target. Audited either way.
 */
export async function clearStuckTasksExport(
  input: TasksExportInput,
): Promise<ClearStuckExportResult> {
  const seen: { featureId: string | null } = { featureId: null };
  let target: { client: IssueClient; repo: { owner: string; name: string } };
  try {
    target = await openGuardedTarget(input, seen, { requirePlan: false });
  } catch (err) {
    auditRefused(input, seen.featureId, err, "clear");
    throw err;
  }
  return clearStuckTaskExports({
    projectId: input.projectId,
    featureSlug: input.featureSlug,
    repo: target.repo,
    client: target.client,
    actorId: input.actorId,
  });
}

/**
 * Every guard a write to GitHub passes, in order: no request-chosen target, a
 * vault secret, a dry run (a live export), the feature, the configured target
 * refused when analysed, the credential bound, and an analysed fork's upstream
 * refused — all before any write.
 */
async function openGuardedTarget(
  input: TasksExportInput,
  seen: { featureId: string | null },
  opts: { requirePlan: boolean },
): Promise<{ client: IssueClient; repo: { owner: string; name: string } }> {
  if (input.repo) {
    throw new SpecKitArtifactError(
      400,
      "SPECKIT_TARGET_OVERRIDE_REFUSED",
      "Publishing uses the project's configured issue target only; it cannot be redirected per request. Remove the repository from the request.",
    );
  }
  if (!input.secretRef) {
    throw new PublishError(
      400,
      "TOKEN_REQUIRED",
      "Publishing needs a GitHub token from the vault. Pick a vault secret, then run the dry run again.",
    );
  }
  if (opts.requirePlan && !input.expectedPlan) {
    throw new SpecKitArtifactError(
      409,
      "SPECKIT_DRY_RUN_REQUIRED",
      "Run the dry run first and review the issues it lists; publishing creates exactly those.",
    );
  }
  const feature = await resolveFeatureBySlug(input.projectId, input.featureSlug);
  if (!feature) {
    throw new SpecKitArtifactError(
      404,
      "SPECKIT_FEATURE_NOT_FOUND",
      `Feature not found: ${input.featureSlug}`,
    );
  }
  seen.featureId = feature.id;
  const resolved = await resolveTasksExportRepo(input.projectId);
  const analysed = await analysedRepos(input.projectId);
  refuseIfAnalysed(analysed.names, [`${resolved.owner}/${resolved.name}`], WHAT);
  // Validates owner/repo and pins the public API base URL — no caller input.
  const target = await resolvePublishTarget({
    owner: resolved.owner,
    repo: resolved.name,
    baseUrl: null,
  });
  const { secretId, until } = await bindPublishCredential({
    actorId: input.actorId,
    actorRole: input.actorRole,
    secretRef: input.secretRef,
    projectId: input.projectId,
    target: { type: "speckit_feature", id: feature.id },
  });
  assertBindingWriteWindowOpen(until); // #552 — before the token is sent anywhere
  const token = await readBoundSecret(secretId, getVaultService());
  const octokit = await acquirePublishOctokit({
    owner: target.owner,
    baseUrl: target.baseUrl,
    token,
    pinnedAddress: target.pinnedAddress,
    pinnedFamily: target.pinnedFamily,
  });
  // Before any write: an analysed fork's upstream is the analysed repository
  // by another name. Fails closed — a lookup that fails refuses the run.
  refuseIfAnalysed(
    await upstreamsOfAnalysed(octokit, analysed.github, (r, status, cause) =>
      githubFailure(
        `read the analysed repository ${r.owner}/${r.repo} to check its upstream`,
        status,
        cause,
        LOOKUP_HINT,
      ),
    ),
    [`${target.owner}/${target.repo}`],
    WHAT,
  );
  return {
    client: createGitHubIssueClient(octokit),
    repo: { owner: target.owner, name: target.repo },
  };
}

function auditRefused(
  input: TasksExportInput,
  featureId: string | null,
  err: unknown,
  operation: "export" | "clear" = "export",
): void {
  auditTasksExportRefused({
    actorId: input.actorId,
    projectId: input.projectId,
    featureSlug: input.featureSlug,
    featureId,
    err,
    operation,
  });
}
/**
 * The production {@link IssueClient}: REST calls on the given (already
 * target-pinned, token-bound) client. Failures become a fixed message naming
 * the step and HTTP status — never GitHub's text, which could quote request
 * material.
 */
export function createGitHubIssueClient(octokit: PublishOctokitLike): IssueClient {
  /** Issue number → REST database id, which the sub-issue API needs. */
  const restIds = new Map<number, number>();
  const repoPath = (owner: string, name: string) =>
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;

  async function restIdOf(owner: string, name: string, issue: number): Promise<number> {
    const cached = restIds.get(issue);
    if (cached !== undefined) return cached;
    let data: { id?: unknown };
    try {
      data =
        (
          await octokit.request<{ id?: unknown }>({
            method: "GET",
            url: `${repoPath(owner, name)}/issues/${issue}`,
          })
        ).data ?? {};
    } catch (err) {
      throw githubFailure(`read issue #${issue}`, statusOf(err), err);
    }
    if (typeof data.id !== "number") throw githubFailure(`read issue #${issue}`, 0);
    restIds.set(issue, data.id);
    return data.id;
  }

  /**
   * #962 — the token's own login, read once per client (one client per run).
   * Reconciliation adopts only issues this user filed; a token whose user
   * cannot be read refuses the reconcile rather than search everyone's issues.
   */
  let login: Promise<string> | null = null;
  function tokenLogin(step: string): Promise<string> {
    const pending = (login ??= (async () => {
      let data: { login?: unknown };
      try {
        data =
          (await octokit.request<{ login?: unknown }>({ method: "GET", url: "/user" })).data ?? {};
      } catch (err) {
        throw githubFailure(step, statusOf(err), err, RECONCILE_HINT);
      }
      if (typeof data.login !== "string" || data.login.length === 0) {
        throw githubFailure(step, 0, undefined, RECONCILE_HINT);
      }
      return data.login;
    })());
    // A failed lookup is not cached: the next reconcile asks again.
    pending.catch(() => {
      if (login === pending) login = null;
    });
    return pending;
  }

  return {
    async create(owner, name, req) {
      let data: { id?: unknown; number?: unknown; html_url?: unknown };
      try {
        data =
          (
            await octokit.request<typeof data>({
              method: "POST",
              url: `${repoPath(owner, name)}/issues`,
              data: { title: req.title, body: req.body, labels: req.labels },
            })
          ).data ?? {};
      } catch (err) {
        const status = statusOf(err);
        const invalid = status === 422 ? invalidFieldsOf(err) : null;
        const failure = invalid
          ? githubFailure(
              `create an issue: it rejected ${invalid.join(", ")}`,
              status,
              err,
              invalidHint(invalid),
            )
          : githubFailure("create an issue", status, err);
        // #962 — a 4xx is GitHub refusing: nothing was created, so the claim
        // may go. A network error or a 5xx is ambiguous and keeps it.
        throw status >= 400 && status < 500 ? markIssueNotCreated(failure) : failure;
      }
      // A 2xx without an issue in it is ambiguous too: the issue may exist.
      if (typeof data.number !== "number" || typeof data.html_url !== "string") {
        throw githubFailure("create an issue", 0);
      }
      if (typeof data.id === "number") restIds.set(data.number, data.id);
      return { number: data.number, url: data.html_url };
    },
    async findTaskIssue(owner, name, query) {
      // The list API, not search: search is eventually consistent and can miss
      // an issue created seconds ago. Oldest first, so a task with duplicates
      // from before #962 adopts the first one filed.
      const since = new Date(query.since.getTime() - RECONCILE_SKEW_MS).toISOString();
      const prefix = `[${query.taskId}] `;
      const source = `Source: specs/${query.featureSlug}/tasks.md#${query.taskId}`;
      const step = `look for the issue an earlier export of ${query.taskId} may have created`;
      const me = await tokenLogin(step);
      for (let page = 1; page <= RECONCILE_MAX_PAGES; page++) {
        let data: unknown;
        try {
          data = (
            await octokit.request<unknown>({
              method: "GET",
              url:
                `${repoPath(owner, name)}/issues?state=all&sort=created&direction=asc` +
                `&creator=${encodeURIComponent(me)}&since=${encodeURIComponent(since)}&per_page=${RECONCILE_PAGE_SIZE}&page=${page}`,
            })
          ).data;
        } catch (err) {
          throw githubFailure(step, statusOf(err), err, RECONCILE_HINT);
        }
        if (!Array.isArray(data)) throw githubFailure(step, 0, undefined, RECONCILE_HINT);
        for (const raw of data as Array<Record<string, unknown> | null>) {
          if (!raw || raw.pull_request) continue;
          const { number, html_url: url, title, body, id, user } = raw;
          if (typeof number !== "number" || typeof url !== "string") continue;
          // Not the filter alone: an issue someone else filed is never adopted.
          const author = (user as { login?: unknown } | null | undefined)?.login;
          if (typeof author !== "string" || author.toLowerCase() !== me.toLowerCase()) continue;
          if (typeof title !== "string" || !title.startsWith(prefix)) continue;
          // The title alone could be another feature's task of the same id.
          if (typeof body !== "string" || !body.split(/\r?\n/).some((l) => l.trim() === source)) {
            continue;
          }
          if (typeof id === "number") restIds.set(number, id);
          return { number, url };
        }
        if (data.length < RECONCILE_PAGE_SIZE) return null;
      }
      // Too many issues to be sure: refuse rather than risk a duplicate.
      throw githubFailure(step, 0, undefined, RECONCILE_HINT);
    },
    async addSubIssue(owner, name, parent, child) {
      const childId = await restIdOf(owner, name, child);
      try {
        await octokit.request({
          method: "POST",
          url: `${repoPath(owner, name)}/issues/${parent}/sub_issues`,
          headers: { "X-GitHub-Api-Version": GITHUB_API_VERSION },
          data: { sub_issue_id: childId },
        });
      } catch (err) {
        throw githubFailure(`link issue #${child} under #${parent}`, statusOf(err), err);
      }
    },
  };
}

/** #962 — reconciliation looks this far before the first claim, for clock skew. */
const RECONCILE_SKEW_MS = 10 * 60_000;
const RECONCILE_PAGE_SIZE = 100;
const RECONCILE_MAX_PAGES = 10;
const RECONCILE_HINT =
  "No issue was created: METIS could not check whether an earlier export already filed it. " +
  "Retry in a few minutes.";
const WRITE_HINT = "Check that the vault secret can create issues in the publish target.";
const LOOKUP_HINT =
  "No issues were created: METIS could not confirm the publish target is not the upstream " +
  "of that analysed repository. Use a vault secret that can read it, retry if GitHub was " +
  "rate-limiting, or change the project's publish target.";

/** A GitHub enum word (`Label`, `name`, `invalid`): nothing of the request's content. */
const GITHUB_WORD_RE = /^[A-Za-z_]{1,40}$/;

/**
 * #988 — a 422 `Validation Failed` names what GitHub refused in
 * `errors[].{resource, field, code}`, e.g. `invalid Label name`. Only those
 * enum words are read — never `message` or `value`, which can quote the
 * request. Null when the response carries none.
 */
export function invalidFieldsOf(err: unknown): string[] | null {
  const data = (err as { response?: { data?: unknown } } | null)?.response?.data;
  const errors = (data as { errors?: unknown } | null | undefined)?.errors;
  if (!Array.isArray(errors)) return null;
  const word = (v: unknown) => (typeof v === "string" && GITHUB_WORD_RE.test(v) ? v : null);
  const out = new Set<string>();
  for (const e of errors as Array<Record<string, unknown> | null>) {
    const resource = word(e?.resource);
    const field = word(e?.field);
    if (!resource && !field) continue;
    out.add([word(e?.code), resource, field].filter(Boolean).join(" "));
  }
  return out.size > 0 ? [...out] : null;
}

function invalidHint(invalid: string[]): string {
  const label = invalid.some((f) => /\bLabel\b/.test(f))
    ? ` GitHub caps a label name at ${GITHUB_LABEL_MAX_LENGTH} characters.`
    : "";
  return `No issue was created: the issue's content failed GitHub's validation, not the vault secret.${label}`;
}

function githubFailure(
  step: string,
  status: number,
  cause?: unknown,
  hint: string = WRITE_HINT,
): PublishError {
  // The upstream message is deliberately not logged or forwarded.
  log.warn("speckit_export.github_failed", {
    step,
    status,
    kind: (cause as Error | undefined)?.name,
  });
  return new PublishError(
    502,
    "GITHUB_REQUEST_FAILED",
    `GitHub refused the request to ${step} (HTTP ${status || "error"}). ${hint}`,
  );
}
