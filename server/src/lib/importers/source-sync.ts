/**
 * Issue #1220 — the three-way decision an import re-sync makes per imported
 * requirement: did the SOURCE change since the last sync, and was the LOCAL
 * copy edited since then?
 *
 * Re-sync used to be "source wins": any imported row whose text differed from
 * the source was rewritten, so an analyst's edit was silently put back on the
 * next sync even when the source issue had not changed at all.
 *
 * Each imported row now stores a fingerprint of the source content it was last
 * synced to (`Requirement.sourceFingerprint`). With it:
 *
 * | source changed | local edited | outcome                                     |
 * |----------------|--------------|---------------------------------------------|
 * | no             | no           | `unchanged` — nothing written               |
 * | no             | yes          | `kept_local` — the analyst's edit stays     |
 * | yes            | no           | `apply_source` — the source is applied      |
 * | yes            | yes          | `diverged` — kept, and the source recorded  |
 *
 * A row that predates the fingerprint (`null`) cannot tell the two apart: if
 * the local copy equals the source the fingerprint is recorded and nothing
 * else happens; otherwise it is `diverged` ("local edited, source unknown").
 * It is never silently overwritten.
 *
 * Pure: no database. The writes the outcome implies are returned for the
 * caller's store to perform.
 */
import { createHash } from "node:crypto";
import type { RequirementSourceDecision, RequirementSourceDivergence } from "@metis/shared";
import { isHiddenRequirementLabel } from "../analysis/requirement-labels.js";

/** The content of a requirement that a source system owns. */
export interface SourceContent {
  title: string;
  body: string;
  type: string;
  priority: string;
  labels: string[];
}

/** The source's newer content, held while a row is diverged from it. */
export interface SourcePending extends SourceContent {
  /** {@link sourceFingerprint} of this content. */
  fingerprint: string;
  /** ISO time the re-sync first saw this source content. */
  detectedAt: string;
}

/** The analyst's last answer to a divergence, shown in the requirement's History. */
export interface SourceDecision {
  choice: "source" | "local";
  /** The source content the choice was made against. */
  fingerprint: string;
  actorId: string | null;
  at: string;
}

export type ResyncOutcome = "unchanged" | "kept_local" | "apply_source" | "diverged";

/**
 * The sync-state columns to write. A key that is absent is left alone;
 * `sourcePending: null` clears a divergence.
 */
export interface SourceSyncWrite {
  sourceFingerprint?: string;
  sourcePending?: SourcePending | null;
}

export interface ResyncDecision {
  outcome: ResyncOutcome;
  /** Fingerprint of the incoming source content. */
  fingerprint: string;
  /**
   * Sync-state write for every outcome except `apply_source` (whose content
   * write records the fingerprint and clears the divergence itself). `null`
   * when nothing needs writing.
   */
  write: SourceSyncWrite | null;
}

const FINGERPRINT_VERSION = "v1";

/**
 * Labels as compared: hidden traceability labels (`finding:*`, `review:*`) are
 * METIS's own, never the source's, and order is not content.
 */
function comparableLabels(labels: ReadonlyArray<string>): string[] {
  return [...new Set(labels.filter((l) => !isHiddenRequirementLabel(l)))].sort();
}

/** A stable fingerprint of title, body, type, priority and labels. */
export function sourceFingerprint(content: SourceContent): string {
  const canonical = JSON.stringify([
    FINGERPRINT_VERSION,
    content.title,
    content.body,
    content.type,
    content.priority,
    comparableLabels(content.labels),
  ]);
  return `${FINGERPRINT_VERSION}:${createHash("sha256").update(canonical).digest("hex")}`;
}

/**
 * Decide what a re-sync does with one existing imported requirement.
 *
 * @param local          the row's current content
 * @param stored         its stored fingerprint (`null`: synced before #1220)
 * @param pending        the divergence it is already flagged with, if any
 * @param source         the content the source system has now
 * @param now            the time to stamp a new divergence with
 */
