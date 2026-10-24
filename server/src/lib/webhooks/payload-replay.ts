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

export interface PayloadClaim {
  /**
   * Endpoint scope: `github-pr`, `github-pr:c:<connectorId>`, `github-issues`,
   * `github-issues:c:<connectorId>` (#1483), `jira-issues`.
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

/** Drop claims older than `retentionMs`; called hourly by the PR-review worker. */
export async function purgeOldPayloadDigests(
  retentionMs: number = PAYLOAD_DIGEST_RETENTION_MS,
  now: number = Date.now(),
): Promise<number> {
  const result = await table().deleteMany({
    where: { receivedAt: { lt: new Date(now - retentionMs) } },
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
    return isObject(payload.comment) ? "issue_comment" : "issues";
  }
  return null;
}
