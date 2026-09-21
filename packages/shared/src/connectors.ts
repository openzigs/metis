/**
 * Connector schemas — repo + database (Phase 8 / issues #59–#64).
 *
 * Vault references follow the platform convention: any credential field that
 * accepts a `${vault:label-or-id}` token defers resolution to the server-side
 * vault and never crosses the API boundary in plaintext. The UI mints these
 * tokens by writing the secret to the vault first, then storing only the ref.
 */
import { z } from "zod";
import { CONNECTOR_STATUSES, DB_DRIVERS, REPO_PROVIDERS } from "./constants.js";
import { dateSchema, idSchema, timestampsSchema } from "./common.js";

// A vault-style reference OR an empty string (no credential — public repo etc).
const vaultRefOrEmpty = z
  .string()
  .max(256)
  .refine(
    (v) => v === "" || /^\$\{vault:[A-Za-z0-9_.\-/:]+\}$/.test(v),
    "must be empty or `${vault:label}`",
  );

const labelSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 _.\-]*$/, "invalid label");

// ---- Repo connector --------------------------------------------------------

/**
 * Owner/org + repo identifiers are only meaningful for git providers. For the
 * `local` (server path) and `upload` (.zip) providers — issue #288 — there is
 * no owner/repo, so these are optional at the schema level and the connector is
 * keyed on `localPath` (local) or `uploadPath` (upload) instead.
 */
const ownerOrgSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "invalid owner/org");
const repoNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "invalid repo name");

/**
 * A user-supplied absolute filesystem path for a `local` connector. Kept
 * deliberately permissive at the schema layer — the AUTHORITATIVE security
 * check is server-side `assertPathWithinAllowedRoot` (realpath + allowlist
 * containment). We only reject obviously bogus input here (empty, NUL bytes,
 * over-long) so the value reaches the realpath/allowlist guard intact.
 */
const localPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((v) => !v.includes("\0"), "path must not contain NUL bytes");

export const repoConnectorSchema = z
  .object({
    id: idSchema,
    projectId: idSchema,
    label: labelSchema,
    provider: z.enum(REPO_PROVIDERS),
    // Optional for non-git providers (local/upload). For git providers the
    // create/update schemas enforce presence via superRefine below.
    ownerOrOrg: ownerOrgSchema.nullable().default(null),
    repoName: repoNameSchema.nullable().default(null),
    // Issue #288 / OWASP A01 — the read DTO never exposes raw server paths or
    // archive paths. It only signals whether a local/upload source is present;
    // the actual path stays server-side. The create schemas below still accept
    // `localPath` as INPUT (validated against the allowlist), but it is never
    // echoed back in the connector representation.
    hasLocalSource: z.boolean().default(false),
    hasUploadArchive: z.boolean().default(false),
    defaultBranch: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\-/]*$/, "invalid branch")
      .default("main"),
    apiBaseUrl: z.string().url().nullable().default(null),
    secretRef: vaultRefOrEmpty.default(""),
    status: z.enum(CONNECTOR_STATUSES).default("pending"),
    errorMessage: z.string().nullable().default(null),
    lastTestedAt: dateSchema.nullable().default(null),
    lastIngestAt: dateSchema.nullable().default(null),
    isPrimary: z.boolean().default(false),
    lastCommitSha: z.string().max(64).nullable().default(null),
    createdById: idSchema.nullable(),
    deletedAt: dateSchema.nullable(),
  })
  .merge(timestampsSchema);
export type RepoConnector = z.infer<typeof repoConnectorSchema>;

/** Provider value `local` denotes a server-readable filesystem directory. */
export const REPO_PROVIDER_LOCAL = "local" as const;
/** Provider value `upload` denotes a user-uploaded .zip archive. */
export const REPO_PROVIDER_UPLOAD = "upload" as const;

export const createRepoConnectorSchema = z
  .object({
    label: labelSchema,
    provider: z.enum(REPO_PROVIDERS).default("github"),
    // Git providers require owner/repo; local/upload do not (validated below).
    ownerOrOrg: ownerOrgSchema.optional(),
    repoName: repoNameSchema.optional(),
    // `local` provider only — absolute server path to ingest.
    localPath: localPathSchema.optional(),
    defaultBranch: repoConnectorSchema.shape.defaultBranch.optional(),
    apiBaseUrl: z.string().url().nullable().optional(),
    secretRef: vaultRefOrEmpty.optional(),
    autoIngest: z.boolean().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.provider === REPO_PROVIDER_LOCAL) {
      // Server-path connector: localPath is the source of truth; owner/repo
      // and credentials are irrelevant.
      if (!val.localPath || val.localPath.trim() === "") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["localPath"],
          message: "localPath is required when provider is 'local'",
        });
      }
    } else if (val.provider === REPO_PROVIDER_UPLOAD) {
      // Upload connector: the archive arrives as a multipart file, not JSON —
      // owner/repo/localPath are all irrelevant here.
    } else {
      // Git providers (github / github_enterprise / gitlab) require owner+repo.
      if (!val.ownerOrOrg) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["ownerOrOrg"],
          message: "ownerOrOrg is required for git providers",
        });
      }
      if (!val.repoName) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["repoName"],
          message: "repoName is required for git providers",
        });
      }
    }
  });
