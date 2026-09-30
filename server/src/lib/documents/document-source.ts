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
