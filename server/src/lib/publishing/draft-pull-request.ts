/**
 * #776 — turn one issue draft into a DRAFT pull request.
 *
 * Nothing in METIS could open a pull request: the only repo write besides
 * issues committed `.copilot-workspace.md` straight to the default branch.
 * This is the minimal, safe path: one draft becomes a spec file on its own
 * branch, opened as a GitHub *draft* PR for a human to review.
 *
 * Safety rules, each one a past incident:
 *  - The target is ONLY the project's saved publish target (#733/#784). The
 *    request carries no owner, repo or base URL, so nothing can redirect it,
 *    and with no saved target the request is refused rather than defaulting.
 *  - A saved target that equals one of the project's repo connections — the
 *    analysed (often upstream) repository — is refused outright, including a
 *    soft-deleted connection (the project still holds its analysis).
 *  - On a live run, the UPSTREAM of each analysed public-GitHub repository
 *    (its fork `parent` and `source`) is refused the same way: a project that
 *    analyses the fork `me/v2` must not open a PR on `miniflux/v2`. A target
 *    that is itself a fork of an analysed repo is ALLOWED — that is the
 *    intended sandbox (the PR's head and base are both in the target, so it
 *    never writes to the parent). An analysed repo whose lookup fails is
 *    refused (502 naming the step), never assumed to have no upstream.
 *  - Dry run is the default (the schema defaults `dryRun` to true) and makes
 *    no network call; it only reports whether the credential reference binds,
 *    and says in `upstreamCheck` that the analysed repos' upstreams were not
 *    checked.
 *  - The credential is a `${vault:label}` reference bound to a secret id
 *    (#480) and read by id at use; the token is never returned, logged or put
 *    in an error. GitHub failures surface as a fixed message with the status.
 *  - A live run writes a branch, a file and a PR — repository writes, not just
 *    issues — so the caller must own the secret (or hold `vault.reveal`): the
 *    #344 rule judged as a new destination, as an import source does (#763).
 *  - A live run passes the same approval and promotion gates as a batch.
 *  - Only the public GitHub API is used (no caller-chosen host), so the token
 *    goes only to the service that issued it — the batch-publish rule (#358).
 */
import type { AuthPayload, DraftPullRequestResult } from "@metis/shared";
import { prisma } from "../prisma.js";
import { audit } from "../audit/audit-service.js";
import { createChildLogger } from "../logger.js";
import { getVaultService } from "../vault/vault-service.js";
import { assertBindingWriteWindowOpen } from "../vault/binding-write-mark.js";
import { readBoundSecret } from "../connectors/vault-resolver.js";
import { assertDraftsPublishable } from "../reviews/approval-gate.js";
import { findSavedGitHubTarget } from "./saved-target.js";
import { resolvePublishTarget } from "./host-allowlist.js";
import { acquirePublishOctokit } from "./octokit-factory.js";
import { assertPromotionAllowed } from "./publishing-service.js";
import {
  analysedRepos,
  bindPublishCredential,
  checkCredential,
  refuseIfAnalysed as refuseIfAnalysedTarget,
  statusOf,
  upstreamsOfAnalysed,
} from "./analysed-repo-guard.js";
import { PublishError, type PublishOctokitLike } from "./types.js";

const log = createChildLogger("draft-pull-request");

/** Head branch for a draft's PR. Draft ids are cuids, so this is ref-safe. */
export function draftPullRequestBranch(draftId: string): string {
  return `metis/draft-${draftId}`;
}

/** Repository path of the spec file the PR adds. */
export function draftPullRequestPath(draftId: string): string {
  return `.metis/drafts/${draftId}.md`;
}

export interface OpenDraftPullRequestInput {
  projectId: string;
  draftId: string;
  actorId: string;
  /** The caller's role: decides whether they may use a secret they did not create. */
  actorRole: AuthPayload["role"];
  dryRun: boolean;
  secretRef?: string;
}

