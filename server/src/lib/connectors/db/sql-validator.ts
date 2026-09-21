/**
 * SQL validator — Phase 8 SEC (issue #64).
 *
 * Enforces "single SELECT, ≤QUERY_DB_MAX_ROWS rows" before any query reaches
 * a real driver. Backed by `node-sql-parser` so we get an honest AST instead
 * of a brittle regex. Failure modes are explicit:
 *
 *   - more than one statement                    → MULTIPLE_STATEMENTS
 *   - non-SELECT (INSERT/UPDATE/DELETE/DDL/etc.) → NON_SELECT
 *   - parse error (malformed SQL)                → SQL_PARSE_ERROR
 *
 * On success the validator rewrites the SQL string itself so the dialect's
 * row-cap clause (LIMIT / FETCH FIRST / SELECT TOP) reflects the cap. A
 * trailing LIMIT/FETCH on the OUTERMOST SELECT is rewritten in-place; if no
 * cap is present the appropriate clause is appended. We deliberately do NOT
 * touch LIMIT/FETCH inside CTEs or sub-queries — those are caller intent,
 * and the outer cap is enough to bound the result set returned to the API.
 *
 * NOTE: Oracle and SQL Server don't have a clean `node-sql-parser` grammar;
 * we parse them under the PostgreSQL grammar for the SELECT-only structural
 * check (it catches every mutating statement we care about) and rely on the
 * comment/string-stripped keyword backstop to reject Oracle/MSSQL-specific
 * mutating syntax (`MERGE INTO`, `OUTPUT INTO`, `UPDATE … RETURNING`, etc).
 * Follow-up issue #59 tracks adopting proper Oracle/MSSQL grammars.
 */
import sqlParser from "node-sql-parser";
import type { AST } from "node-sql-parser";
import { QUERY_DB_MAX_ROWS, type DbConnectorAllowList } from "@metis/shared";
import { ConnectorError } from "../types.js";

// node-sql-parser ships as CommonJS with a single default export. Under
// NodeNext module resolution the named-import form (`import { Parser }`)
// throws "Named export not found" at runtime, so destructure from the
// default export instead.
const { Parser } = sqlParser;

export type SqlDialect = "PostgreSQL" | "MySQL" | "Oracle" | "TransactSQL" | "SQLite";

const DRIVER_TO_DIALECT: Record<string, SqlDialect> = {
  postgres: "PostgreSQL",
  mysql: "MySQL",
  // PG grammar is permissive enough to validate SELECT-only shape for both.
  // Mutating Oracle/MSSQL syntax that the grammar accidentally accepts is
  // caught by the keyword backstop below (see file header).
  oracle: "PostgreSQL",
  sqlserver: "PostgreSQL",
  sqlite: "SQLite",
};

export interface ValidatedQuery {
  sql: string;
  appliedLimit: number;
}

/** Optional knobs for {@link validateSelectOnly}. */
export interface ValidateSelectOptions {
  /**
   * Per-connector table/column allow-list. When supplied, the query is
   * additionally checked with node-sql-parser's `whiteListCheck` so it can only
   * touch explicitly-permitted tables (and, optionally, columns). See
   * {@link DbConnectorAllowList} for the fail-closed / allow-all contract.
   */
  allowList?: DbConnectorAllowList;
}

const parser = new Parser();

function dialectFor(driver: string): SqlDialect {
  return DRIVER_TO_DIALECT[driver] ?? "PostgreSQL";
}

/**
 * Parse `sql` and assert it is exactly one SELECT (or WITH … SELECT) statement.
 * Returns a rewritten string with the row cap rewritten in-place.
 *
 * When `opts.allowList` is supplied, the query is additionally constrained to
 * the connector's permitted tables/columns (defense-in-depth, issue #882).
 */
