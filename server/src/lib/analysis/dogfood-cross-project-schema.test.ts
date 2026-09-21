/**
 * Issue #833 (Epic #820 Phase 4) — DOGFOOD shared-database cross-project
 * blast-radius KNOWN-ANSWER test.
 *
 * Two projects (A and B) in one workspace point their `DatabaseConnection` at the
 * SAME physical dev database. A requirement in project A alters a table (`orders`)
 * that project B reads. This test pins the KNOWN ANSWERS of the shared-database
 * blast radius that the epic's merged machinery produces:
 *
 *   1. IDENTITY — A's and B's connections, created through the REAL create/link
 *      path (`linkConnectionToResource` → `resolveDatabaseResourceId`, which key
 *      on `(driver, host, port, databaseName)`), auto-resolve to the SAME
 *      `DatabaseResource`. Nothing is pre-linked: the equal `databaseResourceId`
 *      is the OUTPUT of the production find-or-create, not a fixture constant.
 *   2. CONSUMERS — running the REAL `enumerateSchemaConsumers` for project A over
 *      the affected `orders` object enumerates project B as an impacted consumer
 *      with `readBy` attribution (via the REAL `resolveProjectDatabaseIdentities`
 *      + `whichProjectsUseObject` — neither stubbed).
 *   3. RISK — through the REAL gap-report builder (`buildGapReport` /
 *      `buildDatabaseChanges` → `classifyDdlRisk`), the BREAKING change (drop a
 *      column B reads) escalates to CRITICAL naming project B (3b / #831), while
 *      the ADDITIVE change (add a nullable column) stays `expanding` with NO
 *      escalation. Both directions asserted, and both proven in the rendered
 *      markdown (`serializeAnalysisReportMarkdown`).
 *   4. VERDICT DISCIPLINE (#773 / #826) — the null-host negative control cannot
 *      resolve a cross-project identity, so its change reports "impact unknown"
 *      (`identityResolved: false`, NO `consumers` field) — never a fabricated
 *      "zero consumers".
 *
 * Negative controls (same suite, per the issue Scope):
 *   - a third connection with a DIFFERENT `databaseName` does NOT collapse into
 *     the shared resource, and its project is NOT enumerated as an `orders`
 *     consumer;
 *   - a null-host connection stays UNLINKED and its cross-project impact is
 *     reported as unknown, never zero-consumer.
 *
 * Testing discipline (P0 #750 lesson): NOTHING private is stubbed. The identity
 * find-or-create, the consumer enumeration, the DDL risk classifier, the
 * cross-project escalation, and the markdown serializer are all the REAL merged
 * code — only the Prisma STORAGE is an in-memory fake (the #289 no-real-DB-in-CI
 * convention already used by the 1b / #822 unit tests). The assertions are on
 * what crossed real boundaries (the resolved resource ids, the enumerated
 * consumers, the built gap report, the serialized report). Fully deterministic:
 * no network, no live DB, no real LLM. Runs cleanly under `pnpm test`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The identity find-or-create audits a resource create; keep it inert (no DB).
vi.mock("../audit/audit-service.js", () => ({ audit: vi.fn() }));

// #833 wired-seam block: getGapReport AND the schema-impact producer both read the
// analysis snapshot through this I/O boundary — mock it once to serve the
// known-answer requirement. (`pipelineSnapshotFixture` is a hoisted function
// declaration defined below; the other describe blocks don't touch this module.)
vi.mock("./analysis-service.js", () => ({
  getAnalysisSnapshot: vi.fn(async () => pipelineSnapshotFixture()),
}));

import { enumerateSchemaConsumers, type ConsumersPrisma } from "./affected-schema-consumers.js";
import {
  linkConnectionToResource,
  type ResourcePrisma,
} from "../cross-project/database-resource-service.js";
import {
  buildGapReport,
  buildDatabaseChanges,
  type GapReportFindingInput,
  type GapReportRequirementInput,
  type GapReportSchemaImpactInput,
} from "./gap-report.js";
import { serializeAnalysisReportMarkdown } from "./analysis-export.js";
import type {
  AffectedTableInput,
  SchemaImpactDataSource,
} from "../impact-analysis/schema-impact.js";
import { InMemoryCodeGraphDataSource } from "../impact-analysis/impact-analysis-engine.js";
import type { CodeGraphDataSource } from "../code-graph/query-service.js";
import type { RequirementCodeMatch } from "../traceability/requirement-code-mapping.js";
import { __resetConfigSingleton } from "../config/config-service.js";
import type {
  AnalysisSnapshot,
  GapReport,
  SchemaEdgeKind,
  TraceabilityMatrix,
} from "@metis/shared";

// ── The dogfood KNOWN ANSWER — one workspace, one physical DB, two projects ───

const WORKSPACE_ID = "ws-dogfood";
/** The single shared physical dev database A and B both connect to. */
const SHARED_DB = {
  driver: "postgres",
  host: "shared-pg.metis.internal",
  port: 5432,
  databaseName: "metis_app",
} as const;

