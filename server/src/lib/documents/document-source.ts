/**
 * Issue #474 — which path wrote a `Document` row. Stored in `documents.source`
 * by the writer, so a reader classifies on it instead of parsing the filename
 * (an upload may legitimately be named `jira:ABC-1`).
 *
 * - `upload`     file, URL and text ingest (`routes/documents.ts`; the column default)
 * - `generated`  a published generated document (`docs-gen/generated-doc-publication.ts`)
 * - `repo`, `db` the repository and database connectors (`connectors/connector-ingest.ts`)
 * - `confluence`, `jira` the Atlassian connector (`connectors/atlassian.ts`)
 */
import { type DocumentSource, documentSourceSchema } from "@metis/shared";

// #547 — the closed set is defined once, in `@metis/shared`.
export type { DocumentSource };

/**
 * #547 — narrow a stored `documents.source` (a plain string column) to the
 * closed set. An unrecognised value reads as `upload`, which no reader treats
 * as a connector, so a bad row can never be promoted to repository code.
 */
export function asDocumentSource(value: string): DocumentSource {
  const parsed = documentSourceSchema.safeParse(value);
  return parsed.success ? parsed.data : "upload";
}

/**
 * Issue #525 — the repository and database connectors' sources: the rows an
 * analysis's default document set leaves out (formerly every `connector:`
 * filename, which an upload could also carry).
 */
export const CONNECTOR_CODE_SOURCES: readonly DocumentSource[] = ["repo", "db"];
