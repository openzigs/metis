/**
 * Issue #363 — the one display helper for a document's name in a list.
 *
 * A repository-sourced document's `filename` is its internal key,
 * `connector:repo:<connectorId>:<path>`. Lists (`/documents`, a project's
 * Documents tab, the Workbench panel and the Analysis document picker) show it
 * as the file path plus the repository's label instead; the key itself is kept
 * only as `rawId`, for a hover tooltip.
 *
 * Parsing and repo-name resolution are delegated to `formatSourceLabel`, so a
 * list and a citation can never disagree about which repository a file is in.
 * Anything that is not a repository file falls through to `formatDocLabel`
 * (plain uploads keep their name; generated docs get a readable label).
 */
import { formatDocLabel, type DocLabelKind } from "@/lib/doc-label";
import { formatSourceLabel } from "@/lib/format-source-label";
import type { DocumentSource } from "@/lib/projects-api";

export interface DocumentName {
  /** The file path for a repository file; otherwise the scannable label. */
  primary: string;
  /** The repository's label for a repository file; otherwise optional context. */
  secondary?: string;
  /** The original filename / internal key — for a tooltip, never the label. */
  rawId: string;
  kind: DocLabelKind;
}

/**
 * #1749 — a repository ingest stores two kinds of document: each source file,
 * keyed with the ingester's `src/` marker, and the repository's summary (its
 * overview, README and manifests such as `package.json`), keyed without one.
 * A manifest is therefore listed twice under one path; its summary copy says so.
 */
const REPO_SOURCE_FILE_RE = /^connector:repo:[^:]+:src\//;

/** #1749 — what the secondary line adds for a repository-summary document. */
export const REPO_SUMMARY_NOTE = "repository summary";

/**
 * #547 — `source` is the row's `documents.source`: only a `repo` row is read as
 * a repository file, so an upload named `connector:repo:…` keeps its name.
 */
export function formatDocumentName(
  filename: string,
  source: DocumentSource,
  repoNames?: Readonly<Record<string, string>>,
): DocumentName {
  const parsed = formatSourceLabel(filename, repoNames);
  if (source === "repo" && parsed.isConnector && parsed.path) {
    const summary = !REPO_SOURCE_FILE_RE.test(parsed.rawId);
    const secondary = [parsed.repoLabel, summary ? REPO_SUMMARY_NOTE : undefined]
      .filter(Boolean)
      .join(" · ");
    return {
      primary: parsed.path,
      ...(secondary ? { secondary } : {}),
      rawId: parsed.rawId,
      kind: "repo",
    };
  }
  const label = formatDocLabel(filename, source);
  return { ...label, rawId: parsed.rawId };
}