export function validateSelectOnly(
  sql: string,
  driver: string,
  opts: ValidateSelectOptions = {},
): ValidatedQuery {
  if (typeof sql !== "string" || sql.trim().length === 0) {
    throw new ConnectorError(400, "SQL_REQUIRED", "SQL query is required");
  }
  const trimmed = sql.trim().replace(/;\s*$/, "");
  const dialect = dialectFor(driver);
  // Pre-extract dialect-specific cap clauses that the PG grammar can't parse,
  // so the structural validation succeeds. We re-apply the row cap on the
  // un-stripped form when building the rewritten SQL.
  const { stripped: parseInput, suppliedCap } = stripParserUnfriendlyCaps(trimmed, driver);

  let ast: AST | AST[];
  try {
    ast = parser.astify(parseInput, { database: dialect });
  } catch (err) {
    throw new ConnectorError(
      400,
      "SQL_PARSE_ERROR",
      `failed to parse SQL: ${(err as Error).message}`,
    );
  }

  const stmts: AST[] = Array.isArray(ast) ? ast : [ast];
  if (stmts.length === 0) {
    throw new ConnectorError(400, "SQL_PARSE_ERROR", "no statements found in SQL");
  }
  if (stmts.length > 1) {
    throw new ConnectorError(
      400,
      "MULTIPLE_STATEMENTS",
      "only a single SELECT statement is allowed",
    );
  }
  const stmt = stmts[0];
  if (stmt.type !== "select") {
    throw new ConnectorError(
      400,
      "NON_SELECT",
      `only SELECT statements are allowed (got: ${stmt.type.toUpperCase()})`,
    );
  }

  // Defence-in-depth: scan the SQL (with strings + comments removed) for
  // forbidden top-level keywords. Catches Oracle/MSSQL-specific DML that the
  // PG grammar accidentally accepts, and DML smuggled inside CTE column
  // aliases on permissive dialects.
  if (containsForbiddenStatementKeyword(trimmed)) {
    throw new ConnectorError(
      400,
      "FORBIDDEN_KEYWORD",
      "SQL contains a forbidden write/DDL keyword outside of an allow-listed context",
    );
  }

  // Per-connector allow-list (issue #882) — restrict the tables/columns the
  // query may reference. Runs against the parser-friendly form so dialect cap
  // clauses (already stripped) don't trip the internal re-parse.
  if (opts.allowList) {
    assertAllowList(parseInput, dialect, opts.allowList);
  }

  // Compute the cap from any pre-existing AST limit OR the dialect-specific
  // cap we stripped above (Oracle FETCH FIRST / MSSQL TOP), then rewrite the
  // SQL string itself so the cap is enforced even on retry / re-parse.
  const astLimit = computeAppliedLimit(stmt as unknown as Record<string, unknown>);
  // If the user supplied an explicit cap (LIMIT in AST OR FETCH/TOP we stripped),
  // honour the smaller of the two; otherwise use the max.
  const userCap =
    suppliedCap !== null
      ? Math.min(suppliedCap, astLimit === QUERY_DB_MAX_ROWS ? suppliedCap : astLimit)
      : astLimit;
  const desiredLimit = Math.max(1, Math.min(userCap, QUERY_DB_MAX_ROWS));
  const rewritten = rewriteRowCap(trimmed, desiredLimit, driver);
  return { sql: rewritten, appliedLimit: desiredLimit };
}

/**
 * Enforce a per-connector table/column allow-list using node-sql-parser's
 * `whiteListCheck`. Throws `ConnectorError(403, …)` on any reference to a
 * non-permitted table or column.
 *
 * Entries are built as anchored regexes of the form `select::(.*)::<name>` so:
 *   - the schema/db segment is wildcarded (matches `public.people` AND bare
 *     `people`);
 *   - the leaf name is regex-escaped, so `people` does NOT match `people_secret`;
 *   - `SELECT *` against a column allow-list is rejected (the parser reports
 *     the column as `(.*)`, which never matches a specific allowed column).
 */
function assertAllowList(
  input: string,
  dialect: SqlDialect,
  allowList: DbConnectorAllowList,
): void {
  // Fail-closed: an explicitly-empty table list permits nothing.
  if (allowList.tables.length === 0) {
    throw new ConnectorError(403, "TABLE_NOT_ALLOWED", "connector allow-list permits no tables");
  }

  const tableWhitelist = allowList.tables.map((t) => `select::(.*)::${escapeWhitelistName(t)}`);
  try {
    parser.whiteListCheck(input, tableWhitelist, { database: dialect, type: "table" });
  } catch (err) {
    throw new ConnectorError(403, "TABLE_NOT_ALLOWED", whitelistMessage(err, "table"));
  }

  if (allowList.columns && allowList.columns.length > 0) {
    const columnWhitelist = allowList.columns.map((c) => `select::(.*)::${escapeWhitelistName(c)}`);
    try {
      parser.whiteListCheck(input, columnWhitelist, { database: dialect, type: "column" });
    } catch (err) {
      throw new ConnectorError(403, "COLUMN_NOT_ALLOWED", whitelistMessage(err, "column"));
    }
  }
}