export async function openDraftPullRequest(
  input: OpenDraftPullRequestInput,
): Promise<DraftPullRequestResult> {
  const draft = await prisma.issueDraft.findFirst({
    where: { id: input.draftId, projectId: input.projectId, deletedAt: null },
    include: { requirement: { select: { analysisId: true } } },
  });
  if (!draft) throw new PublishError(404, "DRAFT_NOT_FOUND", "draft not found");
  if (draft.status === "publishing") {
    throw new PublishError(409, "DRAFT_NOT_EDITABLE", "this draft is being published; retry later");
  }

  const saved = await findSavedGitHubTarget(input.projectId);
  if (!saved) {
    throw new PublishError(
      409,
      "PUBLISH_TARGET_NOT_CONFIGURED",
      "save a GitHub publish target for this project first; a draft pull request is only ever opened there",
    );
  }
  const analysed = await analysedRepos(input.projectId);
  refuseIfAnalysed(analysed.names, [`${saved.owner}/${saved.repo}`]);
  // Validates owner/repo and pins the public API base URL — no caller input.
  const target = await resolvePublishTarget({
    owner: saved.owner,
    repo: saved.repo,
    baseUrl: null,
  });

  const branch = draftPullRequestBranch(draft.id);
  const path = draftPullRequestPath(draft.id);
  const plan: DraftPullRequestResult = {
    dryRun: input.dryRun,
    target: { owner: target.owner, repo: target.repo },
    branch,
    path,
    title: draft.title,
    actions: [
      { kind: "branch.create", summary: `create ${branch} from the default branch` },
      { kind: "file.commit", summary: `commit ${path} on ${branch}` },
      {
        kind: "pullRequest.createDraft",
        summary: `open a draft pull request into ${target.owner}/${target.repo}`,
      },
    ],
    credentialCheck: "missing",
    pullRequest: null,
    upstreamCheck: input.dryRun
      ? {
          forkNetworkChecked: false,
          note:
            "Checked against this project's repository connections only. A dry run makes no " +
            "network call, so whether the target is the upstream (fork parent or source) of " +
            "an analysed repository is checked when the pull request is opened.",
        }
      : {
          forkNetworkChecked: true,
          note: "Checked against this project's repository connections and the fork parent and source of each analysed GitHub repository.",
        },
  };

  if (input.dryRun) {
    plan.credentialCheck = await checkCredential(input.secretRef);
    return plan;
  }

  if (!input.secretRef) {
    throw new PublishError(
      400,
      "TOKEN_REQUIRED",
      "a live draft pull request needs a vault secret ref",
    );
  }
  const { secretId, until } = await bindPublishCredential({
    actorId: input.actorId,
    actorRole: input.actorRole,
    secretRef: input.secretRef,
    projectId: input.projectId,
    target: { type: "issue_draft", id: draft.id },
  });
  await assertPromotionAllowed(draft.requirement?.analysisId ? [draft.requirement.analysisId] : []);
  await assertDraftsPublishable({
    projectId: input.projectId,
    drafts: [draft],
    context: "publish.draft_pr.create",
    actorId: input.actorId,
  });

  assertBindingWriteWindowOpen(until); // #552 — before the token is sent anywhere
  const token = await readBoundSecret(secretId, getVaultService());
  const client = await acquirePublishOctokit({
    owner: target.owner,
    baseUrl: target.baseUrl,
    token,
    pinnedAddress: target.pinnedAddress,
    pinnedFamily: target.pinnedFamily,
  });
  const gh = new GitHubSteps(client, target);
  // Before any write: an analysed fork's upstream is the analysed repository
  // by another name. Fails closed — a lookup that fails refuses the run.
  refuseIfAnalysed(await upstreamsOfAnalysed(client, analysed.github, upstreamLookupFailure), [
    `${target.owner}/${target.repo}`,
  ]);
  const base = await gh.defaultBranch();
  const baseSha = await gh.headSha(base);
  await gh.createBranch(branch, baseSha);
  await gh.putFile(path, branch, specFile(draft.title, draft.body), draft.id);
  const pr = await gh.openDraftPr({
    title: draft.title,
    head: branch,
    base,
    body: prBody(draft.body, draft.id),
  });

  await prisma.issueDraft.update({
    where: { id: draft.id },
    data: {
      metadata: JSON.stringify({
        ...parseMetadata(draft.metadata),
        pullRequest: {
          number: pr.number,
          htmlUrl: pr.htmlUrl,
          owner: target.owner,
          repo: target.repo,
          branch,
        },
      }),
    },
  });
  audit({
    actor: { id: input.actorId },
    action: "publish.draft_pr.opened",
    target: { type: "issue_draft", id: draft.id },
    metadata: {
      projectId: input.projectId,
      repo: `${target.owner}/${target.repo}`,
      pullRequest: pr.number,
      reused: pr.reused,
    },
  });
  plan.credentialCheck = "resolved";
  plan.pullRequest = pr;
  return plan;
}

/** The draft-PR wording of the shared analysed-repository refusal. */
function refuseIfAnalysed(refused: Set<string>, candidates: string[]): void {
  refuseIfAnalysedTarget(refused, candidates, "draft pull requests");
}

/** An analysed repository's fork network could not be read: refuse, naming it. */
function upstreamLookupFailure(
  repo: { owner: string; repo: string },
  status: number,
  cause: unknown,
): PublishError {
  return githubFailure(
    `read the analysed repository ${repo.owner}/${repo.repo} to check its upstream`,
    status,
    cause,
    LOOKUP_HINT,
  );
}

function specFile(title: string, body: string): string {
  return `# ${title}\n\n${body.trim()}\n`;
}

