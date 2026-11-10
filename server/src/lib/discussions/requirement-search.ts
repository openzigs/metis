/**
 * #2187 — the requirement picker's search: a project's live requirements whose
 * title contains a term, newest first.
 *
 * #2209 — the match runs in SQL. #2203 read the project's requirements in
 * 500-row OFFSET pages and filtered each page in JS until 20 matched, so a rare
 * term read every requirement on every keystroke (about N²/500 rows) and a run
 * inserting requirements mid-scan could repeat or skip rows. Now one query asks
 * for at most {@link REQUIREMENT_PICKER_LIMIT} matching ids, walking the
 * (`projectId`, `createdAt`, `id`) index newest first, and a second reads those
 * rows through Prisma.
 *
 * Case-insensitive on both backends: Prisma's `contains` is case-sensitive on
 * Postgres, and its `mode: "insensitive"` exists only in the Postgres-generated
 * client, so both sides are folded with `LOWER()` in a tagged `$queryRaw`, as
 * `cross-project-guard.ts` does (#1180). Every value is a bound parameter, and
 * the term's own `%`, `_` and `!` are escaped so they match literally. `LOWER`
 * folds ASCII only on SQLite; Postgres folds by its collation.
 */
import { prisma } from "../prisma.js";

/** The picker answers at most this many requirements. */
export const REQUIREMENT_PICKER_LIMIT = 20;

/** The `LIKE … ESCAPE` character: not a backslash, which the backends quote differently. */
const LIKE_ESCAPE = "!";

export interface RequirementPick {
  id: string;
  title: string;
  analysisId: string;
  createdAt: Date;
}

/** `term` with its LIKE wildcards (and the escape character) matched literally. */
export function escapeLike(term: string): string {
  return term.replace(/[!%_]/g, (c) => `${LIKE_ESCAPE}${c}`);
}

/**
 * The project's live requirements (not soft-deleted, nor in a soft-deleted
 * analysis) whose title contains `term` case-insensitively, newest first, at
 * most {@link REQUIREMENT_PICKER_LIMIT}. A blank term lists the newest.
 */
export async function searchProjectRequirements(
  projectId: string,
  term: string,
): Promise<RequirementPick[]> {
  const live = { projectId, deletedAt: null, analysis: { deletedAt: null } };
  // The id tie-break keeps the order stable when createdAt repeats.
  const orderBy = [{ createdAt: "desc" as const }, { id: "desc" as const }];
  const select = { id: true, title: true, analysisId: true, createdAt: true };

  const needle = term.trim();
  if (!needle) {
    return prisma.requirement.findMany({
      where: live,
      orderBy,
      take: REQUIREMENT_PICKER_LIMIT,
      select,
    });
  }

  const pattern = `%${escapeLike(needle)}%`;
  const hits = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT r."id" FROM "requirements" r
    JOIN "analyses" a ON a."id" = r."analysisId"
    WHERE r."projectId" = ${projectId}
      AND r."deletedAt" IS NULL
      AND a."deletedAt" IS NULL
      AND LOWER(r."title") LIKE LOWER(${pattern}) ESCAPE '!'
    ORDER BY r."createdAt" DESC, r."id" DESC
    LIMIT ${REQUIREMENT_PICKER_LIMIT}`;
  if (hits.length === 0) return [];

  // The SQL above chose the rows; scoped to the project as well, so the ids
  // alone never widen what is read.
  return prisma.requirement.findMany({
    where: { projectId, id: { in: hits.map((h) => h.id) } },
    orderBy,
    select,
  });
}