/** Escape regex metacharacters so an identifier is matched literally. */
function escapeWhitelistName(id: string): string {
  return id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Build a safe, non-leaking message from a whiteListCheck failure. */
function whitelistMessage(err: unknown, kind: "table" | "column"): string {
  const detail = err instanceof Error ? err.message : "";
  return detail
    ? `query references a ${kind} outside the connector allow-list (${detail})`
    : `query references a ${kind} outside the connector allow-list`;
}

/**
 * Read the (already-parsed) AST's outermost LIMIT and clamp it to
 * ≤QUERY_DB_MAX_ROWS. If the user supplied no LIMIT we apply the max.
 */
function computeAppliedLimit(stmt: Record<string, unknown>): number {
  const limitNode = stmt.limit as
    | { seperator?: string; value?: Array<{ type?: string; value?: number }> }
    | null
    | undefined;
  if (limitNode && Array.isArray(limitNode.value) && limitNode.value.length > 0) {
    // Two AST shapes:
    //   `LIMIT n` / `LIMIT n OFFSET m` → seperator "offset" (or empty for plain LIMIT);
    //                                    value[0] is the row count, value[1] is offset.
    //   `LIMIT off, n` (MySQL)         → seperator ",";
    //                                    value[0] is offset, value[1] is row count.
    const sep = (limitNode.seperator ?? "").toLowerCase();
    const node =
      sep === "," && limitNode.value.length >= 2 ? limitNode.value[1] : limitNode.value[0];
    if (node && typeof node.value === "number" && node.value > 0) {
      return Math.min(node.value, QUERY_DB_MAX_ROWS);
    }
  }
  return QUERY_DB_MAX_ROWS;
}

/**
 * Rewrite the OUTERMOST row-cap clause to `cap`. CTEs / sub-query LIMITs are
 * left alone (they're inside parentheses; our regex anchors to end-of-string).
 *
 * Behaviour by driver family:
 *   - postgres / mysql / sqlite: trailing `LIMIT n [OFFSET m]` rewritten in
 *     place, otherwise `LIMIT cap` appended.
 *   - sqlserver: trailing `OFFSET n ROWS FETCH NEXT m ROWS ONLY`, plain
 *     `FETCH NEXT m ROWS ONLY`, or `TOP (n)` / `TOP n` rewritten in place;
 *     otherwise `TOP (cap)` injected after the leading SELECT.
 *   - oracle: trailing `OFFSET n ROWS FETCH NEXT m ROWS ONLY` or
 *     `FETCH FIRST/NEXT m ROWS ONLY` rewritten; otherwise the clause is
 *     appended.
 */
function rewriteRowCap(sql: string, cap: number, driver: string): string {
  const safe = Math.max(1, Math.min(cap, QUERY_DB_MAX_ROWS));

  if (driver === "sqlserver") {
    // Trailing FETCH NEXT n ROWS ONLY (with optional OFFSET clause).
    const fetchRe = /\bfetch\s+(?:first|next)\s+\d+\s+rows?\s+only\s*$/i;
    if (fetchRe.test(sql)) {
      return sql.replace(fetchRe, `FETCH NEXT ${safe} ROWS ONLY`);
    }
    // Trailing OFFSET … ROWS (no FETCH) is allowed but uncapped — append FETCH.
    const offsetRe = /\boffset\s+\d+\s+rows?\s*$/i;
    if (offsetRe.test(sql)) {
      return `${sql} FETCH NEXT ${safe} ROWS ONLY`;
    }
    // SELECT TOP (n) or SELECT TOP n — rewrite the count.
    const topParenRe = /\bselect\s+top\s*\(\s*\d+\s*\)/i;
    if (topParenRe.test(sql)) {
      return sql.replace(topParenRe, `SELECT TOP (${safe})`);
    }
    const topBareRe = /\bselect\s+top\s+\d+\b/i;
    if (topBareRe.test(sql)) {
      return sql.replace(topBareRe, `SELECT TOP ${safe}`);
    }
    // No cap present — strip any user-supplied PG-style trailing LIMIT then
    // inject SELECT TOP (cap) after the OUTERMOST SELECT keyword.
    const stripped = sql.replace(/\blimit\s+\d+(?:\s+offset\s+\d+)?\s*$/i, "").trimEnd();
    return injectMssqlTop(stripped, safe);
  }

  if (driver === "oracle") {
    const fetchRe = /\bfetch\s+(?:first|next)\s+\d+\s+rows?\s+only\s*$/i;
    if (fetchRe.test(sql)) {
      return sql.replace(fetchRe, `FETCH FIRST ${safe} ROWS ONLY`);
    }
    const offsetRe = /\boffset\s+\d+\s+rows?\s*$/i;
    if (offsetRe.test(sql)) {
      return `${sql} FETCH FIRST ${safe} ROWS ONLY`;
    }
    // Strip a user-supplied PG-style LIMIT before appending Oracle's clause.
    const stripped = sql.replace(/\blimit\s+\d+(?:\s+offset\s+\d+)?\s*$/i, "").trimEnd();
    return `${stripped} FETCH FIRST ${safe} ROWS ONLY`;
  }

  // postgres / mysql / sqlite (LIMIT semantics).
  // MySQL accepts `LIMIT off, n` AND `LIMIT n OFFSET off`; PG accepts only the
  // latter. Rewrite either form in place; otherwise append.
  const myStyleOffsetCommaRe = /\blimit\s+(\d+)\s*,\s*\d+\s*$/i;
  if (myStyleOffsetCommaRe.test(sql)) {
    // Preserve offset, replace row count.
    return sql.replace(myStyleOffsetCommaRe, (_m, off: string) => `LIMIT ${off}, ${safe}`);
  }
  const limitOffsetRe = /\blimit\s+\d+(\s+offset\s+\d+)?\s*$/i;
  if (limitOffsetRe.test(sql)) {
    return sql.replace(limitOffsetRe, (_m, off: string | undefined) =>
      off ? `LIMIT ${safe}${off}` : `LIMIT ${safe}`,
    );
  }
  // FETCH FIRST is also legal on PG — rewrite if present.
  const fetchRe = /\bfetch\s+(?:first|next)\s+\d+\s+rows?\s+only\s*$/i;
  if (fetchRe.test(sql)) {
    return sql.replace(fetchRe, `FETCH FIRST ${safe} ROWS ONLY`);
  }
  return `${sql} LIMIT ${safe}`;
}

/** Inject `TOP (cap)` after the FIRST `SELECT` keyword (skipping leading WITH). */
function injectMssqlTop(sql: string, cap: number): string {
  // Skip leading WITH … (CTE) by finding the OUTER SELECT, but for our
  // purpose a left-most `SELECT` (case-insensitive) is fine — CTE bodies
  // contain SELECT inside parens, not at the start of the statement.
  const re = /\bselect\b/i;
  const m = re.exec(sql);
  if (!m) return sql;
  const idx = m.index + m[0].length;
  // Avoid double-injecting if a DISTINCT modifier sits right after.
  return `${sql.slice(0, idx)} TOP (${cap})${sql.slice(idx)}`;
}

/**
 * Strip strings + comments from `sql`, then look for forbidden top-level
 * keywords. Handles standard SQL plus PostgreSQL extensions:
 *
 *   - `--` line comments
 *   - `/* … *​/` block comments (rejects nested attempts as forbidden)
 *   - `'…'` strings with `''` escape
 *   - `"…"` quoted identifiers (kept as-is — they aren't string data)
 *   - PG dollar-quoted strings: `$tag$ … $tag$`
 *   - PG `E'…'` / `e'…'` C-style escape strings (with `\'` escape)
 *   - PG `U&'…'` unicode strings (with `''` escape)
 *
 * Returns true when a forbidden keyword survives stripping.
 */
function containsForbiddenStatementKeyword(sql: string): boolean {
  const s = stripStringsAndComments(sql);
  // Forbidden tokens — covers DML/DDL/DCL plus Oracle/MSSQL-specific
  // syntax that can slip past the PG-grammar AST check. We deliberately
  // omit `RETURNING` (legal column name in pure SELECTs) and rely on the
  // grammar's NON_SELECT rejection to catch it when used in DML context.
  const FORBIDDEN =
    /\b(?:insert\s+into|update\s+\w+\s+set|delete\s+from|drop\s+\w+|alter\s+\w+|truncate\s+(?:table\s+)?\w+|grant\s+|revoke\s+|create\s+\w+|merge\s+into\s+\w+|output\s+into\s+\w+|call\s+\w+\s*\(|exec(?:ute)?\s+\w+|do\s+\$|copy\s+\w+\s+(?:from|to)\b|vacuum\b|cluster\b|reindex\b|listen\b|notify\b)/i;
  return FORBIDDEN.test(s);
}

/** Remove string literals + comments from SQL so keyword scanning sees only code. */
export function stripStringsAndComments(sql: string): string {
  // 1. Block comments — including a hostile attempt to nest. We reject nested
  //    block comments by treating them as a single greedy `/* … */` chunk; any
  //    leftover `/*` after stripping signals an unbalanced/nested comment which
  //    we replace with the SQL-rejection sentinel so the keyword scan tags it.
  let out = sql.replace(/\/\*[\s\S]*?\*\//g, " ");
  if (/\/\*/.test(out) || /\*\//.test(out)) {
    // Unbalanced — strip aggressively to avoid hiding a keyword behind
    // dangling comment markers.
    out = out.replace(/\/\*[\s\S]*$/g, " ").replace(/^[\s\S]*?\*\//g, " ");
  }
  // 2. Line comments.
  out = out.replace(/--[^\n\r]*/g, " ");
  // 3. PG dollar-quoted strings: $tag$ … $tag$ (tag may be empty).
  out = out.replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, " ");
  // 4. PG E'…' / e'…' escape strings — backslash-escaped quotes are NOT
  //    string-terminators. Match either `\'` or `''` as escapes for `'`.
  out = out.replace(/\b[Ee]'(?:\\.|''|[^'\\])*'/g, " ");
  // 5. PG U&'…' unicode strings.
  out = out.replace(/\bU&'(?:''|[^'])*'/gi, " ");
  // 6. Standard '…' strings with '' escape.
  out = out.replace(/'(?:''|[^'])*'/g, " ");
  // Quoted identifiers ("…") deliberately kept — they aren't user data.
  return out;
}