export type CreateRepoConnectorInput = z.infer<typeof createRepoConnectorSchema>;

export const updateRepoConnectorSchema = z.object({
  label: labelSchema.optional(),
  provider: z.enum(REPO_PROVIDERS).optional(),
  ownerOrOrg: ownerOrgSchema.optional(),
  repoName: repoNameSchema.optional(),
  localPath: localPathSchema.optional(),
  defaultBranch: repoConnectorSchema.shape.defaultBranch.optional(),
  apiBaseUrl: z.string().url().nullable().optional(),
  secretRef: vaultRefOrEmpty.optional(),
  autoIngest: z.boolean().optional(),
  id: idSchema,
});
export type UpdateRepoConnectorInput = z.infer<typeof updateRepoConnectorSchema>;

// ---- Database connector ----------------------------------------------------

export const databaseConnectorSchema = z
  .object({
    id: idSchema,
    projectId: idSchema,
    label: labelSchema,
    driver: z.enum(DB_DRIVERS),
    host: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[A-Za-z0-9][A-Za-z0-9.\-:]*$/, "invalid host")
      .nullable()
      .default(null),
    port: z.number().int().min(1).max(65535).nullable().default(null),
    databaseName: z.string().max(128).nullable().default(null),
    username: z.string().max(128).nullable().default(null),
    secretRef: vaultRefOrEmpty.default(""),
    options: z.string().nullable().default(null),
    status: z.enum(CONNECTOR_STATUSES).default("pending"),
    errorMessage: z.string().nullable().default(null),
    lastTestedAt: dateSchema.nullable().default(null),
    lastIngestAt: dateSchema.nullable().default(null),
    createdById: idSchema.nullable(),
    deletedAt: dateSchema.nullable(),
  })
  .merge(timestampsSchema);
export type DatabaseConnector = z.infer<typeof databaseConnectorSchema>;

export const createDatabaseConnectorSchema = z.object({
  label: labelSchema,
  driver: z.enum(DB_DRIVERS),
  host: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[A-Za-z0-9][A-Za-z0-9.\-:]*$/, "invalid host")
    .optional(),
  port: z.number().int().min(1).max(65535).optional(),
  databaseName: z.string().max(128).optional(),
  username: z.string().max(128).optional(),
  secretRef: vaultRefOrEmpty.optional(),
  options: z.string().max(4096).optional(),
});
export type CreateDatabaseConnectorInput = z.infer<typeof createDatabaseConnectorSchema>;

export const updateDatabaseConnectorSchema = createDatabaseConnectorSchema
  .partial()
  .extend({ id: idSchema });
export type UpdateDatabaseConnectorInput = z.infer<typeof updateDatabaseConnectorSchema>;

// ---- Schema introspection (returned by /inspect) ---------------------------

export interface DbColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  defaultValue?: string | null;
  comment?: string | null;
}

export interface DbForeignKeyInfo {
  name: string;
  columns: string[];
  refTable: string;
  refSchema?: string;
  refColumns: string[];
}

export interface DbIndexInfo {
  name: string;
  columns: string[];
  isUnique: boolean;
}

export interface DbTableInfo {
  schema: string;
  name: string;
  estimatedRowCount?: number | null;
  comment?: string | null;
  columns: DbColumnInfo[];
  primaryKey?: string[];
  foreignKeys: DbForeignKeyInfo[];
  indexes: DbIndexInfo[];
}

/**
 * A stored database routine — a procedure or a function — discovered by the
 * read-only routines-introspection path (Epic #293 Phase 2, #300). METIS
 * introspects routine *existence + signature* only; it NEVER fetches or executes
 * the routine body (deep body-level call extraction is Phase 3, #294).
 *
 *   - `type`      — `procedure` (no return value, invoked via CALL/EXEC) or
 *                   `function` (returns a value, usable in expressions).
 *   - `signature` — a best-effort human-readable parameter/return signature
 *                   assembled from the dialect catalog (e.g.
 *                   `"(p_id IN NUMBER) RETURN VARCHAR2"`), or `""` when the
 *                   dialect does not expose one cheaply. NEVER the routine body.
 */
