/**
 * Issue #1484 — replay guard for signed webhook deliveries.
 *
 * GitHub's `X-Hub-Signature-256` (and Jira's signature) covers the request
 * body and nothing else. The `X-GitHub-Delivery` id is unsigned, so the
 * delivery-id dedup (`webhook-dedup.ts`) stops GitHub's own redeliveries but
 * not an attacker who resends a captured body under a fresh id. This module
 * keys a delivery on what the signature does cover:
 *
 *   (receiver, event type, SHA-256 of the raw signed body)
 *
 * stored durably in `webhook_payload_digests` under a unique constraint, so a
 * second claim is refused across restarts and across replicas.
 *
 * - `receiver` scopes the claim to the endpoint (and connector) that verified
 *   it: the same repository event legitimately reaches two webhooks — one per
 *   registration — with byte-identical bodies signed by different secrets.
 * - `eventType` is the route's own fixed event, never the `X-GitHub-Event`
 *   header: that header is unsigned too, and keying on it would let a replay
 *   mint a new key by changing it.
 *
 * Retention: `PAYLOAD_DIGEST_RETENTION_MS` (7 days). A body older than that
 * would be claimable again, so the receivers also refuse a GitHub event whose
 * own signed `updated_at` is older than `SIGNED_EVENT_MAX_AGE_MS` (4 days).
 * Every replay is then caught by one or the other: a body young enough to pass
 * the age check is still inside the retention window. 4 days covers GitHub's
 * 3-day manual-redelivery window ("Recent Deliveries") with a day of margin for
 * delayed deliveries; the 3-day gap to retention absorbs clock skew.
 *
 * That invariant needs a signed time. The `/github/pr` and `/github/issues`
 * receivers act only on bodies that carry one. The trigger receiver (#1492)
 * accepts any event, and some carry no signed time this module can trust
 * (`create`, `delete`, `ping`, a release `edited`, …). Such a claim goes under
 * `UNTIMED_RECEIVER_PREFIX` and is kept `UNTIMED_PAYLOAD_DIGEST_RETENTION_MS`
 * (90 days). So a body with no signed time is refused for 90 days and could
 * fire once more after that: bounded storage, at the price of a 90-day (not
 * unlimited) replay horizon for those events alone.
 *
 * No function here runs before the caller has verified the signature.
 */
import crypto from "node:crypto";
import { prisma } from "../prisma.js";
import { isUniqueViolation } from "../db/prisma-errors.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long a claimed body stays claimed. Must exceed `SIGNED_EVENT_MAX_AGE_MS`. */
export const PAYLOAD_DIGEST_RETENTION_MS = 7 * DAY_MS;

/** Oldest signed `updated_at` a GitHub delivery may carry and still be processed. */
export const SIGNED_EVENT_MAX_AGE_MS = 4 * DAY_MS;

/**
 * #1492 — how long a claim on a body with NO readable signed time is kept.
 * No age check can back it up, so only the claim stops a replay.
 */
export const UNTIMED_PAYLOAD_DIGEST_RETENTION_MS = 90 * DAY_MS;

/** #1492 — receiver prefix marking a claim kept `UNTIMED_PAYLOAD_DIGEST_RETENTION_MS`. */
export const UNTIMED_RECEIVER_PREFIX = "untimed:";

export interface PayloadClaim {
  /**
   * Endpoint scope: `github-pr`, `github-pr:c:<connectorId>`, `github-issues`,
   * `github-issues:c:<connectorId>` (#1483), `jira-issues`, and
   * `github-trigger:<triggerId>` (#1492).
   */
  receiver: string;
  /** The event the signed body is (`signedGithubEvent`) — never an unsigned header. */
  eventType: string;
  /** The exact body the signature was verified over. */
  rawBody: string;
}

export interface PayloadClaimResult {
  /** True when this body was already accepted by this receiver (caller must skip). */
  duplicate: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function table(): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (prisma as any).webhookPayloadDigest;
}

function keyOf(claim: PayloadClaim) {
  return {
    receiver: claim.receiver,
    eventType: claim.eventType,
    bodySha256: crypto.createHash("sha256").update(claim.rawBody, "utf8").digest("hex"),
  };
}

/**
 * Claim a verified delivery's body. `{ duplicate: true }` means the same body
 * was already accepted by this receiver inside the retention window.
 */
export async function claimPayload(claim: PayloadClaim): Promise<PayloadClaimResult> {
  try {
    await table().create({ data: keyOf(claim) });
    return { duplicate: false };
  } catch (err) {
    if (isUniqueViolation(err)) return { duplicate: true };
    throw err;
  }
}