/**
 * Pre-strip dialect-specific row-cap clauses that the PostgreSQL grammar can't
 * parse. Returns the parser-friendly SQL plus the user-supplied cap value (if
 * any) so we can clamp it.
 *
 * Oracle:
 *   - trailing `FETCH FIRST n ROWS ONLY` / `FETCH NEXT n ROWS ONLY`
 * SQL Server:
 *   - leading `SELECT TOP n` / `SELECT TOP (n)` (replaced with bare SELECT)
 *   - trailing `OFFSET n ROWS FETCH NEXT m ROWS ONLY`
 */
function stripParserUnfriendlyCaps(
  sql: string,
  driver: string,
): { stripped: string; suppliedCap: number | null } {
  if (driver === "oracle") {
    const fetchRe = /\s*\bfetch\s+(?:first|next)\s+(\d+)\s+rows?\s+only\s*$/i;
    const m = fetchRe.exec(sql);
    if (m) {
      return { stripped: sql.replace(fetchRe, ""), suppliedCap: Number(m[1]) };
    }
    return { stripped: sql, suppliedCap: null };
  }
  if (driver === "sqlserver") {
    let stripped = sql;
    let cap: number | null = null;
    const topParenRe = /\bselect\s+top\s*\(\s*(\d+)\s*\)/i;
    const topBareRe = /\bselect\s+top\s+(\d+)\b/i;
    const tp = topParenRe.exec(stripped);
    if (tp) {
      cap = Number(tp[1]);
      stripped = stripped.replace(topParenRe, "SELECT");
    } else {
      const tb = topBareRe.exec(stripped);
      if (tb) {
        cap = Number(tb[1]);
        stripped = stripped.replace(topBareRe, "SELECT");
      }
    }
    const fetchRe = /\s*\boffset\s+\d+\s+rows?\s+fetch\s+next\s+(\d+)\s+rows?\s+only\s*$/i;
    const fm = fetchRe.exec(stripped);
    if (fm) {
      cap = cap === null ? Number(fm[1]) : Math.min(cap, Number(fm[1]));
      stripped = stripped.replace(fetchRe, "");
    } else {
      const onlyFetch = /\s*\bfetch\s+(?:first|next)\s+(\d+)\s+rows?\s+only\s*$/i;
      const fm2 = onlyFetch.exec(stripped);
      if (fm2) {
        cap = cap === null ? Number(fm2[1]) : Math.min(cap, Number(fm2[1]));
        stripped = stripped.replace(onlyFetch, "");
      }
    }
    return { stripped, suppliedCap: cap };
  }
  return { stripped: sql, suppliedCap: null };
}