const PROJECT_A = { id: "prj-a", name: "Alpha Service" };
const PROJECT_B = { id: "prj-b", name: "Beta Analytics" };
/** Negative control: a different physical DB (different `databaseName`). */
const PROJECT_C = { id: "prj-c", name: "Gamma Reporting" };
/** Negative control: a null-host connection that can never be auto-linked. */
const PROJECT_D = { id: "prj-d", name: "Delta Local" };

/** The shared table B reads and A's requirements alter. */
const SHARED_TABLE = "public.orders";
/** The column project B READS — dropping it is the breaking change. */
const READ_COLUMN = "status";
/** The nullable column A adds — the additive (non-breaking) change. */
const ADDED_COLUMN = "priority";

const ANALYSIS_ID = "an_833";

// ── In-memory Prisma fake (mutable) — reused across identity + enumeration ────
//
// Covers exactly the reads/writes the REAL identity find-or-create
// (resolveDatabaseResourceId / linkConnectionToResource) AND the REAL consumer
// enumeration (enumerateSchemaConsumers → resolveProjectDatabaseIdentities →
// whichProjectsUseObject) make. Connections start UNLINKED; the link path fills
// `databaseResourceId` and creates resources at runtime — so the identity
// convergence is produced by production code, never seeded.

interface ProjectRow {
  id: string;
  name: string;
  workspaceId: string | null;
  createdById: string;
  deletedAt: Date | null;
  /**
   * #856 — the #854 resolver's per-project override, read by
   * `resolveGapReportDeps` via `project.findUnique`. Undefined ⇒ the resolver's
   * whitelist guard falls back to the documented default (`"auto"`).
   */
  databaseAwareAnalysis?: string;
}
interface ConnRow {
  id: string;
  projectId: string;
  driver: string;
  host: string | null;
  port: number | null;
  databaseName: string | null;
  databaseResourceId: string | null;
  deletedAt: Date | null;
  createdAt: number;
}
interface ResourceRow {
  id: string;
  workspaceId: string;
  driver: string;
  host: string | null;
  port: number | null;
  databaseName: string | null;
}
interface IdentityRow {
  databaseResourceId: string;
  schemaName: string | null;
  objectName: string;
  objectType: string;
}
interface ClassRow {
  projectId: string;
  kind: string;
  tableName: string;
  columnName: string | null;
  usageClass: string;
  evidence: string;
}
interface Store {
  projects: ProjectRow[];
  connections: ConnRow[];
  resources: ResourceRow[];
  identities: IdentityRow[];
  classifications: ClassRow[];
}

/** Build a `UsageEvidence[]` JSON blob from a list of edge kinds. */
function ev(...edgeKinds: string[]): string {
  return JSON.stringify(
    edgeKinds.map((edgeKind) => ({
      edgeKind,
      source: "orm",
      fromQualifiedName: null,
      reconciliation: null,
    })),
  );
}

/** The combined Prisma surface both the identity and enumeration paths need. */
type DogfoodPrisma = ConsumersPrisma & ResourcePrisma;