export function decideResync(params: {
  local: SourceContent;
  stored: string | null;
  pending: SourcePending | null;
  source: SourceContent;
  now: Date;
}): ResyncDecision {
  const { stored, pending, source, now } = params;
  const fingerprint = sourceFingerprint(source);
  const localFingerprint = sourceFingerprint(params.local);

  const clearPending = (): SourceSyncWrite | null => (pending ? { sourcePending: null } : null);
  const diverged = (): ResyncDecision => ({
    outcome: "diverged",
    fingerprint,
    // Already flagged with this very source content: nothing to write, and the
    // first `detectedAt` stands.
    write:
      pending?.fingerprint === fingerprint
        ? null
        : { sourcePending: { ...source, fingerprint, detectedAt: now.toISOString() } },
  });

  // The local copy already says what the source says — whatever happened on
  // either side, they agree now. Record the fingerprint so the next sync can
  // tell the two sides apart.
  if (localFingerprint === fingerprint) {
    return {
      outcome: "unchanged",
      fingerprint,
      write:
        stored === fingerprint && !pending
          ? null
          : { sourceFingerprint: fingerprint, sourcePending: null },
    };
  }

  // Synced before #1220 and different now: the edit may be the analyst's or the
  // source's; there is no way to know, so keep the local copy and flag it.
  if (stored === null) return diverged();

  const sourceChanged = fingerprint !== stored;
  const localEdited = localFingerprint !== stored;

  if (!sourceChanged) {
    // The source is back at (or still at) what was last synced, so any earlier
    // divergence no longer stands.
    return {
      outcome: localEdited ? "kept_local" : "unchanged",
      fingerprint,
      write: clearPending(),
    };
  }
  if (!localEdited) return { outcome: "apply_source", fingerprint, write: null };
  return diverged();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/** Parse the stored `sourcePending` column; malformed reads as not diverged. */
export function parseSourcePending(raw: string | null | undefined): SourcePending | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (
      isRecord(v) &&
      typeof v.fingerprint === "string" &&
      typeof v.title === "string" &&
      typeof v.body === "string" &&
      typeof v.type === "string" &&
      typeof v.priority === "string" &&
      isStringArray(v.labels) &&
      typeof v.detectedAt === "string"
    ) {
      return {
        fingerprint: v.fingerprint,
        title: v.title,
        body: v.body,
        type: v.type,
        priority: v.priority,
        labels: v.labels,
        detectedAt: v.detectedAt,
      };
    }
  } catch {
    // fall through
  }
  return null;
}

/** Parse the stored `sourceDecision` column; malformed reads as none. */
export function parseSourceDecision(raw: string | null | undefined): SourceDecision | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (
      isRecord(v) &&
      (v.choice === "source" || v.choice === "local") &&
      typeof v.fingerprint === "string" &&
      (v.actorId === null || typeof v.actorId === "string") &&
      typeof v.at === "string"
    ) {
      return { choice: v.choice, fingerprint: v.fingerprint, actorId: v.actorId, at: v.at };
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * The snapshot's view of a diverged row (`RequirementSourceDivergence`): the
 * source's newer content and its fingerprint. `null` when not diverged.
 */
export function toSourceDivergence(
  raw: string | null | undefined,
): RequirementSourceDivergence | null {
  const pending = parseSourcePending(raw);
  if (!pending) return null;
  const { fingerprint, detectedAt, ...source } = pending;
  return { sourceFingerprint: fingerprint, detectedAt, source };
}

/** History's view of the last answer (`RequirementSourceDecision`); `null` when none. */
export function toSourceDecision(raw: string | null | undefined): RequirementSourceDecision | null {
  const decision = parseSourceDecision(raw);
  if (!decision) return null;
  return { choice: decision.choice, actorId: decision.actorId, at: decision.at };
}
