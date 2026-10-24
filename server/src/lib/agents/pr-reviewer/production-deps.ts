/**
 * #1471 — the production PR-review worker's per-job judge and GitHub client.
 *
 * `server.ts` used to wire `resolveJudge` / `resolveOctokit` to
 * `async () => null`, so every queued review stopped at
 * `review_not_configured` on a real deployment. These resolvers build both
 * from the project's own configuration, per job:
 *
 *   - **Judge** — the project's model provider through METIS's own provider
 *     layer (`resolveProjectProvider`: the project's `aiProviderId` / `aiModel`
 *     override, else the deployment's provider). Each call reports its tokens
 *     and its cost (`estimateUsageCostUsd`, the rate table every ledger reader
 *     uses) in the `JudgeEnvelope`, so `runPrReview` records the spend through
 *     `defaultBudgetDeps()` and the #1169 monthly limit counts it. An unpriced
 *     model reports a non-finite cost, which `recordPrReviewSpend` stores as
 *     unpriced rather than as a known $0.
 *   - **GitHub client** — the project's GitHub repository connector for the
 *     job's repo: its bound vault secret (`readBoundSecret`, by id), its API
 *     base URL (GitHub Enterprise), validated and DNS-pinned by
 *     `resolvePublishTarget`, and the shared throttled/retried client from
 *     `acquirePublishOctokit`.
 *
 * Anything unresolvable — no provider configured, the offline stub, no
 * connector, no secret, a deleted secret, a host off the allow-list — answers
 * `null`, and the worker records `review_not_configured` without a model call.
 *
 * OWASP: the token is read into a local and handed only to the Octokit
 * factory. It is never logged, returned or put in an error message; log lines
 * name the project, repo and an error *class*, never a message that could
 * carry a URL or credential.
 */
import { resolveProjectProvider } from "../../ai/project-provider.js";
import { estimateUsageCostUsd } from "../../ai/token-tracker.js";
import type { AIProvider } from "../../ai/types.js";
import { readBoundSecret } from "../../connectors/vault-resolver.js";
import { createChildLogger } from "../../logger.js";
import { prisma } from "../../prisma.js";
import { acquirePublishOctokit } from "../../publishing/octokit-factory.js";
import { resolvePublishTarget } from "../../publishing/host-allowlist.js";
import type { PublishOctokitLike } from "../../publishing/types.js";
import { getVaultService } from "../../vault/vault-service.js";
import type { JudgeEnvelope, JudgeLike } from "./agent.js";
import type { DiffFetchOctokit } from "./diff-fetcher.js";
import type { OctokitLike } from "./github-review-poster.js";
import type { PrReviewJob } from "./queue.js";

const log = createChildLogger("pr-review-production-deps");

/** The GitHub client shape the PR-review job uses. */
export type PrReviewOctokit = OctokitLike & DiffFetchOctokit;

/** Connector providers whose credential can review a GitHub pull request. */
const GITHUB_CONNECTOR_PROVIDERS = new Set(["github", "github_enterprise"]);

function errorClass(err: unknown): string {
  if (err && typeof err === "object") {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
    return (err as { name?: string }).name ?? "Error";
  }
  return "Error";
}