function makeDb(store: Store): DogfoodPrisma {
  let seq = 0;
  /* eslint-disable @typescript-eslint/no-explicit-any -- lightweight in-memory Prisma fake */
  const db: any = {
    workspaceMember: {
      findUnique: async () => null,
      findMany: async () => [],
    },
    project: {
      findUnique: async ({ where }: any) => {
        const p = store.projects.find((x) => x.id === where.id);
        // #856 — also serves resolveGapReportDeps' per-project setting read.
        return p
          ? { workspaceId: p.workspaceId, databaseAwareAnalysis: p.databaseAwareAnalysis }
          : null;
      },
      findMany: async ({ where }: any) => {
        let rows = store.projects.slice();
        if (typeof where?.workspaceId === "string")
          rows = rows.filter((p) => p.workspaceId === where.workspaceId);
        if (where?.workspaceId?.not === null) rows = rows.filter((p) => p.workspaceId != null);
        if (where?.deletedAt === null) rows = rows.filter((p) => p.deletedAt == null);
        if (where?.id?.in) rows = rows.filter((p) => where.id.in.includes(p.id));
        return rows.map((p) => ({
          id: p.id,
          name: p.name,
          createdById: p.createdById,
          workspaceId: p.workspaceId,
        }));
      },
    },
    databaseResource: {
      findMany: async ({ where }: any) =>
        store.resources
          .filter((r) => r.workspaceId === where.workspaceId)
          .map((r) => ({ id: r.id })),
      findFirst: async ({ where }: any) =>
        store.resources.find(
          (r) =>
            r.workspaceId === where.workspaceId &&
            r.driver === where.driver &&
            r.host === where.host &&
            r.port === where.port &&
            r.databaseName === where.databaseName,
        ) ?? null,
      create: async ({ data }: any) => {
        seq += 1;
        const row: ResourceRow = { id: `dbres_${seq}`, ...data };
        store.resources.push(row);
        return { id: row.id };
      },
    },
    databaseConnection: {
      findMany: async ({ where }: any) => {
        // Sibling-sharing query (resolveProjectDatabaseIdentities).
        if (where.databaseResourceId?.in) {
          const ids: string[] = where.databaseResourceId.in;
          const notProject: string | undefined = where.projectId?.not;
          const wsFilter: string | undefined = where.project?.workspaceId;
          return store.connections
            .filter((c) => c.deletedAt == null)
            .filter((c) => c.databaseResourceId != null && ids.includes(c.databaseResourceId))
            .filter((c) => (notProject ? c.projectId !== notProject : true))
            .filter((c) => {
              const p = store.projects.find((x) => x.id === c.projectId);
              if (!p) return false;
              if (wsFilter != null && p.workspaceId !== wsFilter) return false;
              if (where.project?.deletedAt === null && p.deletedAt != null) return false;
              return true;
            })
            .map((c) => ({
              databaseResourceId: c.databaseResourceId,
              projectId: c.projectId,
              project: { name: store.projects.find((x) => x.id === c.projectId)?.name ?? "" },
            }));
        }
        // Project-connections query (reads the LIVE, possibly-just-linked rows).
        return store.connections
          .filter((c) => c.projectId === where.projectId && c.deletedAt == null)
          .sort((a, b) => a.createdAt - b.createdAt)
          .map((c) => ({
            id: c.id,
            driver: c.driver,
            host: c.host,
            port: c.port,
            databaseName: c.databaseName,
            databaseResourceId: c.databaseResourceId,
          }));
      },
      update: async ({ where, data }: any) => {
        const c = store.connections.find((x) => x.id === where.id);
        if (c) c.databaseResourceId = data.databaseResourceId;
        return { id: where.id, databaseResourceId: data.databaseResourceId };
      },
      // #856 — the #854 resolver's `hasSchemaData` connected-connection probe.
      // Deliberately ignores the `status: "connected"` filter (this fixture
      // never models connection status) and just counts non-deleted rows for
      // the project — good enough to make `auto` observe "this project HAS a
      // linked DatabaseConnection" the way the dogfood narrative intends.
      count: async ({ where }: any) =>
        store.connections.filter((c) => c.projectId === where.projectId && c.deletedAt == null)
          .length,
    },
    // #856 — the other half of `hasSchemaData`'s OR (non-empty schema graph).
    // This fixture has no code-graph symbols/edges, so always 0 — every project
    // here relies solely on the `databaseConnection.count` signal above.
    codeSymbol: { count: async () => 0 },
    codeEdge: { count: async () => 0 },
    schemaObjectIdentity: {
      findMany: async ({ where }: any) =>
        store.identities
          .filter((i) => where.databaseResourceId?.in?.includes(i.databaseResourceId))
          .map((i) => ({
            schemaName: i.schemaName,
            objectName: i.objectName,
            objectType: i.objectType,
          })),
      findFirst: async ({ where }: any) =>
        store.identities.find(
          (i) =>
            where.databaseResourceId.in.includes(i.databaseResourceId) &&
            i.schemaName === where.schemaName &&
            i.objectName === where.objectName &&
            i.objectType === where.objectType,
        ) ?? null,
    },
    schemaUsageClassification: {
      findMany: async ({ where }: any) =>
        store.classifications
          .filter((c) => {
            if (where.projectId?.in && !where.projectId.in.includes(c.projectId)) return false;
            if (where.tableName?.in && !where.tableName.in.includes(c.tableName)) return false;
            if (typeof where.tableName === "string" && c.tableName !== where.tableName)
              return false;
            return true;
          })
          .map((c) => ({ ...c })),
    },
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return db as DogfoodPrisma;
}

/** A connection row that starts UNLINKED (the link path fills the resource id). */
function unlinkedConn(
  id: string,
  projectId: string,
  parts: { host: string | null; port: number | null; databaseName: string | null },
  createdAt: number,
): ConnRow {
  return {
    id,
    projectId,
    driver: "postgres",
    host: parts.host,
    port: parts.port,
    databaseName: parts.databaseName,
    databaseResourceId: null,
    deletedAt: null,
    createdAt,
  };
}

/** The base fixture: one workspace, four projects, four UNLINKED connections. */
function baseStore(): Store {
  return {
    projects: [
      { ...PROJECT_A, workspaceId: WORKSPACE_ID, createdById: "u1", deletedAt: null },
      { ...PROJECT_B, workspaceId: WORKSPACE_ID, createdById: "u2", deletedAt: null },
      { ...PROJECT_C, workspaceId: WORKSPACE_ID, createdById: "u3", deletedAt: null },
      { ...PROJECT_D, workspaceId: WORKSPACE_ID, createdById: "u4", deletedAt: null },
    ],
    connections: [
      unlinkedConn("conn-a", PROJECT_A.id, SHARED_DB, 1),
      unlinkedConn("conn-b", PROJECT_B.id, SHARED_DB, 2),
      // C: same driver/host/port but a DIFFERENT databaseName ⇒ a different DB.
      unlinkedConn(
        "conn-c",
        PROJECT_C.id,
        { host: SHARED_DB.host, port: SHARED_DB.port, databaseName: "metis_reporting" },
        3,
      ),
      // D: null host ⇒ insufficient identity, can never be auto-linked.
      unlinkedConn(
        "conn-d",
        PROJECT_D.id,
        { host: null, port: null, databaseName: "metis_local" },
        4,
      ),
    ],
    resources: [],
    identities: [],
    classifications: [],
  };
}

/**
 * Run the REAL create/link path for A, B, C and seed the canonical `orders`
 * identity onto the resource A+B converge on (using the RUNTIME-generated
 * resource id, not a fixture constant). Returns the resolved ids so the caller
 * can assert convergence AND the enumeration reads a consistent world.
 */
async function linkAndSeed(store: Store): Promise<{
  db: DogfoodPrisma;
  resourceA: string | null;
  resourceB: string | null;
  resourceC: string | null;
}> {
  const db = makeDb(store);
  const resourceA = await linkConnectionToResource(
    "conn-a",
    { projectId: PROJECT_A.id, ...SHARED_DB },
    db,
  );
  const resourceB = await linkConnectionToResource(
    "conn-b",
    { projectId: PROJECT_B.id, ...SHARED_DB },
    db,
  );
  const resourceC = await linkConnectionToResource(
    "conn-c",
    {
      projectId: PROJECT_C.id,
      driver: SHARED_DB.driver,
      host: SHARED_DB.host,
      port: SHARED_DB.port,
      databaseName: "metis_reporting",
    },
    db,
  );

  // Seed the canonical `public.orders` identity onto the SHARED resource the
  // real linker produced for A+B (never a hardcoded id).
  if (resourceA) {
    store.identities.push({
      databaseResourceId: resourceA,
      schemaName: "public",
      objectName: "orders",
      objectType: "table",
    });
  }

  // Project B READS the shared orders.status column (the consumer evidence).
  store.classifications.push({
    projectId: PROJECT_B.id,
    kind: "column",
    tableName: SHARED_TABLE,
    columnName: READ_COLUMN,
    usageClass: "used",
    evidence: ev("reads"),
  });
  // Project C references only its OWN reporting table — NOT the shared orders.
  store.classifications.push({
    projectId: PROJECT_C.id,
    kind: "table",
    tableName: "public.report_snapshots",
    columnName: null,
    usageClass: "used",
    evidence: ev("reads"),
  });

  return { db, resourceA, resourceB, resourceC };
}

// ── The affected rows project A's two requirements produce (known answer) ─────

/** Requirement 1: DROP a column project B reads → BREAKING contract change. */
const BREAKING_ROW: AffectedTableInput = {
  objectKind: "column",
  tableName: SHARED_TABLE,
  columnName: READ_COLUMN,
  columnType: "text",
  changeKind: "drop-column",
  suggestedDdl: `ALTER TABLE ${SHARED_TABLE} DROP COLUMN ${READ_COLUMN};`,
  source: "orm",
  reconciliation: "matched",
  confidence: 0.9,
};

/** Requirement 2: ADD a nullable column → ADDITIVE (expanding) change. */
const ADDITIVE_ROW: AffectedTableInput = {
  objectKind: "column",
  tableName: SHARED_TABLE,
  columnName: ADDED_COLUMN,
  columnType: "text",
  changeKind: "add-column",
  suggestedDdl: `ALTER TABLE ${SHARED_TABLE} ADD COLUMN ${ADDED_COLUMN} text;`,
  source: "orm",
  reconciliation: "column-not-found",
  confidence: 0.85,
};

/** A minimal gap-report requirement carrying the two schema deltas. */
const REQUIREMENT: GapReportRequirementInput = {
  id: "REQ-ORDERS",
  title: "Rework the orders lifecycle",
  body: "Drop the legacy orders.status column and add a nullable priority column.",
  priority: "high",
  coverage: "no_evidence",
  verdict: "gap-confirmed",
  storyPoints: null,
  evidenceFindingIds: [],
};

/** Build the real gap report for project A from the real rows + real consumers. */
function gapReportFor(
  rows: AffectedTableInput[],
  consumers: GapReportSchemaImpactInput["consumers"],
): GapReport {
  return buildGapReport({
    analysisId: ANALYSIS_ID,
    projectId: PROJECT_A.id,
    requirements: [REQUIREMENT],
    findingsById: new Map<string, GapReportFindingInput>(),
    schemaImpactByRequirementId: new Map([[REQUIREMENT.id, { rows, consumers }]]),
  });
}

/** A minimal (empty) traceability matrix so the report serializer can stitch. */
function emptyMatrix(): TraceabilityMatrix {
  return {
    analysisId: ANALYSIS_ID,
    projectId: PROJECT_A.id,
    testsDetection: "heuristic",
    rows: [],
  };
}

beforeEach(() => vi.clearAllMocks());

// ── AC1 — identity: A and B auto-resolve to the SAME DatabaseResource ─────────

describe("#833 dogfood — shared-DB identity through the real create/link path", () => {
  it("collapses A's and B's identical connections to the SAME DatabaseResource (AC1)", async () => {
    const store = baseStore();
    const { resourceA, resourceB } = await linkAndSeed(store);

    // The KNOWN ANSWER: both resolve to one resource — the OUTPUT of the real
    // find-or-create, and exactly one resource exists for the shared DB.
    expect(resourceA).toBeTruthy();
    expect(resourceA).toBe(resourceB);
    // The stored links were written by the real linker, not seeded.
    const connA = store.connections.find((c) => c.id === "conn-a");
    const connB = store.connections.find((c) => c.id === "conn-b");
    expect(connA?.databaseResourceId).toBe(resourceA);
    expect(connB?.databaseResourceId).toBe(resourceA);
    expect(store.resources.filter((r) => r.databaseName === "metis_app")).toHaveLength(1);
  });

  it("does NOT collapse a connection with a different databaseName (negative control)", async () => {
    const store = baseStore();
    const { resourceA, resourceC } = await linkAndSeed(store);

    // C connects to a physically different DB → a distinct resource, never merged.
    expect(resourceC).toBeTruthy();
    expect(resourceC).not.toBe(resourceA);
  });

  it("leaves a null-host connection UNLINKED (insufficient identity)", async () => {
    const store = baseStore();
    const db = makeDb(store);
    const resourceD = await linkConnectionToResource(
      "conn-d",
      {
        projectId: PROJECT_D.id,
        driver: "postgres",
        host: null,
        port: null,
        databaseName: "metis_local",
      },
      db,
    );
    expect(resourceD).toBeNull();
    expect(store.connections.find((c) => c.id === "conn-d")?.databaseResourceId).toBeNull();
  });
});

// ── AC2 — consumers: project A's analysis enumerates B as a readBy consumer ────

describe("#833 dogfood — cross-project consumer enumeration (project A analysis)", () => {
  it("enumerates project B as a readBy consumer of the shared orders table (AC2)", async () => {
    const store = baseStore();
    const { db } = await linkAndSeed(store);

    const out = await enumerateSchemaConsumers(
      { projectId: PROJECT_A.id, affected: [BREAKING_ROW, ADDITIVE_ROW] },
      db,
    );

    // Both affected columns resolve to the shared `orders` identity, and each
    // enumerates project B (readBy) — never project A (the analyzed project).
    expect(out).toHaveLength(2);
    for (const entry of out) {
      expect(entry.identityResolved).toBe(true);
      expect(entry.consumers).toEqual([
        {
          projectId: PROJECT_B.id,
          projectName: PROJECT_B.name,
          usage: "readBy",
          objectQualifiedName: SHARED_TABLE,
        },
      ]);
    }
  });

  it("does NOT enumerate project C (different physical DB) as a consumer (negative control)", async () => {
    const store = baseStore();
    const { db } = await linkAndSeed(store);
    const out = await enumerateSchemaConsumers(
      { projectId: PROJECT_A.id, affected: [BREAKING_ROW] },
      db,
    );
    const consumerIds = out.flatMap((e) => e.consumers.map((c) => c.projectId));
    expect(consumerIds).not.toContain(PROJECT_C.id);
    expect(consumerIds).toEqual([PROJECT_B.id]);
  });
});

// ── AC3 — risk: breaking ⇒ CRITICAL naming B; additive ⇒ informational ────────

describe("#833 dogfood — breaking vs additive classification in the gap report", () => {
  it("escalates the breaking column drop to CRITICAL naming project B (3b / #831) (AC3)", async () => {
    const store = baseStore();
    const { db } = await linkAndSeed(store);
    const consumers = await enumerateSchemaConsumers(
      { projectId: PROJECT_A.id, affected: [BREAKING_ROW, ADDITIVE_ROW] },
      db,
    );
    const changes = buildDatabaseChanges({ rows: [BREAKING_ROW, ADDITIVE_ROW], consumers });

    const breaking = changes.find((c) => c.columnName === READ_COLUMN);
    expect(breaking?.changeKind).toBe("drop-column");
    expect(breaking?.riskClass).toBe("breaking");
    expect(breaking?.identityResolved).toBe(true);
    // The CRITICAL escalation is grounded and NAMES project B.
    expect(breaking?.crossProjectBreaking).toBe(true);
    expect(breaking?.consumers).toEqual([
      {
        projectId: PROJECT_B.id,
        projectName: PROJECT_B.name,
        usage: "readBy",
        objectQualifiedName: SHARED_TABLE,
      },
    ]);
  });

  it("keeps the additive nullable column expanding with NO escalation (AC3)", async () => {
    const store = baseStore();
    const { db } = await linkAndSeed(store);
    const consumers = await enumerateSchemaConsumers(
      { projectId: PROJECT_A.id, affected: [BREAKING_ROW, ADDITIVE_ROW] },
      db,
    );
    const changes = buildDatabaseChanges({ rows: [BREAKING_ROW, ADDITIVE_ROW], consumers });

    const additive = changes.find((c) => c.columnName === ADDED_COLUMN);
    expect(additive?.changeKind).toBe("add-column");
    expect(additive?.riskClass).toBe("expanding");
    expect(additive?.identityResolved).toBe(true);
    // Additive change on a shared object is informational — never escalated.
    expect(additive?.crossProjectBreaking).toBeUndefined();
  });

  it("renders the CRITICAL marker + project B as a consumer in the markdown report (AC3)", async () => {
    const store = baseStore();
    const { db } = await linkAndSeed(store);
    const consumers = await enumerateSchemaConsumers(
      { projectId: PROJECT_A.id, affected: [BREAKING_ROW, ADDITIVE_ROW] },
      db,
    );
    const md = serializeAnalysisReportMarkdown({
      gapReport: gapReportFor([BREAKING_ROW, ADDITIVE_ROW], consumers),
      matrix: emptyMatrix(),
    });

    expect(md).toContain("### Database changes (suggested DDL — review only, never executed)");
    expect(md).toContain(
      "⚠ CRITICAL — breaking change to a shared object with cross-project consumers",
    );
    // The grounding consumer (project B, reading the object) is named in the report.
    expect(md).toContain(`Consumers: ${PROJECT_B.name} (reads)`);
    // The additive column is rendered under the unverified head, risk expanding —
    // as the shared human label (#991), not the raw enum value.
    expect(md).toContain("risk: Additive");
  });
});

// ── AC4 — verdict discipline: null-host ⇒ impact UNKNOWN, never zero-consumer ──

describe("#833 dogfood — null-host control reports impact UNKNOWN (#773 / #826)", () => {
  it("reports identityResolved:false (not zero consumers) for an unlinked null-host project (AC4)", async () => {
    const store = baseStore();
    // Only D exists with a null-host (unlinked) connection; A/B are irrelevant here.
    const db = makeDb(store);
    // The link path refuses the null-host connection (proven above); D stays unlinked.
    const out = await enumerateSchemaConsumers(
      { projectId: PROJECT_D.id, affected: [BREAKING_ROW] },
      db,
    );

    expect(out).toHaveLength(1);
    // Unknown identity — NEVER flattened into "no consumers".
    expect(out[0].identityResolved).toBe(false);
    expect(out[0].consumers).toEqual([]);
  });

  it("surfaces the unresolved change as 'impact unknown', never a spurious CRITICAL (AC4)", async () => {
    const store = baseStore();
    const db = makeDb(store);
    const consumers = await enumerateSchemaConsumers(
      { projectId: PROJECT_D.id, affected: [BREAKING_ROW] },
      db,
    );
    const changes = buildDatabaseChanges({ rows: [BREAKING_ROW], consumers });

    const change = changes[0];
    // Even a breaking DDL is NOT escalated when the cross-project identity is
    // unresolved — the report says "unknown", never guesses a consumer.
    expect(change?.riskClass).toBe("breaking");
    expect(change?.identityResolved).toBe(false);
    expect(change?.consumers).toBeUndefined();
    expect(change?.crossProjectBreaking).toBeUndefined();

    const md = serializeAnalysisReportMarkdown({
      gapReport: gapReportFor([BREAKING_ROW], consumers),
      matrix: emptyMatrix(),
    });
    expect(md).toContain("Cross-project impact unknown (database identity unresolved)");
    expect(md).not.toContain("⚠ CRITICAL");
  });
});

// ── WIRED SEAM (#847) — the real identity path through getGapReport ────────────
//
// The blocks above assert the machinery at FUNCTION level (enumerateSchemaConsumers /
// buildDatabaseChanges called directly). This block closes the reachability gap the
// #847 producer wiring opened: it drives the EXACT production call the route makes —
// `getGapReport(analysisId, resolveGapReportDeps(...))` — so the known-answer
// cross-project consumer (project B) is proven to reach a user-visible gap report,
// threaded through the REAL DatabaseResource identity convergence (`linkAndSeed`'s
// find-or-create), with NO hand-built `loadSchemaImpact` (the false-green #847 kills).
// Flag ON drives the wired producer; flag OFF is asserted byte-identical to main.

/** Snapshot the wired seam reads: one schema-changing requirement in project A. */
function pipelineSnapshotFixture(): AnalysisSnapshot {
  return {
    id: ANALYSIS_ID,
    projectId: PROJECT_A.id,
    status: "completed",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    errorMessage: null,
    metadata: null,
    agents: [],
    requirements: [
      {
        id: REQUIREMENT.id,
        type: "functional",
        title: REQUIREMENT.title,
        body: REQUIREMENT.body,
        priority: "high",
        labels: [],
        storyPoints: null,
        reviewStatus: "pending",
        evidenceFindingIds: [],
        coverage: "no_evidence",
        verdict: "gap-confirmed",
        version: 1,
      },
    ],
  } as unknown as AnalysisSnapshot;
}

/** The impacted code symbol the requirement maps to (seeds the schema crossing). */
const PIPE_SEED_SYMBOL_ID = "dogfood-orders-writer";
/** The `public.orders` table symbol the impacted code writes. */
const PIPE_TABLE_SYMBOL_ID = "dogfood-orders-table";

/** One mapped code symbol → the only crossing seed (empty graph ⇒ no blast radius). */
const PIPE_ONE_MATCH: RequirementCodeMatch[] = [
  {
    codeSymbolId: PIPE_SEED_SYMBOL_ID,
    filePath: "server/src/lib/orders/order-service.ts",
    qualifiedName: "recordFulfilment",
    startLine: 1,
    endLine: 40,
    confidence: 0.9,
  },
];

const PIPE_EMPTY_GRAPH = new InMemoryCodeGraphDataSource([], []);

/** In-memory schema graph: the impacted code `writes` the shared `public.orders`. */
function pipeSchemaDataSource(): SchemaImpactDataSource {
  const edges = [
    {
      fromSymbolId: PIPE_SEED_SYMBOL_ID,
      toSymbolId: PIPE_TABLE_SYMBOL_ID,
      kind: "writes" as SchemaEdgeKind,
    },
  ];
  const symbols = [
    {
      id: PIPE_TABLE_SYMBOL_ID,
      kind: "table" as const,
      name: "orders",
      // qualifiedName is what crossToSchema emits as the affected row's `tableName`;
      // `public.orders` splits to the seeded (public, orders) identity ⇒ B matches.
      qualifiedName: SHARED_TABLE,
      source: "orm" as const,
    },
  ];
  return {
    async getSchemaEdgesFrom(ids: string[]) {
      return edges.filter((e) => ids.includes(e.fromSymbolId));
    },
    async getSchemaSymbolsByIds(ids: string[]) {
      return symbols.filter((s) => ids.includes(s.id));
    },
  };
}

/**
 * The producer's I/O seams wired to the REAL identity-linked Prisma (`linkAndSeed`).
 * NOT a hand-built `loadSchemaImpact` — the heavy lifting (computeProjectImpact →
 * crossToSchema, and the REAL enumerateSchemaConsumers) runs unstubbed over the real
 * shared-DB world the identity find-or-create produced.
 */
function pipelineProducerDeps(prisma: DogfoodPrisma) {
  return {
    mapRequirement: async () => PIPE_ONE_MATCH,
    dataSourceFor: (): CodeGraphDataSource => PIPE_EMPTY_GRAPH,
    schemaDataSourceFor: pipeSchemaDataSource,
    liveIndexFor: () => null,
    prisma: prisma as never,
  };
}

// getGapReport + resolveGapReportDeps are the REAL production symbols; imported after
// the analysis-service mock is registered (hoisted) so the snapshot read is stubbed.
const { getGapReport } = await import("./gap-report-service.js");
const { resolveGapReportDeps, SCHEMA_IMPACT_FLAG } = await import("./schema-impact-producer.js");

afterEach(() => {
  delete process.env[SCHEMA_IMPACT_FLAG];
  __resetConfigSingleton();
});

describe("#833/#856 dogfood — cross-project blast radius through the WIRED gap-report seam (#847)", () => {
  it("names project B as a readBy consumer via getGapReport(resolveGapReportDeps) over the REAL identity path (project A auto-enables on its linked DatabaseConnection, NO injected loadSchemaImpact)", async () => {
    // #856 — the legacy env flag is deliberately left unset: resolveGapReportDeps
    // now gates on the #854 resolver, not `isSchemaImpactEnabled()`. Project A's
    // `databaseAwareAnalysis` defaults to "auto" (ProjectRow), and after
    // `linkAndSeed` links `conn-a` to the shared resource, A has a live
    // `DatabaseConnection` — `hasSchemaData` is true, so `auto` resolves ON with
    // no explicit per-project override (#851's headline intent).
    __resetConfigSingleton();

    const store = baseStore();
    const { db } = await linkAndSeed(store); // REAL find-or-create convergence for A+B

    // The EXACT shape the route uses. resolveGapReportDeps builds the real producer;
    // we never hand in a loadSchemaImpact.
    const deps = await resolveGapReportDeps(PROJECT_A.id, pipelineProducerDeps(db));
    expect(deps.loadSchemaImpact).toBeTypeOf("function");
    expect(deps.databaseAware).toEqual({
      setting: "auto",
      enabled: true,
      ran: true,
      reason: "auto->resolved-on",
    });

    const report = await getGapReport(ANALYSIS_ID, deps);
    expect(report).not.toBeNull();

    const req = report?.requirements.find((r) => r.requirementId === REQUIREMENT.id);
    expect(req?.databaseChanges).toBeDefined();

    const change = req?.databaseChanges?.find((c) => c.tableName === SHARED_TABLE);
    expect(change).toBeDefined();
    // The suggested DDL is TEXT-ONLY, never executed.
    expect(change?.suggestedDdl).toContain("orders");
    // The shared-DB blast radius reached the user-visible report through the real
    // DatabaseResource identity — project B named as a readBy consumer.
    expect(change?.identityResolved).toBe(true);
    expect(change?.consumers).toEqual([
      {
        projectId: PROJECT_B.id,
        projectName: PROJECT_B.name,
        usage: "readBy",
        objectQualifiedName: SHARED_TABLE,
      },
    ]);
  });

  it("project A explicitly OFF ⇒ resolveGapReportDeps carries no loadSchemaImpact and the report carries NO databaseChanges (main's call shape)", async () => {
    delete process.env[SCHEMA_IMPACT_FLAG];
    __resetConfigSingleton();

    const store = baseStore();
    // #856 — an explicit per-project override is REQUIRED here: A's linked
    // DatabaseConnection alone would make `auto` resolve ON (see the test
    // above), so proving the OFF path needs the unconditional "off" override,
    // not just an unset legacy flag.
    store.projects.find((p) => p.id === PROJECT_A.id)!.databaseAwareAnalysis = "off";
    const { db } = await linkAndSeed(store);

    const deps = await resolveGapReportDeps(PROJECT_A.id, pipelineProducerDeps(db));
    expect(deps.loadSchemaImpact).toBeUndefined();
    expect(deps.databaseAware).toEqual({
      setting: "off",
      enabled: false,
      ran: false,
      reason: "off",
    });

    const report = await getGapReport(ANALYSIS_ID, deps);
    const req = report?.requirements.find((r) => r.requirementId === REQUIREMENT.id);
    expect(req?.databaseChanges).toBeUndefined();
  });
});