function prBody(body: string, draftId: string): string {
  return (
    `${body.trim()}\n\n---\n` +
    `Opened as a **draft** by METIS from issue draft \`${draftId}\`. ` +
    "Review the spec before marking this pull request ready."
  );
}

function parseMetadata(raw: string | null): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw ?? "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * The GitHub REST calls, each wrapped so a failure becomes a fixed message
 * naming the step and HTTP status — never the upstream text, which could
 * quote request material.
 */
class GitHubSteps {
  private readonly repoPath: string;

  constructor(
    private readonly client: PublishOctokitLike,
    target: { owner: string; repo: string },
  ) {
    this.repoPath = `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
  }

  async defaultBranch(): Promise<string> {
    const res = await this.call<{ default_branch?: string }>("read the repository", {
      method: "GET",
      url: this.repoPath,
    });
    return res.default_branch ?? "main";
  }

  async headSha(branch: string): Promise<string> {
    const res = await this.call<{ object?: { sha?: string } }>("read the default branch", {
      method: "GET",
      url: `${this.repoPath}/git/ref/heads/${encodeURIComponent(branch)}`,
    });
    const sha = res.object?.sha;
    if (!sha) throw githubFailure("read the default branch", 0);
    return sha;
  }

  /** Create the head branch; an existing one (422) is reused on a re-run. */
  async createBranch(branch: string, sha: string): Promise<void> {
    try {
      await this.client.request({
        method: "POST",
        url: `${this.repoPath}/git/refs`,
        data: { ref: `refs/heads/${branch}`, sha },
      });
    } catch (err) {
      if (statusOf(err) === 422) return;
      throw githubFailure("create the branch", statusOf(err), err);
    }
  }

  async putFile(path: string, branch: string, content: string, draftId: string): Promise<void> {
    const url = `${this.repoPath}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
    let sha: string | undefined;
    try {
      const probe = await this.client.request<{ sha?: string }>({
        method: "GET",
        url: `${url}?ref=${encodeURIComponent(branch)}`,
      });
      sha = probe.data?.sha;
    } catch (err) {
      if (statusOf(err) !== 404) throw githubFailure("read the spec file", statusOf(err), err);
    }
    await this.call("commit the spec file", {
      method: "PUT",
      url,
      data: {
        message: `docs(metis): spec for issue draft ${draftId}`,
        content: Buffer.from(content, "utf-8").toString("base64"),
        branch,
        ...(sha ? { sha } : {}),
      },
    });
  }

  /** Open the draft PR; if one is already open for this branch (422), return it. */
  async openDraftPr(args: {
    title: string;
    head: string;
    base: string;
    body: string;
  }): Promise<{ number: number; htmlUrl: string; reused: boolean }> {
    try {
      const res = await this.client.request<{ number: number; html_url: string }>({
        method: "POST",
        url: `${this.repoPath}/pulls`,
        data: { ...args, draft: true },
      });
      return { number: res.data.number, htmlUrl: res.data.html_url, reused: false };
    } catch (err) {
      if (statusOf(err) !== 422)
        throw githubFailure("open the draft pull request", statusOf(err), err);
    }
    const owner = this.repoPath.split("/")[2];
    const open = await this.call<Array<{ number: number; html_url: string }>>(
      "find the open pull request",
      {
        method: "GET",
        url: `${this.repoPath}/pulls?state=open&head=${owner}:${encodeURIComponent(args.head)}`,
      },
    );
    const existing = Array.isArray(open) ? open[0] : undefined;
    if (!existing) throw githubFailure("open the draft pull request", 422);
    return { number: existing.number, htmlUrl: existing.html_url, reused: true };
  }

  private async call<T>(
    step: string,
    args: { method: "GET" | "POST" | "PUT"; url: string; data?: unknown },
  ): Promise<T> {
    try {
      const res = await this.client.request<T>(args);
      return res.data;
    } catch (err) {
      throw githubFailure(step, statusOf(err), err);
    }
  }
}

const WRITE_HINT = "Check that the vault secret can write to the publish target.";
const LOOKUP_HINT =
  "The draft pull request was not opened: METIS could not confirm the publish target is not " +
  "the upstream of that analysed repository. Use a vault secret that can read it, retry if " +
  "GitHub was rate-limiting, or change the project's publish target.";

function githubFailure(
  step: string,
  status: number,
  cause?: unknown,
  hint: string = WRITE_HINT,
): PublishError {
  // The upstream message is deliberately not logged or forwarded.
  log.warn("draft_pr.github_failed", { step, status, kind: (cause as Error | undefined)?.name });
  return new PublishError(
    502,
    "GITHUB_REQUEST_FAILED",
    `GitHub refused the request to ${step} (HTTP ${status || "error"}). ${hint}`,
  );
}