export interface DbRoutineInfo {
  schema: string;
  name: string;
  type: "procedure" | "function";
  signature: string;
}

/**
 * A coarse object dependency discovered by the **Tier-1** catalog-dependency
 * introspection path (Epic #881 Phase 1, #890) — e.g. Oracle's
 * `ALL_DEPENDENCIES`/`DBA_DEPENDENCIES`. Zero-parse: it records that `name`
 * (a PL/SQL package/procedure/function) REFERENCES `referencedName`, with NO
 * information about read/write direction, which statement makes the
 * reference, or dynamic (`EXECUTE IMMEDIATE`) SQL. It is a quick, always-on
 * fallback usable even when Tier-2 routine-BODY parsing (Epic #881 Phase 2,
 * #891-#893, `source = "sqlglot"`) is unavailable; Tier-2 refines/overrides it
 * — see `SCHEMA_SOURCE_PRECEDENCE`.
 */
export interface DbDependencyInfo {
  /** Schema/owner of the referencing object. */
  schema: string;
  /** Name of the referencing object (e.g. a PACKAGE/PROCEDURE/FUNCTION). */
  name: string;
  /** Catalog object type of the referencing object, e.g. `PACKAGE`/`PROCEDURE`/`FUNCTION`. */
  type: string;
  /** Schema/owner of the referenced object (`""` when the catalog reports none). */
  referencedSchema: string;
  /** Name of the referenced object. */
  referencedName: string;
  /** Catalog object type of the referenced object, e.g. `TABLE`/`VIEW`/`PACKAGE`. */
  referencedType: string;
}

/**
 * A PL/SQL PACKAGE discovered by the **Tier-2** package-introspection path
 * (Epic #881 Phase 2, #891). Unlike {@link DbRoutineInfo} (standalone
 * PROCEDURE/FUNCTION objects), a package groups its spec (public member
 * declarations) and body (implementation) as two separate catalog objects
 * sharing one name — `hasSpec`/`hasBody` record which halves exist so a
 * spec-only or body-only package (e.g. mid-deploy, or a spec whose body
 * failed to compile) is still represented. `members` lists the package's
 * PROCEDURE/FUNCTION member names (from `ALL_PROCEDURES`); METIS does not
 * cheaply distinguish procedure vs. function members at this tier, so no
 * per-member type/signature is captured here. The package BODY SOURCE is
 * fetched separately (see the driver's `fetchPackageBody`) — #892 parses it
 * into member-level `calls` lineage edges.
 */
export interface DbPackageInfo {
  schema: string;
  name: string;
  hasSpec: boolean;
  hasBody: boolean;
  members: string[];
}

export interface DbSchemaSnapshot {
  connectorId: string;
  driver: string;
  schema?: string;
  tables: DbTableInfo[];
  /**
   * Procedures & functions discovered by the read-only routines-introspection
   * path (#300). Optional for backward compatibility with snapshots produced
   * before Phase 2; treat `undefined` as "no routines introspected".
   */
  routines?: DbRoutineInfo[];
  extractedAt: string;
  durationMs: number;
}

// ---- Schema graph (Epic #895 — Interactive Schema Graph Explorer) ----------

/**
 * A single column as it appears in a {@link SchemaGraphTable} node. A minimal,
 * UI-facing projection of {@link DbColumnInfo} carrying only the flags the
 * React Flow explorer needs to render PK/FK/nullable affordances.
 */
export interface SchemaGraphColumn {
  name: string;
  dataType: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
}

/** A table node in the schema graph, including its LLM-generated description. */
export interface SchemaGraphTable {
  /**
   * Schema-qualified node identity (`"<schema>.<name>"`). Used for node ids and
   * FK edge resolution so that same-named tables in different schemas remain
   * distinct on multi-schema databases. The displayed label is {@link name}.
   */
  id: string;
  schema: string;
  name: string;
  /** LLM-generated prose description (empty string when none was produced). */
  description: string;
  columns: SchemaGraphColumn[];
}

/**
 * A foreign-key relationship edge between two tables. `source` is the table
 * holding the FK column(s); `target` is the referenced table. Both reference
 * the schema-qualified {@link SchemaGraphTable.id} so FK edges route correctly
 * across schemas. `sourceSchema`/`targetSchema` carry each endpoint's schema
 * explicitly for consumers that need it without re-parsing the id.
 */
export interface SchemaGraphEdge {
  source: string;
  target: string;
  sourceSchema: string;
  targetSchema: string;
  columns: string[];
  refColumns: string[];
}

/**
 * Structured, persistable representation of a database schema used by the
 * interactive Schema Graph Explorer. Persisted alongside the markdown document
 * (as JSON text) and served by `GET /api/projects/:projectId/docs/:docId/schema-graph`.
 */
