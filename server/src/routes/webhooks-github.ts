/**
 * Epic #192 (A.3) + Epic #394 — GitHub PR webhook receiver.
 *
 * Mounted under `/api/webhooks/github/pr`. Verifies the
 * `X-Hub-Signature-256` HMAC against `GITHUB_WEBHOOK_SECRET`, then dispatches
 * to the living-spec sync (#192/A.5) on `pull_request.closed+merged` and
 * the PR-reviewer agent (#192/A.4 → #394 MVP) on `pull_request.opened|synchronize`.
 *
 * Always responds 2xx (even on "no-op" actions) so GitHub does not retry —
 * non-handling reasons are surfaced in the response body for observability.
 */
import { Router, type Request, type Response } from "express";
import { prisma } from "../lib/prisma.js";
import { dispatchGithubPrEvent, verifyGithubPrSignature } from "../lib/living-spec/webhook.js";
import { syncMergedPR } from "../lib/living-spec/requirement-sync.js";
import { defaultBudgetDeps, type JudgeLike } from "../lib/agents/pr-reviewer/agent.js";
import { type DiffFetchOctokit } from "../lib/agents/pr-reviewer/diff-fetcher.js";
import type { OctokitLike } from "../lib/agents/pr-reviewer/github-review-poster.js";
import { syncIssueEvent, type IssuesEventAction } from "../lib/spec-kit/issue-sync.js";
import { recordDelivery } from "../lib/agents/pr-reviewer/webhook-dedup.js";
import { githubIssuesWebhookRateLimiter } from "../middleware/github-issues-webhook-rate-limit.js";
import type { PrReviewQueue } from "../lib/agents/pr-reviewer/queue.js";
import { getPrReviewWorker } from "../lib/agents/pr-reviewer/worker-singleton.js";
import { executePrReviewJob } from "../lib/agents/pr-reviewer/pr-review-job.js";
import { createChildLogger } from "../lib/logger.js";

const log = createChildLogger("webhooks-github");

function rawBody(req: Request): string {
  const raw = (req as unknown as { rawBody?: string | Buffer }).rawBody;
  if (typeof raw === "string") return raw;
  if (raw instanceof Buffer) return raw.toString("utf8");
  return JSON.stringify(req.body ?? {});
}

export interface GithubPrRouterDeps {
  /** Optional override of the judge LLM — when omitted, autoReview triggers a no-op stub. */
  judge?: JudgeLike;
  /** Optional Octokit factory (must support both review-post and diff-fetch surfaces). */
  octokit?: OctokitLike & DiffFetchOctokit;
  /** Override the secret resolver (test seam). */
  resolveSecret?: () => string;
  /** Override the budget guard (test seam). */
  budget?: ReturnType<typeof defaultBudgetDeps>;
  /**
   * Epic #394 P2 (#403) — optional async queue. When provided, the
   * webhook handler enqueues the review payload + ACKs in <100ms instead
   * of running the LLM inline. When omitted, the legacy inline path
   * preserves existing behaviour for tests + manual integrations.
   */
  queue?: PrReviewQueue;
  /** Test seam — bypass the dedup table on payloads without delivery headers. */
  skipDedup?: boolean;
}

