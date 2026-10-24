/**
 * Epic #192 (A.3) + Epic #394 — GitHub PR webhook receiver.
 *
 * Mounted under `/api/webhooks`: `POST github/pr` and `POST github/issues`
 * (spec-kit task sync #433 + drift reconcile #96). Verifies the
 * `X-Hub-Signature-256` HMAC against `GITHUB_WEBHOOK_SECRET` (and, for
 * `github/pr`, against a repository connector's own secret, #1475), then dispatches
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
import {
  reconcileGithubIssueDelivery,
  type ReconcileDeps,
  type ReconcileResult,
} from "../lib/sync/index.js";
import { recordDelivery } from "../lib/agents/pr-reviewer/webhook-dedup.js";
import { githubIssuesWebhookRateLimiter } from "../middleware/github-issues-webhook-rate-limit.js";
import { webhookReceiverRateLimiter } from "../middleware/webhook-receiver-rate-limit.js";
import type { PrReviewQueue } from "../lib/agents/pr-reviewer/queue.js";
import { getPrReviewWorker } from "../lib/agents/pr-reviewer/worker-singleton.js";
import { executePrReviewJob } from "../lib/agents/pr-reviewer/pr-review-job.js";
import { createChildLogger } from "../lib/logger.js";
import { recordJobScope } from "../lib/socket/job-scope-store.js";
import { logDeletedProjectSkip } from "../lib/projects/deleted-project-guard.js";
import {
  connectorWebhookSecret,
  webhookSecretRootKey,
} from "../lib/connectors/repo/webhook-secret.js";

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
  /** Issue #96 — drift reconcile deps for `POST /github/issues` (test seam). */
  reconcileDeps?: ReconcileDeps;
}

