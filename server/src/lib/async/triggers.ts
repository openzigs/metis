/**
 * Epic #156 (#147) — Event-driven triggers.
 *
 * Verifies signed webhook payloads from generic, GitHub, and Slack sources.
 * Generic: HMAC-SHA256 of `${timestamp}.${rawBody}` against
 *   `Trigger.config.secret`. Header layout:
 *     X-Metis-Timestamp: epoch seconds
 *     X-Metis-Signature: hex sha256 (lowercase or `sha256=<hex>`)
 *   Reject when |now - timestamp| > 5min skew.
 *
 * GitHub: validates `X-Hub-Signature-256: sha256=<hex>` against
 *   `Trigger.config.secret` over raw body.
 *
 * Slack: validates `X-Slack-Signature` (`v0=<hex>`) over the standard
 *   `v0:<timestamp>:<rawBody>` template using `Trigger.config.secret`.
 *   Rejects when |now - timestamp| > 5min.
 */
import crypto from "node:crypto";

const SKEW_MS = 5 * 60 * 1000;

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

export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

export function verifyGenericWebhook(
  rawBody: string,
  secret: string,
  headers: { signature?: string; timestamp?: string },
  now = Date.now(),
): VerifyResult {
  if (!secret) return { ok: false, reason: "MISSING_SECRET" };
  if (!headers.signature) return { ok: false, reason: "MISSING_SIGNATURE" };
  if (!headers.timestamp) return { ok: false, reason: "MISSING_TIMESTAMP" };
  const tsSec = Number.parseInt(headers.timestamp, 10);
  if (!Number.isFinite(tsSec)) return { ok: false, reason: "BAD_TIMESTAMP" };
  if (Math.abs(now - tsSec * 1000) > SKEW_MS) return { ok: false, reason: "EXPIRED" };
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${headers.timestamp}.${rawBody}`)
    .digest("hex");
  const provided = stripPrefix(headers.signature.trim().toLowerCase(), "sha256=");
  if (!timingSafeEqHex(expected, provided)) return { ok: false, reason: "BAD_SIGNATURE" };
  return { ok: true };
}

export function verifyGithubWebhook(
  rawBody: string,
  secret: string,
  signatureHeader: string | undefined,
): VerifyResult {
  if (!secret) return { ok: false, reason: "MISSING_SECRET" };
  if (!signatureHeader) return { ok: false, reason: "MISSING_SIGNATURE" };
  const provided = stripPrefix(signatureHeader.trim().toLowerCase(), "sha256=");
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  if (!timingSafeEqHex(expected, provided)) return { ok: false, reason: "BAD_SIGNATURE" };
  return { ok: true };
}

export function verifySlackWebhook(
  rawBody: string,
  secret: string,
  headers: { signature?: string; timestamp?: string },
  now = Date.now(),
): VerifyResult {
  if (!secret) return { ok: false, reason: "MISSING_SECRET" };
  if (!headers.signature) return { ok: false, reason: "MISSING_SIGNATURE" };
  if (!headers.timestamp) return { ok: false, reason: "MISSING_TIMESTAMP" };
  const tsSec = Number.parseInt(headers.timestamp, 10);
  if (!Number.isFinite(tsSec)) return { ok: false, reason: "BAD_TIMESTAMP" };
  if (Math.abs(now - tsSec * 1000) > SKEW_MS) return { ok: false, reason: "EXPIRED" };
  const base = `v0:${headers.timestamp}:${rawBody}`;
  const expected = crypto.createHmac("sha256", secret).update(base).digest("hex");
  const provided = stripPrefix(headers.signature.trim().toLowerCase(), "v0=");
  if (!timingSafeEqHex(expected, provided)) return { ok: false, reason: "BAD_SIGNATURE" };
  return { ok: true };
}

/** Sign a generic payload — used by tests + an admin "Test fire" button. */
export function signGenericWebhook(
  rawBody: string,
  secret: string,
  timestampSec: number,
): { signature: string; timestamp: string } {
  const sig = crypto
    .createHmac("sha256", secret)
    .update(`${timestampSec}.${rawBody}`)
    .digest("hex");
  return { signature: `sha256=${sig}`, timestamp: String(timestampSec) };
}
