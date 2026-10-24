/**
 * Epic #192 (A.3 + A.5) — GitHub PR webhook verification + dispatch.
 *
 * Verifies the standard GitHub `X-Hub-Signature-256` HMAC header against
 * `GITHUB_WEBHOOK_SECRET` (or a connector's own secret, #1475).
 *
 * #1484 — there is deliberately no timestamp check. GitHub signs the body
 * only, so any `X-Webhook-Timestamp` header sits outside the HMAC: whoever
 * replays a captured delivery sets it to "now" (or drops it), and the check
 * refused nothing an attacker could not walk around. No METIS sender sets that
 * header either, so there is no `timestamp.body` scheme to sign instead. Replay
 * protection lives after this check, keyed on the signed body itself:
 * `lib/webhooks/payload-replay.ts`.
 *
 * `dispatchGithubPrEvent` is a thin router: it calls the living-spec sync
 * for `pull_request.closed` (when merged) and the PR-reviewer agent for
 * `pull_request.opened` and `pull_request.synchronize`. Both downstream
 * handlers are injected so tests stay hermetic.
 */
import crypto from "node:crypto";

export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

function timingSafeEqHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

function stripPrefix(sig: string, prefix: string): string {
  return sig.startsWith(prefix) ? sig.slice(prefix.length) : sig;
}

export function verifyGithubPrSignature(
  rawBody: string,
  secret: string,
  headers: { signature?: string },
): VerifyResult {
  if (!secret) return { ok: false, reason: "MISSING_SECRET" };
  if (!headers.signature) return { ok: false, reason: "MISSING_SIGNATURE" };
  const provided = stripPrefix(headers.signature.trim().toLowerCase(), "sha256=");
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  if (!timingSafeEqHex(expected, provided)) return { ok: false, reason: "BAD_SIGNATURE" };
  return { ok: true };
}

export interface PullRequestPayload {
  number: number;
  html_url?: string;
  title?: string;
  body?: string | null;
  merged?: boolean;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  head?: { sha?: string; ref?: string };
  base?: { sha?: string; ref?: string };
  user?: { login?: string };
}

export interface RepositoryPayload {
  full_name?: string;
  html_url?: string;
}

export interface GithubPrWebhookPayload {
  action?: string;
  pull_request?: PullRequestPayload;
  repository?: RepositoryPayload;
}

export interface DispatchHandlers {
  /** Invoked on `pull_request.closed` with `merged:true`. */
  onMerged: (input: { pr: PullRequestPayload; repo: RepositoryPayload }) => Promise<void>;
  /** Invoked on `pull_request.opened` and `pull_request.synchronize`. */
  onReviewable: (input: {
    pr: PullRequestPayload;
    repo: RepositoryPayload;
    action: string;
  }) => Promise<void>;
}

export type DispatchOutcome =
  | { handled: true; kind: "merged" | "reviewable"; action: string }
  | { handled: false; reason: string };

export async function dispatchGithubPrEvent(
  payload: GithubPrWebhookPayload,
  handlers: DispatchHandlers,
): Promise<DispatchOutcome> {
  const action = payload.action ?? "";
  const pr = payload.pull_request;
  const repo = payload.repository;
  if (!pr || !repo) return { handled: false, reason: "MISSING_PR_OR_REPO" };
  if (action === "closed") {
    if (pr.merged) {
      await handlers.onMerged({ pr, repo });
      return { handled: true, kind: "merged", action };
    }
    return { handled: false, reason: "PR_NOT_MERGED" };
  }
  if (action === "opened" || action === "synchronize" || action === "reopened") {
    await handlers.onReviewable({ pr, repo, action });
    return { handled: true, kind: "reviewable", action };
  }
  return { handled: false, reason: `UNHANDLED_ACTION:${action || "unknown"}` };
}