export function githubPrWebhookRouter(deps: GithubPrRouterDeps = {}): Router {
  const r = Router();

  // #105 — this receiver was throttled only because the triggers router's
  // path-less limiter leaked onto the shared `/webhooks` prefix. Scoping that
  // limiter to its own routes would have left `/github/pr` unthrottled, so it
  // now carries the shared receiver budget explicitly — counted once.
  r.post("/github/pr", webhookReceiverRateLimiter, async (req: Request, res: Response) => {
    // #1475 — the deployment secret, or the own secret of one connector for
    // the payload's repository; who signed decides which project it is for.
    const verdict = await verifyPrDelivery(req, deps);
    if (!verdict.ok) {
      res.status(401).json({ ok: false, reason: verdict.reason });
      return;
    }
    const signer = verdict.signer;

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
        // #1475 — a connector-signed merge touches only its own project's
        // requirements: that project holds the secret, the others do not.
        await syncMergedPR({
          pr,
          repo,
          ...(signer.kind === "connector" ? { projectId: signer.projectId } : {}),
        });
      },
      onReviewable: async ({ pr, repo, action }) => {
        const project =
          signer.kind === "connector"
            ? await findLiveProject(signer.projectId)
            : await findProjectForRepo(repo.full_name ?? "", deliveryId);
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
          // #674 — the queue dispatches in the enqueue tick, and `started`
          // names the job on `project:{id}`; so the durable scope is written
          // in the pre-dispatch hook, and a socket on any replica that learns
          // the id from that broadcast is authorized for `job:{id}`. A
          // shutdown-rejected enqueue records nothing.
          await liveQueue.enqueueAfter(
            {
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
            },
            (jobId) => recordJobScope(jobId, "pr-review", project.id),
          );
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
                headSha: pr.head?.sha ?? null,
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

  // Issue #433 — spec-kit issue → tasks.md sync, and (#96) Epic #739 drift
  // reconcile: the ONLY registration of this path — see runDriftReconcile.
  // Issue #438 — defence-in-depth: rate-limit so HMAC failures don't go
  // unthrottled, and dedup on `X-GitHub-Delivery` so re-deliveries don't
  // re-write `tasks.md` twice.
  // #105 — keeps the shared receiver budget it had via the leak, now counted once.
  const issuesLimiters = [webhookReceiverRateLimiter, githubIssuesWebhookRateLimiter];
  r.post("/github/issues", issuesLimiters, async (req: Request, res: Response) => {
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
    // Issue #96 — ONE receiver, two pipelines. The drift reconciler used to
    // register its own `POST /github/issues` on the same `/webhooks` prefix,
    // after this one, so it was never reached. Both run on every verified,
    // non-duplicate delivery; the spec-kit outcome keeps the top level of the
    // envelope (unchanged for existing callers) and drift is reported under
    // `drift`. Neither pipeline's failure may 5xx GitHub or skip the other.
    const specKit = await runSpecKitIssueSync(payload);
    const drift = await runDriftReconcile({
      eventType: req.header("x-github-event") ?? "",
      deliveryId: deliveryId || crypto.randomUUID(),
      payload,
      reconcileDeps: deps.reconcileDeps,
    });
    res.status(200).json({ ok: true, ...specKit, drift });
  });

  return r;
}

/** Issue #433 — spec-kit issue → `tasks.md` sync; never throws. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runSpecKitIssueSync(payload: any): Promise<Record<string, unknown>> {
  const action = String(payload?.action ?? "") as IssuesEventAction;
  const issue = payload?.issue;
  const repo = payload?.repository;
  if (!issue || !repo || typeof issue.number !== "number") {
    return { handled: false, reason: "MISSING_ISSUE_OR_REPO" };
  }
  if (action !== "closed" && action !== "reopened" && action !== "edited") {
    return { handled: false, reason: `UNHANDLED_ACTION:${action}` };
  }
  const fullName: string = repo.full_name ?? "";
  const [repoOwner, repoName] = fullName.split("/");
  if (!repoOwner || !repoName) {
    return { handled: false, reason: "MISSING_REPO_FULLNAME" };
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
    return { ...outcome };
  } catch (err) {
    // Never 5xx GitHub — log + acknowledge. #113: the message goes to the log,
    // never the response, the same as the drift half (#86).
    log.warn("speckit.issues_webhook_sync_failed", {
      repo: fullName,
      issueNumber: issue.number,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return { handled: false, reason: "SYNC_ERROR" };
  }
}

/** Issue #96 — Epic #739 drift reconcile for the same delivery; never throws. */
async function runDriftReconcile(input: {
  eventType: string;
  deliveryId: string;
  payload: unknown;
  reconcileDeps?: ReconcileDeps;
}): Promise<ReconcileResult> {
  try {
    return await reconcileGithubIssueDelivery(
      { eventType: input.eventType, deliveryId: input.deliveryId, payload: input.payload },
      input.reconcileDeps,
    );
  } catch (err) {
    // The message stays in the log, not the response (#86).
    log.warn("sync.webhook.github.drift_failed", {
      deliveryId: input.deliveryId,
      error: (err as Error).message,
    });
    return { handled: false, reason: "DRIFT_ERROR" };
  }
}

/** #1475 — who signed a verified `pull_request` delivery. */
type DeliverySigner =
  { kind: "deployment" } | { kind: "connector"; connectorId: string; projectId: string };

/**
 * #1475 — verify a `pull_request` delivery and say who signed it.
 *
 * The deployment secret (`GITHUB_WEBHOOK_SECRET`) is tried first and needs no
 * database. Only a delivery it does not verify, but which carries a
 * signature, is tried against the own secret of each live connector, in a
 * live project, for the payload's repository. A connector's secret is bound to
 * its id (`connectorWebhookSecret`), so at most one connector can match; the
 * match is the signer. A refusal is the deployment check's reason whether or
 * not any connector exists for the repository, so it never says that some
 * other project connects it.
 */
async function verifyPrDelivery(
  req: Request,
  deps: GithubPrRouterDeps,
): Promise<{ ok: true; signer: DeliverySigner } | { ok: false; reason: string }> {
  const body = rawBody(req);
  const headers = {
    signature: req.header("x-hub-signature-256") ?? undefined,
    timestamp: req.header("x-webhook-timestamp") ?? undefined,
  };
  const deploymentSecret = deps.resolveSecret?.() ?? process.env.GITHUB_WEBHOOK_SECRET ?? "";
  const deployment = verifyGithubPrSignature(body, deploymentSecret, headers);
  if (deployment.ok) return { ok: true, signer: { kind: "deployment" } };
  const refused = {
    ok: false as const,
    reason: deployment.reason ?? "BAD_SIGNATURE",
  };
  // No signature at all, or a good one with a bad timestamp: nothing to retry.
  if (deployment.reason !== "BAD_SIGNATURE" && deployment.reason !== "MISSING_SECRET") {
    return refused;
  }
  if (!headers.signature) return refused;
  const root = webhookSecretRootKey();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fullName: unknown = (req.body as any)?.repository?.full_name;
  const [owner, name] = typeof fullName === "string" ? fullName.split("/") : [];
  if (!root || !owner || !name) return refused;

  const candidates = await prisma.repoConnection.findMany({
    where: {
      ownerOrOrg: owner,
      repoName: name,
      deletedAt: null,
      webhookSecretNonce: { not: null },
      project: { deletedAt: null },
    },
    select: { id: true, projectId: true, webhookSecretNonce: true },
  });
  for (const c of candidates) {
    const secret = connectorWebhookSecret(root, c.id, c.webhookSecretNonce ?? "");
    const v = verifyGithubPrSignature(body, secret, headers);
    if (v.ok) {
      return {
        ok: true,
        signer: {
          kind: "connector",
          connectorId: c.id,
          projectId: c.projectId,
        },
      };
    }
    if (v.reason !== "BAD_SIGNATURE") return { ok: false, reason: v.reason ?? "BAD_SIGNATURE" };
  }
  return refused;
}

/** The project facts a PR review needs. */
export interface WebhookProjectConfig {
  id: string;
  autoReviewPrs: boolean;
  prReviewMaxDiffBytes: number | null;
  prReviewSkipGlobs: string | null;
}

function toConfig(project: {
  id: string;
  autoReviewPrs?: boolean | null;
  prReviewMaxDiffBytes?: number | null;
  prReviewSkipGlobs?: string | null;
}): WebhookProjectConfig {
  return {
    id: project.id,
    autoReviewPrs: !!project.autoReviewPrs,
    prReviewMaxDiffBytes: project.prReviewMaxDiffBytes ?? null,
    prReviewSkipGlobs: project.prReviewSkipGlobs ?? null,
  };
}

/** #1475 — the project a connector-signed delivery is for, while it is live. */
async function findLiveProject(projectId: string): Promise<WebhookProjectConfig | null> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
  });
  return project ? toConfig(project) : null;
}

