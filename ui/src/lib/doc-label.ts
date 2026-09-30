/**
 * Human-readable labels for Workbench / context document entries.
 *
 * A project's "documents" list mixes three very different filename shapes:
 *   - real uploads ............. "D100 - UC101 Regional Hubs…v0.8.docx"
 *   - generated docs ........... "generated-doc-cmqpizckr017z8ewh2unm1418.md"
 *   - connector/repo symbols ... "connector:repo:<connectorId>:<path/to/File.java>"
 *
 * Rendered verbatim, the connector entries are long, near-identical prefixes
 * that drown the part a human actually scans for (the file basename). This
 * helper splits each into a scannable `primary` label plus optional `secondary`
 * context (e.g. the directory), so the UI can show the basename prominently and
 * keep the full original string in a hover `title`.
 */

import type { DocumentSource } from "@/lib/projects-api";

export type DocLabelKind = "repo" | "generated" | "file";

export interface DocLabel {
  /** Primary, scannable label — e.g. a file basename. */
  primary: string;
  /** Optional secondary context — e.g. the directory path or an id fragment. */
  secondary?: string;
  /** Classification of the underlying entry, for icons/badges. */
  kind: DocLabelKind;
}

/** `connector:repo:<connectorId>:<path>` — capture the path after the id. */
const CONNECTOR_REPO_RE = /^connector:repo:[^:]+:(.+)$/;
/** `generated-doc-<cuid>[.ext]` — a generated document with no human title. */
const GENERATED_DOC_RE = /^generated-doc-([a-z0-9]+)(?:\.[a-z0-9]+)?$/i;

/**
 * Turn a raw document `filename` into a `{ primary, secondary?, kind }` label.
 * Pure and side-effect-free so it is trivially unit-testable and reusable
 * across the doc list and the context chips.
 *
 * #547 — `source` is the row's `documents.source`. A filename pattern is read
 * only for the source that writes it, so an upload stored before #540 under a
 * name like `connector:repo:…` or `generated-doc-…` is labelled as the file it is.
 */
export function formatDocLabel(filename: string, source: DocumentSource): DocLabel {
  const name = (filename ?? "").trim();
  if (!name) return { primary: "Untitled", kind: "file" };

  const repo = source === "repo" ? name.match(CONNECTOR_REPO_RE) : null;
  if (repo) {
    const path = repo[1].trim();
    const parts = path.split("/").filter(Boolean);
    const base = parts.length ? parts[parts.length - 1] : path;
    const dir = parts.slice(0, -1).join("/");
    return { primary: base, ...(dir ? { secondary: dir } : {}), kind: "repo" };
  }

  const generated = source === "generated" ? name.match(GENERATED_DOC_RE) : null;
  if (generated) {
    // The id carries no meaning to a human; surface a short tail to keep
    // multiple generated docs distinguishable in the list.
    const frag = generated[1].slice(-6);
    return {
      primary: "Generated document",
      ...(frag ? { secondary: `#${frag}` } : {}),
      kind: "generated",
    };
  }

  return { primary: name, kind: "file" };
}
