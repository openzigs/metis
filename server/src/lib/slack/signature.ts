/**
 * Issue #579 (epic #63) — Slack request-signature verification.
 *
 * Slack signs every inbound request (slash commands, interactivity, events,
 * OAuth) with an HMAC-SHA256 over `v0:${timestamp}:${rawBody}` keyed by the app's
 * signing secret, delivered in the `X-Slack-Signature` header alongside an
 * `X-Slack-Request-Timestamp`. Verification is the FIRST line of defence — an
 * unsigned/forged request must be rejected before any handler logic runs.
 *
 * WHY A THIN WRAPPER (not "Bolt does it for us"): the production receiver
 * (`bolt-app.ts`) IS configured with the signing secret so Bolt's own middleware
 * enforces this on the receiver path. But the verification policy is
 * security-critical and we (a) want it independently unit-tested and (b) want a
 * single, explicit choke point we can reason about. So this module delegates the
 * cryptography to Slack's audited `verifySlackRequest` primitive (constant-time
 * `tsscmp` compare, no home-grown HMAC) while owning the replay-window policy and
 * the safe boolean/throwing surfaces. We NEVER bypass verification.
 *
 * SECURITY:
 *   - Replay protection: requests older than {@link REPLAY_WINDOW_SECONDS} (Slack's
 *     documented 5-minute window) are rejected even if the signature is valid.
 *   - Constant-time signature compare (delegated to `tsscmp` via Slack's util).
 *   - Treats ALL inputs as untrusted: missing/malformed headers → rejected, never
 *     throws an unhandled error to the caller.
 */
import { isValidSlackRequest } from "@slack/bolt";

/** Slack's documented replay window — reject timestamps older than 5 minutes. */
export const REPLAY_WINDOW_SECONDS = 60 * 5;

/** The raw header material needed to verify a Slack request. */
export interface SlackSignatureHeaders {
  /** `X-Slack-Signature` — `v0=<hex hmac>`. */
  signature: string | undefined;
  /** `X-Slack-Request-Timestamp` — unix seconds (string off the wire). */
  timestamp: string | undefined;
}

/** Distinguishes WHY a request was rejected (for structured logs; never leaked). */
export type SignatureRejection =
  | "missing_signature"
  | "missing_timestamp"
  | "invalid_timestamp"
  | "stale_timestamp"
  | "bad_signature";

export type SignatureCheck = { ok: true } | { ok: false; reason: SignatureRejection };

export interface VerifyParams {
  signingSecret: string;
  /** The EXACT raw request body Slack signed (pre-JSON-parse). */
  rawBody: string;
  headers: SlackSignatureHeaders;
  /** Injectable clock (ms) for deterministic replay-window tests. */
  nowMs?: number;
}

/**
 * Verify a Slack request signature + freshness. Returns a structured result
 * rather than throwing, so callers can log the precise reason and respond with a
 * generic 401 (the reason is never sent to the client — that would aid an
 * attacker probing the boundary).
 *
 * Order matters: cheap header/format checks first, then the replay-window check,
 * then the (more expensive) constant-time HMAC compare LAST.
 */
export function verifySlackSignature(params: VerifyParams): SignatureCheck {
  const { signingSecret, rawBody, headers } = params;
  const now = params.nowMs ?? Date.now();

  const signature = (headers.signature ?? "").trim();
  if (!signature) return { ok: false, reason: "missing_signature" };

  const rawTs = (headers.timestamp ?? "").trim();
  if (!rawTs) return { ok: false, reason: "missing_timestamp" };

  // Timestamps are unix SECONDS; reject anything non-integer (untrusted input).
  if (!/^\d+$/.test(rawTs)) return { ok: false, reason: "invalid_timestamp" };
  const timestamp = Number(rawTs);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return { ok: false, reason: "invalid_timestamp" };
  }

  // Replay protection: reject stale requests BEFORE the HMAC compare. We check
  // the absolute skew so a far-future timestamp is rejected too (clock-skew abuse).
  const ageSeconds = Math.abs(Math.floor(now / 1000) - timestamp);
  if (ageSeconds > REPLAY_WINDOW_SECONDS) {
    return { ok: false, reason: "stale_timestamp" };
  }

  // Delegate the cryptographic compare to Slack's audited primitive (constant
  // time). It also re-checks the window using `nowMilliseconds`, so we pass our
  // injected clock through for consistency. Any thrown error → bad signature.
  let valid = false;
  try {
    valid = isValidSlackRequest({
      signingSecret,
      body: rawBody,
      headers: {
        "x-slack-signature": signature,
        "x-slack-request-timestamp": timestamp,
      },
      nowMilliseconds: now,
    });
  } catch {
    valid = false;
  }
  return valid ? { ok: true } : { ok: false, reason: "bad_signature" };
}