/**
 * #1438 / #1475 — the queued PR-review worker's project resolver. A job runs
 * only for the project it was enqueued for (the one the delivery was
 * attributed to when it arrived) and only while that project is live and
 * still connects the repository. Another project connecting the same
 * repository since changes nothing: a job is never re-attributed.
 *
 * #1470 — a project that switched auto-review off since is still returned
 * (with `autoReviewPrs: false`) so `executePrReviewJob` records the skip on
 * the pull requests page; the executor's first gate refuses to review it, and
 * the worker resolves no judge or GitHub client for it.
 */
export async function resolveProjectForQueuedReview(job: {
  deliveryId: string;
  projectId: string;
  owner: string;
  repo: string;
  prNumber: number;
}): Promise<WebhookProjectConfig | null> {
  const conn = await prisma.repoConnection.findFirst({
    where: {
      projectId: job.projectId,
      ownerOrOrg: job.owner,
      repoName: job.repo,
      deletedAt: null,
      project: { deletedAt: null },
    },
    include: { project: true },
  });
  if (!conn) {
    log.warn("pr_review.queued_project_gone", {
      deliveryId: job.deliveryId,
      repo: `${job.owner}/${job.repo}`,
      prNumber: job.prNumber,
      enqueuedFor: job.projectId,
    });
    return null;
  }
  return toConfig(conn.project);
}

/**
 * #1475 — the project a delivery signed with the DEPLOYMENT secret is for.
 *
 * That secret is shared by every registration that uses it, so it cannot say
 * which one sent the delivery. It is attributed only when exactly one live
 * project takes deployment-signed deliveries for the repository; a connector
 * with its own webhook secret takes only the deliveries its secret signed.
 * Two or more such projects is ambiguous, and the delivery goes to none of
 * them (logged for the operator), never to "the first primary connector
 * found", which let a project in another workspace take a repository's
 * deliveries over just by connecting it.
 */
export async function findProjectForRepo(
  repoFullName: string,
  deliveryId?: string,
): Promise<WebhookProjectConfig | null> {
  if (!repoFullName) return null;
  const [owner, name] = repoFullName.split("/");
  if (!owner || !name) return null;
  const conns = await prisma.repoConnection.findMany({
    where: { ownerOrOrg: owner, repoName: name, deletedAt: null },
    include: { project: true },
  });
  // #1438 — a soft-deleted project is never reviewed for. Filtered here rather
  // than in the query so the skip can be logged.
  const live = conns.filter((c) => c.project && !c.project.deletedAt);
  const owners = new Map(
    live.filter((c) => !c.webhookSecretNonce).map((c) => [c.project.id, c.project]),
  );
  if (owners.size === 1) return toConfig([...owners.values()][0]);
  if (owners.size > 1) {
    log.warn("pr_review.webhook_owner_ambiguous", {
      deliveryId,
      repo: repoFullName,
      projectIds: [...owners.keys()],
      hint: "give each project's repository connection its own webhook secret",
    });
    return null;
  }
  if (live.length === 0) {
    const deleted = conns.find((c) => c.project?.deletedAt);
    if (deleted) {
      logDeletedProjectSkip({
        path: "pr-review",
        projectId: deleted.project.id,
        sourceType: "repo",
        sourceId: repoFullName,
      });
    }
  }
  return null;
}
