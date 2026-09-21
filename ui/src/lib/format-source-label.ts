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
 * Repo label resolution: a connector's human repo name is NOT cheaply available
 * client-side (a `DocumentRow` only carries `filename`, which *is* the raw id
 * for connector docs; resolving the connector's name would cost an API call per
 * unique connector). So the friendly label falls back to a short form of the
 * `connectorId` as the repo token — distinct enough to disambiguate the same
 * filename across repos — and the full id stays in the tooltip. See the
 * `repoLabel` derivation below.
 *
 * The helper is pure and side-effect-free so it is trivially unit-testable and
 * reusable across every render site. Anything that is NOT in the
 * `connector:repo:` shape (legacy ids, plain filenames, empty/malformed input)
 * degrades gracefully: the raw value is returned unchanged as the label, so no
 * call site can crash on an id it did not expect.
 */

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
  /** The path portion after the connectorId for connector ids; `undefined`
   *  otherwise. */
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
 * `"<basename> — <repoLabel>"`; for anything else the raw id is returned
 * unchanged (graceful degradation — never throws).
 */
export function formatSourceLabel(rawId: string): SourceLabel {
  const raw = (rawId ?? "").trim();

  // Graceful degradation: empty / non-connector / malformed ids fall back to
  // the raw value so the call site renders *something* and never crashes.
  if (!raw) {
    return { label: "", rawId: "", basename: "", isConnector: false };
  }

  // Issue #732 — live-schema citations get a friendly label, raw id in tooltip.
  if (raw.startsWith(LIVE_SCHEMA_PREFIX)) {
    return { label: "Live schema", rawId: raw, basename: "Live schema", isConnector: false };
  }

  const match = raw.match(CONNECTOR_REPO_RE);
  if (!match) {
    return { label: raw, rawId: raw, basename: raw, isConnector: false };
  }

  const connectorId = match[1];
  const path = match[2].trim();
  const segments = path.split("/").filter(Boolean);
  const basename = segments.length ? segments[segments.length - 1] : "";
  const repoLabel = repoTokenFromConnectorId(connectorId);

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