/** Wrap a provider as the review judge: one non-streaming call, metered. */
export function judgeFromProvider(provider: AIProvider): JudgeLike {
  return {
    async evaluate({ system, user }): Promise<JudgeEnvelope> {
      const res = await provider.chat(
        [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        { disableTools: true },
      );
      const cost = estimateUsageCostUsd(res.model, res.usage, res.provider);
      return {
        raw: res.content,
        model: res.model,
        provider: res.provider,
        inputTokens: res.usage.promptTokens,
        outputTokens: res.usage.completionTokens,
        // `null` = no published rate: recorded as unpriced, never as $0.
        costUsd: cost ?? Number.NaN,
      };
    },
  };
}

/**
 * The judge for `job`'s project, or `null` when the project has no usable
 * model provider on this server (including the deterministic offline stub,
 * which would "review" with canned text).
 */
export async function resolvePrReviewJudge(job: PrReviewJob): Promise<JudgeLike | null> {
  let provider: AIProvider;
  try {
    provider = await resolveProjectProvider(job.projectId);
  } catch (err) {
    log.warn("pr_review.judge_unresolved", {
      projectId: job.projectId,
      repo: `${job.owner}/${job.repo}`,
      prNumber: job.prNumber,
      reason: errorClass(err),
    });
    return null;
  }
  if (provider.offline) {
    log.warn("pr_review.judge_unresolved", {
      projectId: job.projectId,
      repo: `${job.owner}/${job.repo}`,
      prNumber: job.prNumber,
      reason: "offline_provider",
    });
    return null;
  }
  return judgeFromProvider(provider);
}

/**
 * The REST API base for a connector's stored `apiBaseUrl`. The connector form
 * stores what was typed — often the Enterprise host (`https://git.example.com`)
 * or a browse URL — and the repo connector's own client rewrites that to
 * `{origin}/api/v3` (`repo-service.ts` `acquireOctokit`); the review client
 * must call the same API. A github.com browse URL means the public API.
 * Unparseable input is passed through for `resolvePublishTarget` to refuse.
 */
export function githubApiBaseUrl(stored: string | null): string | null {
  if (!stored) return null;
  let url: URL;
  try {
    url = new URL(stored.trim());
  } catch {
    return stored;
  }
  const host = url.hostname.toLowerCase();
  if (host === "api.github.com") return url.origin;
  if (host === "github.com" || host === "www.github.com") return null;
  const path = url.pathname.replace(/\/+$/, "");
  return path.endsWith("/api/v3") ? url.origin + path : url.origin + "/api/v3";
}

function repoPath(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

/** Adapt the publisher's `request`-only client to the PR-review job's shape. */
export function prReviewOctokitFrom(client: PublishOctokitLike): PrReviewOctokit {
  return {
    pulls: {
      async get({ owner, repo, pull_number, mediaType }) {
        const format = mediaType?.format;
        const res = await client.request({
          method: "GET",
          url: `${repoPath(owner, repo)}/pulls/${Math.floor(pull_number)}`,
          ...(format === "diff" ? { headers: { accept: "application/vnd.github.diff" } } : {}),
        });
        return { data: res.data };
      },
      async createReview({ owner, repo, pull_number, event, body, comments }) {
        const res = await client.request<{ id: number; html_url: string }>({
          method: "POST",
          url: `${repoPath(owner, repo)}/pulls/${Math.floor(pull_number)}/reviews`,
          data: { event, body, ...(comments ? { comments } : {}) },
        });
        return { data: { id: res.data.id, html_url: res.data.html_url } };
      },
    },
  };
}

/**
 * The GitHub client for `job`'s repo, authenticated with the project's
 * repository connector credential — or `null` when there is no such
 * connector, it has no secret, or its secret or host cannot be used.
 */
export async function resolvePrReviewOctokit(job: PrReviewJob): Promise<PrReviewOctokit | null> {
  const where = {
    projectId: job.projectId,
    repo: `${job.owner}/${job.repo}`,
    prNumber: job.prNumber,
  };
  const conn = await prisma.repoConnection.findFirst({
    where: {
      projectId: job.projectId,
      ownerOrOrg: job.owner,
      repoName: job.repo,
      deletedAt: null,
      secretId: { not: null },
    },
    orderBy: { isPrimary: "desc" },
    select: { provider: true, apiBaseUrl: true, secretId: true },
  });
  if (!conn?.secretId) {
    log.warn("pr_review.octokit_unresolved", { ...where, reason: "no_connector_credential" });
    return null;
  }
  if (!GITHUB_CONNECTOR_PROVIDERS.has(conn.provider)) {
    log.warn("pr_review.octokit_unresolved", { ...where, reason: "not_a_github_connector" });
    return null;
  }
  try {
    const target = await resolvePublishTarget({
      owner: job.owner,
      repo: job.repo,
      baseUrl: githubApiBaseUrl(conn.apiBaseUrl),
    });
    const token = await readBoundSecret(conn.secretId, getVaultService());
    if (!token) {
      log.warn("pr_review.octokit_unresolved", { ...where, reason: "empty_secret" });
      return null;
    }
    const client = await acquirePublishOctokit({
      owner: target.owner,
      baseUrl: target.baseUrl,
      token,
      ...(target.pinnedAddress ? { pinnedAddress: target.pinnedAddress } : {}),
      ...(target.pinnedFamily ? { pinnedFamily: target.pinnedFamily } : {}),
    });
    return prReviewOctokitFrom(client);
  } catch (err) {
    log.warn("pr_review.octokit_unresolved", { ...where, reason: errorClass(err) });
    return null;
  }
}