export function githubPrWebhookRouter(deps: GithubPrRouterDeps = {}): Router {
  const r = Router();

  r.post("/github/pr", async (req: Request, res: Response) => {
    const secret = deps.resolveSecret?.() ?? process.env.GITHUB_WEBHOOK_SECRET ?? "";
    const sig = req.header("x-hub-signature-256") ?? undefined;
    const ts = req.header("x-webhook-timestamp") ?? undefined;
    const verdict = verifyGithubPrSignature(rawBody(req), secret, {
      signature: sig,
      timestamp: ts,
    });
    if (!verdict.ok) {
      res.status(401).json({ ok: false, reason: verdict.reason ?? "BAD_SIGNATURE" });
      return;
    }

    // Epic #394 P2 (#403) — webhook delivery dedup. We short-circuit
    // duplicate `X-GitHub-Delivery` UUIDs so re-deliveries (GitHub
    // retries on transient receiver errors) don't double-post a review.
    // Skipped when the header is absent (e.g. legacy unit tests) so the
    // contract stays backwards compatible.
    const deliveryId = (req.header("x-github-delivery") ?? "").trim();
    const eventType = (req.header("x-github-event") ?? "").trim();
    if (deliveryId && !deps.skipDedup) {
      try {
        const dedup = await recordDelivery({ deliveryId, eventType: eventType || "unknown" });
        if (dedup.duplicate) {
          res.status(200).json({ ok: true, handled: false, reason: "DUPLICATE_DELIVERY" });
          return;
        }
      } catch (err) {
        // Dedup failure must NEVER block the webhook — swallow and continue.
        // Epic #394 P2 review F2 — emit a structured warning so a sustained
        // DB outage that silently lets duplicate reviews through is visible
        // in metrics + logs (instead of a bare `catch {}`).
        log.warn("pr_review.webhook_dedup_failed", {
          deliveryId,
          eventType: eventType || "unknown",
          error: (err as Error).message,
        });
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload = req.body as any;
    const installationId = payload?.installation?.id ? String(payload.installation.id) : null;
    const out = await dispatchGithubPrEvent(payload, {
      onMerged: async ({ pr, repo }) => {
        await syncMergedPR({ pr, repo });
      },
      onReviewable: async ({ pr, repo, action }) => {
        const project = await findProjectForRepo(repo.full_name ?? "");
        if (!project || !project.autoReviewPrs) return;

        const owner = repo.full_name?.split("/")[0] ?? "";
        const repoName = repo.full_name?.split("/")[1] ?? "";
        const prUrl = pr.html_url ?? (repo.html_url ? `${repo.html_url}/pull/${pr.number}` : "");

        // Epic #394 P2 (#403) — async queue path. When a queue is wired
        // we offload the review entirely so the webhook can ACK in <100ms.
        // The processor (registered when the queue was constructed) runs
        // the same `runPrReview` flow on its own event-loop tick.
        //
        // Resolution order: explicit `deps.queue` (test injection) wins,
        // then the production worker singleton (set by `server.ts` at
        // boot), then the legacy inline path below.
        //
        // Post-`e7eb006` fix: the queue check runs BEFORE the inline
        // judge/octokit gate. The worker's processor brings its own
        // judge + octokit factories — requiring router-level injection
        // here was the regression that silently dropped every queued
        // review in production.
        const liveQueue = deps.queue ?? getPrReviewWorker()?.queue ?? null;
        if (liveQueue) {
          liveQueue.enqueue({
            deliveryId,
            projectId: project.id,
            owner,
            repo: repoName,
            prNumber: pr.number,
            context: {
              action,
              prTitle: pr.title ?? `PR #${pr.number}`,
              prBody: pr.body ?? "",
              prUrl,
              installationId,
              headSha: pr.head?.sha ?? null,
              branchName: pr.head?.ref ?? null,
              maxDiffBytes: project.prReviewMaxDiffBytes ?? null,
              skipGlobsRaw: project.prReviewSkipGlobs ?? null,
            },
          });
          return;
        }

        // Inline fallback — only valid when the router is injected with
        // a judge + octokit (legacy unit tests + the `/api/run-reviews`
        // manual route's webhook re-use). No queue + no inline deps =
        // nothing to do, ack and move on.
        if (!deps.judge || !deps.octokit) {
          log.warn("pr_review.no_queue_or_inline_deps", {
            deliveryId,
            repo: `${owner}/${repoName}`,
            prNumber: pr.number,
          });
          return;
        }

        // (#398/#399) Inline fallback path — no async queue wired.
        // Delegates to the shared `executePrReviewJob` so the inline
        // and queued processors stay byte-for-byte identical.
        await executePrReviewJob(
          {
            job: {
              deliveryId,
              projectId: project.id,
              owner,
              repo: repoName,
              prNumber: pr.number,
              context: {
                action,
                branchName: pr.head?.ref ?? null,
              },
              attempt: 1,
              enqueuedAt: Date.now(),
            },
            project,
            prTitle: pr.title ?? `PR #${pr.number}`,
            prBody: pr.body ?? "",
            prUrl,
            installationId,
            actor: { type: "webhook", id: null },
          },
          {
            judge: deps.judge,
            octokit: deps.octokit,
            budget: deps.budget ?? defaultBudgetDeps(),
          },
        );
      },
    });
    res.status(200).json({ ok: true, ...out });
  });

  // Issue #433 — spec-kit issue → tasks.md sync.
  // Issue #438 — defence-in-depth: rate-limit so HMAC failures don't go
  // unthrottled, and dedup on `X-GitHub-Delivery` so re-deliveries don't
  // re-write `tasks.md` twice.
  r.post("/github/issues", githubIssuesWebhookRateLimiter, async (req: Request, res: Response) => {
    const secret = deps.resolveSecret?.() ?? process.env.GITHUB_WEBHOOK_SECRET ?? "";
    const sig = req.header("x-hub-signature-256") ?? undefined;
    const ts = req.header("x-webhook-timestamp") ?? undefined;
    const verdict = verifyGithubPrSignature(rawBody(req), secret, {
      signature: sig,
      timestamp: ts,
    });
    if (!verdict.ok) {
      res.status(401).json({ ok: false, reason: verdict.reason ?? "BAD_SIGNATURE" });
      return;
    }
    // Issue #438 — replay protection. Reuses the existing
    // `pr_review_webhook_deliveries` table (a misnomer post-#438; GitHub
    // delivery UUIDs are globally unique across event types so a single
    // dedup table is sufficient). The `eventType` column stays the
    // discriminator — `issues` here vs `pull_request` for the PR path.
    const deliveryId = (req.header("x-github-delivery") ?? "").trim();
    if (deliveryId && !deps.skipDedup) {
      try {
        const dedup = await recordDelivery({ deliveryId, eventType: "issues" });
        if (dedup.duplicate) {
          res.status(200).json({ ok: true, handled: false, reason: "DUPLICATE_DELIVERY" });
          return;
        }
      } catch (err) {
        // Dedup failure must NEVER block the webhook — swallow + warn.
        log.warn("speckit.issues_webhook_dedup_failed", {
          deliveryId,
          error: (err as Error).message,
        });
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload = req.body as any;
    const action = String(payload?.action ?? "") as IssuesEventAction;
    const issue = payload?.issue;
    const repo = payload?.repository;
    if (!issue || !repo || typeof issue.number !== "number") {
      res.status(200).json({ ok: true, handled: false, reason: "MISSING_ISSUE_OR_REPO" });
      return;
    }
    if (action !== "closed" && action !== "reopened" && action !== "edited") {
      res.status(200).json({ ok: true, handled: false, reason: `UNHANDLED_ACTION:${action}` });
      return;
    }
    const fullName: string = repo.full_name ?? "";
    const [repoOwner, repoName] = fullName.split("/");
    if (!repoOwner || !repoName) {
      res.status(200).json({ ok: true, handled: false, reason: "MISSING_REPO_FULLNAME" });
      return;
    }
    try {
      const outcome = await syncIssueEvent({
        repoOwner,
        repoName,
        issueNumber: issue.number,
        action,
        ...(typeof issue.title === "string" ? { newTitle: issue.title } : {}),
        ...(payload?.changes ? { changes: payload.changes } : {}),
      });
      res.status(200).json({ ok: true, ...outcome });
    } catch (err) {
      // Never 5xx GitHub — log + acknowledge.
      res.status(200).json({
        ok: true,
        handled: false,
        reason: "SYNC_ERROR",
        error: (err as Error).message,
      });
    }
  });

  return r;
}

/**
 * Resolve the Metis project + per-repo PR-review config for a webhook
 * payload. Exported so the worker singleton (set up in `server.ts`)
 * can re-resolve from a queued job — the inline webhook path and the
 * async queue MUST agree on the same project facts so an enqueued
 * review behaves identically to one executed inline.
 */
export async function findProjectForRepo(repoFullName: string): Promise<{
  id: string;
  autoReviewPrs: boolean;
  prReviewMaxDiffBytes: number | null;
  prReviewSkipGlobs: string | null;
} | null> {
  if (!repoFullName) return null;
  const [owner, name] = repoFullName.split("/");
  if (!owner || !name) return null;
  // Use the existing RepoConnection table to look up the project.
  // Epic #640 — prefer the primary repo connection if multiple projects
  // have the same repo connected (primary = source-of-truth link).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const conns = await (prisma as any).repoConnection.findMany({
    where: { ownerOrOrg: owner, repoName: name, deletedAt: null },
    include: { project: true },
    orderBy: { isPrimary: "desc" }, // primary connections first
  });
  const conn = conns[0];
  if (!conn?.project) return null;
  return {
    id: conn.project.id,
    autoReviewPrs: !!conn.project.autoReviewPrs,
    prReviewMaxDiffBytes: conn.project.prReviewMaxDiffBytes ?? null,
    prReviewSkipGlobs: conn.project.prReviewSkipGlobs ?? null,
  };
}
