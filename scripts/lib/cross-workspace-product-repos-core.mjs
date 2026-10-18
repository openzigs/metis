/**
 * #1258 — the read-only audit for product repo attachments that cross a
 * workspace boundary.
 *
 * #1257 (#1250) gated NEW attaches of a repo connection to a product by the
 * caller's access to the connection's own project. Rows written while that hole
 * was open are not re-checked by the write path, so this lists them for a human
 * to review. The readers (`GET /api/products[/:id]`, `POST /:id/analyze`) now
 * hide such a repo from anyone who cannot open its project; this query is how
 * an operator finds the rows that should be detached.
 *
 * A row is listed when its connection's project sits in a workspace AND either
 *   - the product's footprint — the workspaces of its bound projects
 *     (`projects.productId`) and of every attached repo's project — spans more
 *     than one workspace, or
 *   - the product's creator is not a member of that workspace.
 * Legacy workspace-less projects are open to every user, so a repo in one is
 * never listed and never counts towards the footprint.
 *
 * The SQL quotes every identifier and uses only CTEs, `UNION`, `COUNT(DISTINCT)`
 * and `CASE`, so the same text runs on SQLite and on Postgres (`psql` with
 * `SET default_transaction_read_only = on`). It is a single `SELECT`.
 */
import { DatabaseSync } from "node:sqlite";

export const CROSS_WORKSPACE_PRODUCT_REPOS_SQL = `
WITH "footprint" AS (
  SELECT pr."productId" AS "productId", p."workspaceId" AS "workspaceId"
    FROM "product_repos" pr
    JOIN "repo_connections" rc ON rc."id" = pr."repoConnectionId"
    JOIN "projects" p ON p."id" = rc."projectId"
   WHERE p."workspaceId" IS NOT NULL
  UNION
  SELECT p."productId" AS "productId", p."workspaceId" AS "workspaceId"
    FROM "projects" p
   WHERE p."productId" IS NOT NULL AND p."workspaceId" IS NOT NULL
),
"spread" AS (
  SELECT "productId", COUNT(DISTINCT "workspaceId") AS "workspaceCount"
    FROM "footprint"
   GROUP BY "productId"
)
SELECT pr."id"               AS "productRepoId",
       pr."productId"        AS "productId",
       prod."name"           AS "productName",
       prod."createdById"    AS "productCreatedById",
       pr."repoConnectionId" AS "repoConnectionId",
       rc."projectId"        AS "repoProjectId",
       rp."workspaceId"      AS "repoWorkspaceId",
       COALESCE(s."workspaceCount", 0) AS "productWorkspaceCount",
       CASE WHEN EXISTS (
              SELECT 1 FROM "workspace_members" wm
               WHERE wm."workspaceId" = rp."workspaceId"
                 AND wm."userId" = prod."createdById"
            ) THEN 1 ELSE 0 END AS "creatorIsMember"
  FROM "product_repos" pr
  JOIN "products" prod      ON prod."id" = pr."productId"
  JOIN "repo_connections" rc ON rc."id" = pr."repoConnectionId"
  JOIN "projects" rp        ON rp."id" = rc."projectId"
  LEFT JOIN "spread" s      ON s."productId" = pr."productId"
 WHERE rp."workspaceId" IS NOT NULL
   AND (
         COALESCE(s."workspaceCount", 0) > 1
      OR NOT EXISTS (
           SELECT 1 FROM "workspace_members" wm
            WHERE wm."workspaceId" = rp."workspaceId"
              AND wm."userId" = prod."createdById"
         )
   )
 ORDER BY pr."productId", pr."repoConnectionId"
`;

/**
 * Open a SQLite database so that no statement can write to it. `readOnly`
 * opens the file with `SQLITE_OPEN_READONLY`; a missing file is an error rather
 * than a silently created empty database.
 *
 * @param {string} dbPath
 * @returns {DatabaseSync}
 */
export function openReadOnly(dbPath) {
  return new DatabaseSync(dbPath, { readOnly: true });
}

/**
 * Run the audit against an open database.
 *
 * @param {{ prepare(sql: string): { all(): Record<string, unknown>[] } }} db
 * @returns {Record<string, unknown>[]}
 */
export function listCrossWorkspaceProductRepos(db) {
  return db
    .prepare(CROSS_WORKSPACE_PRODUCT_REPOS_SQL)
    .all()
    .map((row) => ({ ...row }));
}

/**
 * A human-readable report: one line per row, then a count.
 *
 * @param {Record<string, unknown>[]} rows
 * @returns {string}
 */
export function formatReport(rows) {
  if (rows.length === 0) {
    return "0 product repo attachments cross a workspace boundary.";
  }
  const lines = rows.map(
    (r) =>
      `product ${r.productId} (${r.productName}) <- repo connection ${r.repoConnectionId}` +
      ` [project ${r.repoProjectId}, workspace ${r.repoWorkspaceId}]` +
      ` productWorkspaces=${r.productWorkspaceCount}` +
      ` creatorIsMember=${Number(r.creatorIsMember) === 1 ? "yes" : "no"}`,
  );
  const noun = rows.length === 1 ? "attachment crosses" : "attachments cross";
  return [...lines, `${rows.length} product repo ${noun} a workspace boundary.`].join("\n");
}

/**
 * Parse the runner's arguments.
 *
 * @param {string[]} argv
 * @returns {{ db: string | null, sql: boolean, json: boolean, help: boolean }}
 */
export function parseArgs(argv) {
  /** @type {{ db: string | null, sql: boolean, json: boolean, help: boolean }} */
  const out = { db: null, sql: false, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--db") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error("--db needs a path");
      out.db = value;
      i += 1;
    } else if (arg === "--sql") out.sql = true;
    else if (arg === "--json") out.json = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}