export interface SchemaGraph {
  tables: SchemaGraphTable[];
  edges: SchemaGraphEdge[];
}

// ---- Query result (returned by /query) -------------------------------------

export interface DbQueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  durationMs: number;
}

// ---- Per-connector table/column allow-list (Epic #880 / #882) --------------

/** Key under which the allow-list lives inside the connector `options` JSON. */
export const DB_CONNECTOR_ALLOW_LIST_KEY = "allowList";

/**
 * Per-connector allow-list constraining which tables/columns a query may
 * touch. Enforced by `sql-validator` for the AI `query_database` tool (and the
 * connector query API) as a defense-in-depth layer on top of read-only
 * validation.
 *
 * Default behaviour (documented contract — see Epic #880 / #882):
 *   - **No allow-list configured** (key absent) → allow-all; read-only SELECT
 *     validation still applies.
 *   - **Empty `tables` array** → fail-closed; every query is rejected.
 *   - **`columns` omitted/empty** → all columns of allowed tables are permitted.
 *   - **`columns` non-empty** → only those columns may appear (`SELECT *` is
 *     rejected).
 */
export const dbConnectorAllowListSchema = z.object({
  tables: z.array(z.string().min(1).max(128)).max(500),
  columns: z.array(z.string().min(1).max(128)).max(2000).optional(),
});
export type DbConnectorAllowList = z.infer<typeof dbConnectorAllowListSchema>;

/**
 * Extract + validate the allow-list from a connector's JSON-encoded `options`.
 *
 * Returns `undefined` (allow-all) only when there is no allow-list to enforce:
 * genuinely blank/empty options, or well-formed options object without the
 * `allowList` key. Any non-empty-but-malformed options (invalid JSON, a
 * non-object JSON value, or a present-but-invalid `allowList`) **fail closed**
 * to `{ tables: [] }` so a broken config can never silently widen access.
 */
export function parseDbConnectorAllowList(
  options: string | null | undefined,
): DbConnectorAllowList | undefined {
  // Genuinely blank/empty options → no allow-list configured → allow-all.
  if (!options || options.trim() === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(options);
  } catch {
    // Malformed-but-non-empty options → fail closed (deny everything).
    return { tables: [] };
  }
  // Non-empty options that aren't a JSON object are malformed → fail closed.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { tables: [] };
  }
  const raw = (parsed as Record<string, unknown>)[DB_CONNECTOR_ALLOW_LIST_KEY];
  // Options parsed fine but no allow-list key → allow-all (none configured).
  if (raw === undefined || raw === null) return undefined;
  const result = dbConnectorAllowListSchema.safeParse(raw);
  // Present-but-invalid → fail-closed (no tables permitted).
  return result.success ? result.data : { tables: [] };
}

// ---- OS / archive junk-path filter ----------------------------------------

/**
 * True when `relPath` is OS/archive metadata junk that must never be treated as
 * ingestable source code.
 *
 * macOS, when creating a `.zip` of a folder via Finder, stores a parallel
 * `__MACOSX/` tree of AppleDouble resource-fork stubs — one `._<name>` file per
 * real entry, each only a few bytes. If these survive extraction they masquerade
 * as source files: e.g. an `risk` SAS upload ingested 182 "files" of which 91
 * (50%) were `__MACOSX/.../._*.sas` stubs. They parse to empty module symbols
 * and pollute RAG chunks, so the doc-gen model reports "the majority of files
 * had empty method bodies." Filtering them is the primary fix.
 *
 * Matches when ANY path segment is `__MACOSX`, OR the basename is an AppleDouble
 * stub (`._<name>`), OR the basename is a known desktop-metadata file
 * (`.DS_Store`, `Thumbs.db`). Both POSIX (`/`) and Windows (`\`) separators are
 * recognised so a zip built on either OS is handled. Pure string predicate — no
 * I/O — so it is safe to call in extraction, traversal, and retrieval paths.
 */
export function isJunkSourcePath(relPath: string): boolean {
  if (!relPath) return false;
  // Normalise Windows separators so `__MACOSX\foo\._bar.sas` is caught too.
  const segments = relPath.replace(/\\/g, "/").split("/");
  const basename = segments[segments.length - 1] ?? "";
  if (segments.some((seg) => seg === "__MACOSX")) return true;
  // AppleDouble resource-fork stub: basename starts with `._`. Guard against a
  // bare `..` segment (which also starts with `.`) by requiring the char after
  // the dot to be an underscore.
  if (basename.startsWith("._")) return true;
  if (basename === ".DS_Store" || basename === "Thumbs.db") return true;
  return false;
}
