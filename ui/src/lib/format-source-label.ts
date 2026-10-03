/**
 * Issue #427 (epic #407) — human-readable labels for connector document/source ids.
 *
 * BA/PM-facing surfaces (the Analysis doc picker, the Documents list, and
 * citations) reference documents by a raw connector id of the shape:
 *
 *   connector:repo:<connectorId>:<path/to/File.java>
 *
 * Rendered verbatim those ids are unreadable — a long, near-identical prefix
 * drowns the part a human actually scans for (the file basename). This helper
 * parses such an id into a scannable `basename — repo` label while preserving
 * the full raw id (returned as `rawId`) so it can still be shown in a hover
 * `title`/tooltip and used for any copy / deep-link affordance.
 *
 * Repo label resolution: a `DocumentRow` only carries `filename`, which *is*
 * the raw id for connector docs. Callers that know the project's connectors
 * pass a `repoNames` map (see `useRepoNames`, #23) and the label shows the
 * repository's name. Without one — or for a connector no longer in the map —
 * it falls back to a short form of the `connectorId`, distinct enough to
 * disambiguate the same filename across repos; the full id stays in the tooltip.
 *
 * #573 — `source` is the cited row's `documents.source` when the caller knows
 * it. Only a `repo` row is parsed as a repository file, so a legacy upload
 * stored as `connector:repo:…` (before the #540 upload guard) keeps its name.
 * When the source is unknown — a citation whose document no longer resolves, or
 * dialog state written before #573 — the name is the only evidence left and is
 * parsed as before.
 *
 * The helper is pure and side-effect-free so it is trivially unit-testable and
 * reusable across every render site. Anything that is NOT in the
 * `connector:repo:` shape (legacy ids, plain filenames, empty/malformed input)
 * degrades gracefully: the raw value is returned unchanged as the label, so no
 * call site can crash on an id it did not expect.
 */

import { repoDocumentPath } from "@metis/shared";
import type { DocumentSource } from "@/lib/projects-api";

export interface SourceLabel {
  /** Human-readable display label — `"<basename> — <repoLabel>"` for connector
   *  ids, otherwise the raw id unchanged. */
  label: string;
  /** The full, original id — preserve in a `title`/tooltip and for copy /
   *  deep-link. Always the input value (trimmed), never lossy. */
  rawId: string;
  /** The file basename (last path segment) for connector ids; the raw id
   *  otherwise. Never empty for non-empty input. */
  basename: string;
  /** Short, human-facing repo token for connector ids; `undefined` otherwise. */
  repoLabel?: string;
  /** The repository-relative path for connector ids (#717: without the
   *  ingester's `src/` marker); `undefined` otherwise. */
  path?: string;
  /** True when the id matched the `connector:repo:` shape. */
  isConnector: boolean;
}

/** `connector:repo:<connectorId>:<path>` — capture the connectorId and path. */
const CONNECTOR_REPO_RE = /^connector:repo:([^:]+):(.+)$/;

/**
 * Issue #732 — the analysis DATABASE agent (Sally) can cite an introspected live
 * schema, whose synthetic documentId is `live-schema:<projectId>`. That id is not
 * backed by a `Document` row, so rendered verbatim it would show a raw, id-shaped
 * string (never a working link). Collapse any such id to a friendly "Live schema"
 * label while keeping the raw id in the tooltip.
 */
const LIVE_SCHEMA_PREFIX = "live-schema:";

/** Number of trailing connectorId chars used as the human repo token. */
const REPO_TOKEN_LEN = 6;

/**
 * Derive a short, stable, human-facing repo token from a connectorId. Mirrors
 * the `generated-doc-<cuid>` convention of surfacing a short tail so distinct
 * connectors stay distinguishable without leaking the full noisy id. The full
 * id remains available via {@link SourceLabel.rawId} for the tooltip.
 */
function repoTokenFromConnectorId(connectorId: string): string {
  const id = connectorId.trim();
  return id.length > REPO_TOKEN_LEN ? id.slice(-REPO_TOKEN_LEN) : id;
}

/**
 * Turn a raw document/source id into a `{ label, rawId, basename, ... }`
 * descriptor. For `connector:repo:<connectorId>:<path>` ids the `label` is
 * `"<basename> — <repoLabel>"`, where `repoLabel` is the repository name from
 * `repoNames` when known; for anything else the raw id is returned
 * unchanged (graceful degradation — never throws).
 */
export function formatSourceLabel(
  rawId: string,
  repoNames?: Readonly<Record<string, string>>,
  source?: DocumentSource,
): SourceLabel {
  const raw = (rawId ?? "").trim();

  // Graceful degradation: empty / non-connector / malformed ids fall back to
  // the raw value so the call site renders *something* and never crashes.
  if (!raw) {
    return { label: "", rawId: "", basename: "", isConnector: false };
  }

  // Issue #732 — live-schema citations get a friendly label, raw id in tooltip.
  // #573 — the genuine one is a synthetic id with no Document row, so it never
  // carries a source; a stored row named `live-schema:` (a legacy upload) is not it.
  if (raw.startsWith(LIVE_SCHEMA_PREFIX) && source === undefined) {
    return { label: "Live schema", rawId: raw, basename: "Live schema", isConnector: false };
  }

  const match = source === undefined || source === "repo" ? raw.match(CONNECTOR_REPO_RE) : null;
  if (!match) {
    return { label: raw, rawId: raw, basename: raw, isConnector: false };
  }

  const connectorId = match[1];
  // #717 — the repository-relative path: a source file's key carries the
  // ingester's `src/` marker, which is not a directory in the repository.
  const path = repoDocumentPath(raw) ?? "";
  const segments = path.split("/").filter(Boolean);
  const basename = segments.length ? segments[segments.length - 1] : "";
  // #23 — own-property lookup only, so an id like "constructor" can never
  // resolve to something inherited from Object.prototype.
  const resolved =
    repoNames && Object.prototype.hasOwnProperty.call(repoNames, connectorId)
      ? repoNames[connectorId]?.trim()
      : undefined;
  const repoLabel = resolved || repoTokenFromConnectorId(connectorId);

  // A path could be degenerate (e.g. only slashes / whitespace) and yield no
  // real file segment. Rather than emit a misleading empty or slash-only label,
  // degrade gracefully and return the raw id unchanged.
  if (!basename) {
    return { label: raw, rawId: raw, basename: raw, isConnector: false };
  }

  return {
    label: repoLabel ? `${basename} — ${repoLabel}` : basename,
    rawId: raw,
    basename,
    repoLabel: repoLabel || undefined,
    path,
    isConnector: true,
  };
}
