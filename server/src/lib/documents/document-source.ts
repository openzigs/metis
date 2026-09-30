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
export type DocumentSource = "upload" | "generated" | "repo" | "db" | "confluence" | "jira";

/**
 * Issue #525 — the repository and database connectors' sources: the rows an
 * analysis's default document set leaves out (formerly every `connector:`
 * filename, which an upload could also carry).
 */
export const CONNECTOR_CODE_SOURCES: readonly DocumentSource[] = ["repo", "db"];
