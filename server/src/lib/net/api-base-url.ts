/**
 * Issue #438 — shared allowlist guard for outbound `apiBaseUrl` values.
 *
 * Originally lived in `lib/spec-kit/installer/hosts.ts` (Epic #396 MVP-7).
 * Extracted so non-installer callers (MCP dispatcher, future webhook senders)
 * can reuse the same allowlist without reaching across a feature boundary.
 *
 * Issue #1303 — moved here from `lib/security/`, of which it was the sole
 * occupant. A directory named `security/` holding one URL helper reads as THE
 * security module to a newcomer, while the load-bearing security code lives in
 * `auth`, `safety`, `vault`, `audit` and this directory. `net/` is where it
 * belongs on the merits too: like `safe-fetch.ts` beside it, this is a guard on
 * an outbound URL.
 *
 * Allowed origins: `METIS_PUBLIC_URL` (single canonical URL), plus any
 * comma-separated entry in `SPECKIT_INSTALL_ALLOWED_API_HOSTS`. Both are
 * compared by URL origin (scheme + host + port) so trailing-slash and
 * path differences do not cause false rejections.
 */
import { SpecKitArtifactError } from "../spec-kit/artifacts.js";

export function assertApiBaseUrlAllowed(apiBaseUrl: string): void {
  let candidate: URL;
  try {
    candidate = new URL(apiBaseUrl);
  } catch {
    throw new SpecKitArtifactError(
      422,
      "apiBaseUrl_not_allowed",
      `apiBaseUrl is not a valid URL: ${apiBaseUrl}`,
    );
  }
  const allowed: string[] = [];
  const publicUrl = process.env.METIS_PUBLIC_URL?.trim();
  if (publicUrl) allowed.push(publicUrl);
  const csv = process.env.SPECKIT_INSTALL_ALLOWED_API_HOSTS?.trim();
  if (csv) {
    for (const entry of csv.split(",")) {
      const v = entry.trim();
      if (v) allowed.push(v);
    }
  }
  for (const a of allowed) {
    try {
      const u = new URL(a);
      if (u.origin === candidate.origin) return;
    } catch {
      // Skip malformed allowlist entries.
    }
  }
  throw new SpecKitArtifactError(
    422,
    "apiBaseUrl_not_allowed",
    `apiBaseUrl ${candidate.origin} is not on the SPECKIT_INSTALL_ALLOWED_API_HOSTS allowlist (or METIS_PUBLIC_URL).`,
  );
}
