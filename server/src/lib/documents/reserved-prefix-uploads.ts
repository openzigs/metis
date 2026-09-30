/**
 * Issue #547 — find uploads stored before #540 under a reserved filename
 * prefix (`jira:ABC-1`, `connector:repo:…`, `generated-doc-…`), read-only.
 *
 * Since #540 the upload routes refuse such a name, and every reader that holds
 * the document row or a search hit classifies on `documents.source`. What is
 * left is a reader that sees only a name — a stored citation's label — which
 * still reads the prefix. This report names those rows so an operator can
 * re-upload each under a new name. It changes nothing: a rename would also have
 * to rewrite the vector store's copy of the filename, which only re-ingest does.
 *
 * Rows are matched with the upload route's own {@link reservedFilenamePrefix},
 * so the report and the guard can never disagree about what is reserved. That
 * check is case-insensitive for `generated-doc-`, which SQL cannot express the
 * same way on both SQLite and Postgres, so live uploads are paged by id and
 * filtered here.
 */
import type { PrismaClient } from "@prisma/client";
import { reservedFilenamePrefix } from "./upload.js";

export type ReservedPrefixUploadsPrisma = Pick<PrismaClient, "document">;

export interface ReservedPrefixUpload {
  documentId: string;
  projectId: string;
  /** The document's project is archived (soft-deleted). */
  projectArchived: boolean;
  filename: string;
  reservedPrefix: string;
}

const DEFAULT_PAGE_SIZE = 1000;

export async function findReservedPrefixUploads(
  db: ReservedPrefixUploadsPrisma,
  opts: { pageSize?: number } = {},
): Promise<ReservedPrefixUpload[]> {
  const take = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const found: ReservedPrefixUpload[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await db.document.findMany({
      where: { source: "upload", deletedAt: null },
      select: {
        id: true,
        projectId: true,
        filename: true,
        project: { select: { deletedAt: true } },
      },
      orderBy: { id: "asc" },
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    for (const row of page) {
      const reservedPrefix = reservedFilenamePrefix(row.filename);
      if (!reservedPrefix) continue;
      found.push({
        documentId: row.id,
        projectId: row.projectId,
        projectArchived: row.project.deletedAt !== null,
        filename: row.filename,
        reservedPrefix,
      });
    }
    if (page.length < take) return found;
    cursor = page[page.length - 1]!.id;
  }
}

/**
 * Filenames are user input bound for an operator's terminal. Replace each C0/C1
 * control character, ESC, CR and LF included, so a name can neither inject an
 * escape sequence nor add a line; and each Unicode bidi control (U+061C,
 * U+200E/F, U+202A-E, U+2066-9) and zero-width character (U+200B-D, U+2060,
 * U+FEFF), so a name cannot visually reorder or hide part of the line.
 */
const CONTROL =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g;
const t = (value: string): string => value.replace(CONTROL, "?");

export function formatReservedPrefixUploads(rows: ReservedPrefixUpload[]): string {
  const header = `${rows.length} upload(s) carry a reserved filename prefix`;
  if (rows.length === 0) return `${header}.`;
  const lines = [`${header} (stored before #540 refused them):`];
  for (const r of rows) {
    const project = `project ${t(r.projectId)}${r.projectArchived ? " (archived)" : ""}`;
    lines.push(`  ${project}: ${t(r.documentId)} [${r.reservedPrefix}] ${t(r.filename)}`);
  }
  lines.push(
    "Searches and document lists classify these by their stored source; a citation that shows only the name may still label one by its prefix. Re-upload each under a new name and delete the old one to remove the ambiguity.",
  );
  return lines.join("\n");
}