/**
 * Give a claim back, so a GitHub redelivery of a delivery whose processing
 * failed is processed instead of being dropped as a duplicate.
 */
export async function releasePayload(claim: PayloadClaim): Promise<void> {
  const key = keyOf(claim);
  await table().deleteMany({ where: key });
}

/**
 * Drop claims older than `retentionMs`, and untimed claims (#1492) older than
 * `untimedRetentionMs`; called hourly by the PR-review worker.
 */
export async function purgeOldPayloadDigests(
  retentionMs: number = PAYLOAD_DIGEST_RETENTION_MS,
  now: number = Date.now(),
  untimedRetentionMs: number = UNTIMED_PAYLOAD_DIGEST_RETENTION_MS,
): Promise<number> {
  const result = await table().deleteMany({
    where: {
      OR: [
        {
          receivedAt: { lt: new Date(now - retentionMs) },
          NOT: { receiver: { startsWith: UNTIMED_RECEIVER_PREFIX } },
        },
        { receivedAt: { lt: new Date(now - untimedRetentionMs) } },
      ],
    },
  });
  return Number(result?.count ?? 0);
}

/**
 * The signed `updated_at` of a GitHub `pull_request` or `issues` delivery, as
 * epoch milliseconds, or `null` when the payload carries none we can read.
 * It is inside the signed body, so unlike a header it cannot be refreshed.
 */
