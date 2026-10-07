/**
 * #682 — telling a rate-limited room join from an authorization denial.
 *
 * The server refuses a room join over its join rate limit with a room-scoped
 * `auth:error` carrying `code: "RATE_LIMITED"` and `retryAfterMs`. That join was
 * legitimate and only early, so a follower keeps the room and sends its
 * subscribe again after the delay, while it still follows the room. An
 * authorization denial carries no `code`; followers treat it as before.
 *
 * Each retry adds a little random jitter, so many followers refused by the
 * same burst (a reconnect re-subscribing a busy page) do not all retry in the
 * same instant and drain the bucket again.
 */
import { SOCKET_JOIN_RATE_LIMITED_CODE, type SocketAuthErrorEvent } from "@metis/shared";

/** Used when a rate-limited refusal names no usable `retryAfterMs`. */
export const DEFAULT_RATE_LIMIT_RETRY_MS = 1_000;
/** The longest a follower waits, whatever the refusal says. */
export const MAX_RATE_LIMIT_RETRY_MS = 60_000;
/** Up to this much random delay is added to each retry. */
export const RATE_LIMIT_RETRY_JITTER_MS = 250;

/**
 * The delay before re-subscribing after `data`, or `undefined` when `data` is
 * not a rate-limit refusal (an authorization denial, or no refusal at all).
 */
export function rateLimitRetryDelay(
  data: SocketAuthErrorEvent | undefined,
  random: () => number = Math.random,
): number | undefined {
  if (data?.code !== SOCKET_JOIN_RATE_LIMITED_CODE) return undefined;
  const named = data.retryAfterMs;
  const base =
    typeof named === "number" && Number.isFinite(named) && named >= 0
      ? Math.min(named, MAX_RATE_LIMIT_RETRY_MS)
      : DEFAULT_RATE_LIMIT_RETRY_MS;
  return base + Math.floor(random() * RATE_LIMIT_RETRY_JITTER_MS);
}
