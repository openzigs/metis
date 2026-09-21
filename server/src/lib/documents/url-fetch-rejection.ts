/**
 * Issue #1084 — collapse network-determined URL-ingest rejections at the API
 * boundary.
 *
 * `fetchUrlForIngest` throws a richly detailed `UrlFetchError`: the resolved
 * address, the non-routable range it fell in, the DNS error string. That
 * detail is exactly what an operator needs to debug a block — and exactly what
 * an attacker wants. Because the URL is entirely caller-supplied, forwarding
 * the rejection verbatim turns the error channel into an internal-network
 * oracle: submit a hostname, read back its resolved address and range.
 *
 * PR #1082 established that even the status/code pair leaks (`403
 * HOST_NOT_ALLOWED` vs `502 DNS_LOOKUP_FAILED` distinguishes "blocked" from
 * "does not resolve"), so both are collapsed here alongside the message. A
 * failed SSRF attempt is then indistinguishable from an unreachable host.
 *
 * The information is withheld, not destroyed: the full reason is written to
 * the structured log before the generic error is returned. Same shape as
 * `collapseAllowListRejection` in `routes/jira.ts` (#1054 / #1065).
 */
import { AppError } from "../../middleware/error-handler.js";
import { createChildLogger } from "../logger.js";
import type { UrlFetchError } from "./url-fetcher.js";

const log = createChildLogger("url-ingest-rejection");

/**
 * Rejections whose outcome is decided by the *target's network state* — DNS
 * resolution, the resolved address's range, or the hostname allow-list. Each
 * one answers a question the caller must not be able to ask.
 *
 * Deliberately excluded: content-level outcomes (size, MIME, upstream status,
 * timeout) and purely syntactic ones (bad scheme, credentials in the URL).
 * Those are decided either before DNS or only after the host has already
 * passed every SSRF check, so they carry no information about an internal
 * network — and collapsing them would strip genuinely useful feedback from
 * legitimate ingest failures.
 */
const NETWORK_DETERMINED_CODES: ReadonlySet<string> = new Set([
  "PRIVATE_HOST_BLOCKED",
  "HOST_NOT_ALLOWED",
  "DNS_FAILURE",
  "FETCH_FAILED",
]);

/** The single caller-visible answer for every network-determined rejection. */
export const URL_REJECTED_STATUS = 400;
export const URL_REJECTED_CODE = "URL_NOT_ALLOWED";
export const URL_REJECTED_MESSAGE = "The requested URL could not be retrieved";

export interface UrlRejectionContext {
  /** The caller-supplied URL, logged server-side for triage. */
  url: string;
  projectId?: string;
}

/**
 * Map a `UrlFetchError` to the `AppError` the caller may see.
 *
 * Network-determined rejections collapse to one identical envelope; everything
 * else is forwarded unchanged.
 */
export function collapseUrlFetchRejection(
  err: UrlFetchError,
  context: UrlRejectionContext,
): AppError {
  if (!NETWORK_DETERMINED_CODES.has(err.code)) {
    return new AppError(err.status, err.code, err.message);
  }
  log.warn("URL ingest rejected — network-determined, collapsed for the caller", {
    code: err.code,
    status: err.status,
    reason: err.message,
    url: context.url,
    projectId: context.projectId,
  });
  return new AppError(URL_REJECTED_STATUS, URL_REJECTED_CODE, URL_REJECTED_MESSAGE);
}
