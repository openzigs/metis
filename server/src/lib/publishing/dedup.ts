/**
 * Idempotency helpers — Phase 9 (#68).
 *
 * `dedupHash` is sha256(targetOwner + "/" + targetRepo + ":" + normalizedTitle).
 * The hash is stamped on the IssueDraft AND embedded in a marker comment in
 * the published issue body so the linkage can be recovered if the local
 * PublishedIssue row is lost.
 *
 * The marker is a single HTML comment line of the form:
 *
 *   <!-- metis-publish: batch=<batchId> draft=<draftId> hash=<dedupHash> -->
 *
 * Re-publishing with the same dedup hash returns the existing issue number
 * instead of creating a new one (idempotent batch).
 */
import crypto from "node:crypto";
import { PUBLISH_MARKER_PREFIX } from "@metis/shared";

/**
 * Marker recogniser. Always rebuild a fresh RegExp at use sites — never
 * reuse this instance with the global flag (state leaks between exec()
 * calls). For global stripping see `MARKER_RE_GLOBAL` below.
 */
const MARKER_RE = new RegExp(
  `${escapeRe(PUBLISH_MARKER_PREFIX)}\\s*batch=([^\\s]+)\\s+draft=([^\\s]+)\\s+hash=([^\\s]+)\\s*-->`,
  "i",
);

function makeStripRe(): RegExp {
  return new RegExp(
    `\\n*${escapeRe(PUBLISH_MARKER_PREFIX)}\\s*batch=[^\\s]+\\s+draft=[^\\s]+\\s+hash=[^\\s]+\\s*-->\\n*`,
    "gi",
  );
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, " ").toLowerCase();
}

export function computeDedupHash(targetOwner: string, targetRepo: string, title: string): string {
  const owner = targetOwner.trim().toLowerCase();
  const repo = targetRepo.trim().toLowerCase();
  const norm = normalizeTitle(title);
  return crypto.createHash("sha256").update(`${owner}/${repo}:${norm}`).digest("hex");
}

export function computeBodyHash(body: string): string {
  return crypto.createHash("sha256").update(body).digest("hex");
}

export interface PublishMarker {
  batchId: string;
  draftId: string;
  hash: string;
}

export function buildMarkerComment(marker: PublishMarker): string {
  return `${PUBLISH_MARKER_PREFIX} batch=${marker.batchId} draft=${marker.draftId} hash=${marker.hash} -->`;
}

export function injectMarker(body: string, marker: PublishMarker): string {
  // Replace existing marker comment if one is already present so re-publishes
  // do not accumulate stale lines.
  const stripped = stripMarker(body);
  const trimmed = stripped.replace(/\s+$/u, "");
  return `${trimmed}\n\n${buildMarkerComment(marker)}\n`;
}

/**
 * Strip ALL marker comments — global so an attacker-supplied requirement
 * body containing a fake marker cannot survive into the published issue
 * body and later be re-parsed as authoritative.
 */
export function stripMarker(body: string): string {
  return body.replace(makeStripRe(), "\n");
}

export function parseMarker(body: string | null | undefined): PublishMarker | null {
  if (!body) return null;
  const m = MARKER_RE.exec(body);
  if (!m) return null;
  return { batchId: m[1], draftId: m[2], hash: m[3] };
}