export function signedEventTime(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as {
    pull_request?: { updated_at?: unknown };
    issue?: { updated_at?: unknown };
  };
  const raw = p.pull_request?.updated_at ?? p.issue?.updated_at;
  if (typeof raw !== "string") return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * True when the delivery's signed `updated_at` is older than
 * `SIGNED_EVENT_MAX_AGE_MS`. A payload with no readable `updated_at` is not
 * stale: it is still covered by the digest claim inside the retention window.
 */
export function isStaleSignedEvent(payload: unknown, now: number = Date.now()): boolean {
  const at = signedEventTime(payload);
  return at !== null && now - at > SIGNED_EVENT_MAX_AGE_MS;
}

/** #1483 — the GitHub events a signed body can be told apart as. */
export type SignedGithubEvent =
  | "pull_request"
  | "pull_request_review"
  | "pull_request_review_comment"
  | "pull_request_review_thread"
  | "issues"
  | "issue_comment";

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * #1483 — the event a GitHub delivery is, read from its SIGNED body rather than
 * the unsigned `X-GitHub-Event` header, which a replay can rewrite (a captured
 * `issue_comment` body sent again as `issues`, or a body captured at one
 * receiver sent to the other).
 *
 * GitHub's payloads for these events have distinct top-level shapes: every
 * pull-request event carries `pull_request`, and the review ones add `review`,
 * `comment` or `thread`; an `issue_comment` carries `issue` and `comment`; an
 * `issues` event carries `issue` and none of those. `null` means the body is
 * none of them (a `ping`, a `push`, …), and no receiver here processes it.
 *
 * Each body therefore names exactly one receiver that acts on it: `/github/pr`
 * acts on `pull_request` only and `/github/issues` on `issues` only, so a body
 * one of them accepted does nothing at the other.
 */
export function signedGithubEvent(payload: unknown): SignedGithubEvent | null {
  if (!isObject(payload)) return null;
  if (isObject(payload.pull_request)) {
    if (isObject(payload.review)) return "pull_request_review";
    if (isObject(payload.comment)) return "pull_request_review_comment";
    if (isObject(payload.thread)) return "pull_request_review_thread";
    return "pull_request";
  }
  if (isObject(payload.issue)) {
    if (isObject(payload.comment)) return "issue_comment";
    // An `issues` event always carries its action and repository. Requiring
    // both keeps another event that happens to embed an `issue` object from
    // reading as `issues`.
    return typeof payload.action === "string" && isObject(payload.repository) ? "issues" : null;
  }
  return null;
}

/**
 * #1492 — the events a GitHub trigger (`POST /api/webhooks/github`) can tell
 * apart from the signed body: everything `signedGithubEvent` classifies, plus
 * `push`, the event async triggers are most often pointed at.
 */
export type SignedTriggerEvent = SignedGithubEvent | "push";

export const SIGNED_TRIGGER_EVENTS: ReadonlySet<string> = new Set<SignedTriggerEvent>([
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "pull_request_review_thread",
  "issues",
  "issue_comment",
  "push",
]);

/**
 * A `push` payload carries `ref`, `before` and `after` as strings, a `commits`
 * array and a `pusher` object. `create` and `delete` carry `ref` but neither
 * `before`/`after` nor `commits`, so they do not read as `push`.
 */
function isPushBody(payload: Record<string, unknown>): boolean {
  return (
    typeof payload.ref === "string" &&
    typeof payload.before === "string" &&
    typeof payload.after === "string" &&
    Array.isArray(payload.commits) &&
    isObject(payload.pusher)
  );
}

/**
 * #1492 — the event a trigger delivery is, read from its signed body; `null`
 * when the body is none of `SIGNED_TRIGGER_EVENTS`. Pull-request and issue
 * shapes are checked first, and none of them carries a push's fields.
 */
export function signedTriggerEvent(payload: unknown): SignedTriggerEvent | null {
  const event = signedGithubEvent(payload);
  if (event !== null) return event;
  return isObject(payload) && isPushBody(payload) ? "push" : null;
}

/**
 * Release actions whose `published_at` is the time of the event itself. Not
 * `released`: GitHub also sends it when a pre-release is promoted, an edit
 * that keeps the old `published_at`.
 */
const TIMED_RELEASE_ACTIONS: ReadonlySet<string> = new Set(["created", "published", "prereleased"]);

function isoTime(raw: unknown): number {
  if (typeof raw !== "string") return -Infinity;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : -Infinity;
}

/** The ISO time at `obj[key]` for each key, when `obj` is an object. */
function timesOf(obj: unknown, ...keys: string[]): number[] {
  return isObject(obj) ? keys.map((k) => isoTime(obj[k])) : [];
}

/**
 * #1492 — the signed time a trigger delivery happened at, as epoch ms, or
 * `null` when its body carries none this module trusts.
 *
 * Only GitHub-set times are read, never a committer-set one (a push's
 * `head_commit.timestamp` is whatever the commit says, so a future-dated
 * commit would hold the window open). The NEWEST readable time decides: each
 * is no later than the event, and one of them is the event's own time, so a
 * comment edited on an issue untouched for days is not mistaken for old.
 *
 * - `push`: `repository.pushed_at` (epoch SECONDS in a push payload, and the
 *   time of this push; on other events it is the repository's last push, so it
 *   is read for `push` only).
 * - Pull-request and issue events: `updated_at`, `comment.updated_at`,
 *   `review.submitted_at`.
 * - `release.published_at`, for `created`, `published` and `prereleased`
 *   only: an `edited`, `deleted` or promoted (`released`) release keeps its
 *   old time, and a draft has none, so those are untimed.
 * - `workflow_run.updated_at`; `workflow_job` `created_at`/`started_at`/
 *   `completed_at`; `deployment` and `deployment_status` `created_at`/`updated_at`.
 *
 * Whether a body is timed depends on the body alone, so a replay is always
 * claimed under the same key as the delivery it copies.
 */
export function signedTriggerEventTime(payload: unknown): number | null {
  if (!isObject(payload)) return null;
  const event = signedTriggerEvent(payload);
  if (event === "push") {
    const repo = payload.repository;
    const pushedAt = isObject(repo) ? repo.pushed_at : undefined;
    return typeof pushedAt === "number" && Number.isFinite(pushedAt) ? pushedAt * 1000 : null;
  }
  const times: number[] = [];
  if (event !== null) {
    times.push(
      signedEventTime(payload) ?? -Infinity,
      ...timesOf(payload.comment, "updated_at"),
      ...timesOf(payload.review, "submitted_at"),
    );
  } else {
    if (typeof payload.action === "string" && TIMED_RELEASE_ACTIONS.has(payload.action)) {
      // Never `release.created_at`: GitHub documents it as the date of the
      // release's COMMIT, not of the release, so a draft on an old commit
      // would read as stale. A draft has no `published_at` and is untimed.
      times.push(...timesOf(payload.release, "published_at"));
    }
    times.push(
      ...timesOf(payload.workflow_run, "updated_at"),
      ...timesOf(payload.workflow_job, "created_at", "started_at", "completed_at"),
      ...timesOf(payload.deployment, "created_at", "updated_at"),
      ...timesOf(payload.deployment_status, "created_at", "updated_at"),
    );
  }
  const at = Math.max(-Infinity, ...times);
  return Number.isFinite(at) ? at : null;
}

/**
 * #1492 — `isStaleSignedEvent` for a trigger delivery: its
 * `signedTriggerEventTime` is older than `SIGNED_EVENT_MAX_AGE_MS`. A body
 * with no signed time is not stale; its claim is kept
 * `UNTIMED_PAYLOAD_DIGEST_RETENTION_MS` instead.
 */
export function isStaleSignedTriggerEvent(payload: unknown, now: number = Date.now()): boolean {
  const at = signedTriggerEventTime(payload);
  return at !== null && now - at > SIGNED_EVENT_MAX_AGE_MS;
}
