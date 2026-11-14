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
 * Case-insensitive on both backends, beyond ASCII too (#2218). Prisma's
 * `contains` is case-sensitive on Postgres, and its `mode: "insensitive"`
 * exists only in the Postgres-generated client, so the match is raw SQL built
 * per backend by {@link requirementMatchQuery}:
 *
 * - Postgres folds both sides with `LOWER()`, which folds by its collation,
 *   and the term's own `%`, `_` and `!` are escaped so they match literally.
 * - SQLite's `LOWER()` and `LIKE` fold ASCII only, so "über" missed "Über …"
 *   (#2218). There the term is folded in JS instead, into a `GLOB` pattern
 *   that offers every case of each character (`[üÜ][bB][eE][rR]`), with the
 *   term's own `*`, `?` and `[` matched literally.
 *
 * Every value is a bound parameter.
 */
import { Prisma, prisma, resolveDatabaseProvider, type DatabaseProvider } from "../prisma.js";
import { restrictedIds, type SourceReader } from "../analysis/source-redaction.js";

/** The picker answers at most this many requirements. */
export const REQUIREMENT_PICKER_LIMIT = 20;

/**
 * #2447 — matches the picker reads before it leaves out what the caller cannot
 * see, so restricted matches rarely leave it short of a full answer.
 */
export const REQUIREMENT_PICKER_FETCH = REQUIREMENT_PICKER_LIMIT * 5;

/**
 * #2218 — the longest term matched, in characters; the rest is ignored. The term
 * becomes a pattern tested against every live title of the project.
 */
export const REQUIREMENT_PICKER_MAX_TERM = 200;

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
 * #2218 — a SQLite `GLOB` pattern matching titles that contain `term` in any
 * letter case. Each character becomes the set of its single-character cases
 * (`ü` → `[üÜ]`); a caseless character stands for itself, and GLOB's own `*`,
 * `?` and `[` are bracketed so they match literally (GLOB has no ESCAPE).
 */
export function caseFoldGlob(term: string): string {
  let body = "";
  for (const ch of term) {
    const cases = new Set(
      [ch, ch.toLowerCase(), ch.toUpperCase()].filter((c) => [...c].length === 1),
    );
    if (cases.size > 1) body += `[${[...cases].join("")}]`;
    else if (ch === "*" || ch === "?" || ch === "[") body += `[${ch}]`;
    else body += ch;
  }
  return `*${body}*`;
}

/**
 * The id query behind {@link searchProjectRequirements}, for `provider`: the
 * project's live requirements whose title contains `needle`, newest first, at
 * most {@link REQUIREMENT_PICKER_LIMIT}. Exported so a test can EXPLAIN the
 * statement production sends rather than a copy of it (#2218).
 */
export function requirementMatchQuery(
  provider: DatabaseProvider,
  projectId: string,
  needle: string,
  limit: number = REQUIREMENT_PICKER_LIMIT,
): Prisma.Sql {
  const titleMatch =
    provider === "sqlite"
      ? Prisma.sql`r."title" GLOB ${caseFoldGlob(needle)}`
      : Prisma.sql`LOWER(r."title") LIKE LOWER(${`%${escapeLike(needle)}%`}) ESCAPE '!'`;
  return Prisma.sql`
    SELECT r."id" FROM "requirements" r
    JOIN "analyses" a ON a."id" = r."analysisId"
    WHERE r."projectId" = ${projectId}
      AND r."deletedAt" IS NULL
      AND a."deletedAt" IS NULL
      AND ${titleMatch}
    ORDER BY r."createdAt" DESC, r."id" DESC
    LIMIT ${limit}`;
}

/**
 * The project's live requirements (not soft-deleted, nor in a soft-deleted
 * analysis) whose title contains `term` case-insensitively, newest first, at
 * most {@link REQUIREMENT_PICKER_LIMIT}. A blank term lists the newest; a term
 * longer than {@link REQUIREMENT_PICKER_MAX_TERM} characters is cut there.
 */
export async function searchProjectRequirements(
  projectId: string,
  term: string,
  provider: DatabaseProvider = resolveDatabaseProvider(),
  limit: number = REQUIREMENT_PICKER_LIMIT,
): Promise<RequirementPick[]> {
  const live = { projectId, deletedAt: null, analysis: { deletedAt: null } };
  // The id tie-break keeps the order stable when createdAt repeats.
  const orderBy = [{ createdAt: "desc" as const }, { id: "desc" as const }];
  const select = { id: true, title: true, analysisId: true, createdAt: true };

  // Cut by code point, so the cap never splits a surrogate pair.
  const needle = Array.from(term.trim()).slice(0, REQUIREMENT_PICKER_MAX_TERM).join("");
  if (!needle) {
    return prisma.requirement.findMany({
      where: live,
      orderBy,
      take: limit,
      select,
    });
  }

  const hits = await prisma.$queryRaw<Array<{ id: string }>>(
    requirementMatchQuery(provider, projectId, needle, limit),
  );
  if (hits.length === 0) return [];

  // The SQL above chose the rows; scoped to the project as well, so the ids
  // alone never widen what is read.
  return prisma.requirement.findMany({
    where: { projectId, id: { in: hits.map((h) => h.id) } },
    orderBy,
    select,
  });
}

/**
 * #2447 — the picks `reader` may see: a requirement resting on a source they
 * cannot see is left out, so the picker never names it nor confirms a word of
 * its title. One read of the picks' recorded sources, scoped to the project.
 */
export async function visibleRequirementPicks(
  projectId: string,
  picks: RequirementPick[],
  reader: SourceReader,
): Promise<RequirementPick[]> {
  if (picks.length === 0) return picks;
  const rows = await prisma.requirement.findMany({
    where: { projectId, id: { in: picks.map((p) => p.id) } },
    select: { id: true, analysisId: true, sourceIds: true },
  });
  const hidden = await restrictedIds(reader, rows);
  return hidden.size === 0 ? picks : picks.filter((p) => !hidden.has(p.id));
}
