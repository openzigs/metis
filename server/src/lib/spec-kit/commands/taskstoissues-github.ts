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
 *    created) and a refused one each write an audit entry; the credential
 *    binding is audited by the vault layer.
 * Rate limiting is applied at the route (`spec-kit-export-rate-limit.ts`).
 */
import { z } from "zod";
import { GITHUB_API_VERSION, type AuthPayload, type CredentialCheckResult } from "@metis/shared";
import { audit } from "../../audit/audit-service.js";
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
  resolveTasksExportRepo,
  runTasksToIssues,
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
  let client: IssueClient;
  let repo: { owner: string; name: string };
  let featureId: string | null = null;
  try {
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
    if (!input.expectedPlan) {
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
    featureId = feature.id;
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
    repo = { owner: target.owner, name: target.repo };
    client = createGitHubIssueClient(octokit);
  } catch (err) {
    auditRefused(input, featureId, err);
    throw err;
  }

  try {
    return await runTasksToIssues({
      projectId: input.projectId,
      featureSlug: input.featureSlug,
      force: input.force,
      actorId: input.actorId,
      repo,
      client,
      dryRun: false,
      expectedPlan: input.expectedPlan,
      maxCreates: maxIssuesPerExport(),
      publishAvailable: true,
      ...(input.parentEpicNumber !== undefined ? { parentEpicNumber: input.parentEpicNumber } : {}),
    });
  } catch (err) {
    // The runner audits a failure part-way through creating issues; a plan it
    // refused before creating any is audited here, as every other refusal.
    if (err instanceof SpecKitArtifactError && PLAN_REFUSALS.has(err.code)) {
      auditRefused(input, featureId, err);
    }
    throw err;
  }
}

const PLAN_REFUSALS = new Set(["SPECKIT_EXPORT_PLAN_CHANGED", "SPECKIT_EXPORT_TOO_LARGE"]);

function auditRefused(input: TasksExportInput, featureId: string | null, err: unknown): void {
  const code = (err as { code?: unknown } | null)?.code;
  audit({
    actor: { id: input.actorId },
    action: "speckit.tasks_export_refused",
    target: { type: "speckit_feature", id: featureId ?? input.featureSlug },
    metadata: {
      projectId: input.projectId,
      featureSlug: input.featureSlug,
      code: typeof code === "string" ? code : "UNEXPECTED",
    },
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
        throw githubFailure("create an issue", statusOf(err), err);
      }
      if (typeof data.number !== "number" || typeof data.html_url !== "string") {
        throw githubFailure("create an issue", 0);
      }
      if (typeof data.id === "number") restIds.set(data.number, data.id);
      return { number: data.number, url: data.html_url };
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

const WRITE_HINT = "Check that the vault secret can create issues in the publish target.";
const LOOKUP_HINT =
  "No issues were created: METIS could not confirm the publish target is not the upstream " +
  "of that analysed repository. Use a vault secret that can read it, retry if GitHub was " +
  "rate-limiting, or change the project's publish target.";

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
