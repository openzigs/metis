/**
 * #1623 — a synthetic product graph for the impact walk. No production content.
 *
 * Cross-product coupling is recorded the way METIS records it: a repo can be
 * attached to several products (`ProductRepo`), so an edge on one product
 * between two of its repos reaches every other product either repo is on.
 *
 * - Orders (P1) changes. Storefront (P2) calls its API: an edge on P2,
 *   `storefront -> orders-api`, `api` / `contract`, crossing the Orders
 *   contract whose latest version is breaking or additive (two variants).
 *   Reporting (P3) reads the `orders` table Orders writes: an edge on P3,
 *   `orders-api -> reporting`, `database` / `intrusive`. Notifications (P4) is
 *   two hops out: it listens to Reporting's events (an edge on P3).
 * - A cycle: Cycle A (P5) changes; Cycle B (P6) consumes it and Cycle A consumes
 *   Cycle B back; Cycle B and Cycle C (P7) consume each other.
 * - Two workspaces: Billing (P10, ws-a) changes; `partner-gateway` is on both
 *   P10 and Partner (P9, homed in ws-b), and Partner's `partner-core` (a ws-b
 *   repo) is also on Ledger (P11, ws-a). Ana (ws-a) cannot read Partner or
 *   `partner-core`; Mia (both) can. A ws-b repo attached to Billing before
 *   #1257 (`legacy-sync`) carries an edge Ana cannot read.
 *
 * #1668, each graph apart from the rest:
 * - Inside a product: Fulfilment (P13) changes; Warehouse (P14) has an API
 *   repo that calls it and a UI repo that calls that API (an edge inside P14);
 *   Alerts (P15) calls the Warehouse UI repo.
 * - Two writers of one table: Writer A (P16) and Writer B (P17), one `writes`
 *   edge between them from the lower id, as `detectSharedTables` records it.
 * - A repo walked twice: Dedup D (P18) changes; Dedup X (P19) is reached first
 *   through a loose edge, then through Dedup Y (P20) by a stronger path, so its
 *   repo is expanded twice. An edge from a ws-b repo touches it.
 */
import type { PrismaClient } from "@prisma/client";

export const WS_A = "ws-a-1623";
export const WS_B = "ws-b-1623";
export const PROJ_A = "proj-a-1623";
export const PROJ_A2 = "proj-a2-1623";
export const PROJ_B = "proj-b-1623";

export const P = {
  orders: "p01-orders-1623",
  storefront: "p02-storefront-1623",
  reporting: "p03-reporting-1623",
  notifications: "p04-notifications-1623",
  cycA: "p05-cyc-a-1623",
  cycB: "p06-cyc-b-1623",
  cycC: "p07-cyc-c-1623",
  partner: "p09-partner-1623",
  billing: "p10-billing-1623",
  ledger: "p11-ledger-1623",
  idle: "p12-idle-1623",
  fulfil: "p13-fulfil-1668",
  warehouse: "p14-warehouse-1668",
  alerts: "p15-alerts-1668",
  writerA: "p16-writer-a-1668",
  writerB: "p17-writer-b-1668",
  dedupD: "p18-dedup-d-1668",
  dedupX: "p19-dedup-x-1668",
  dedupY: "p20-dedup-y-1668",
} as const;

export const R = {
  ordersApi: "rc-orders-api-1623",
  storefront: "rc-storefront-1623",
  reporting: "rc-reporting-1623",
  notifier: "rc-notifier-1623",
  cycA: "rc-cyc-a-1623",
  cycB: "rc-cyc-b-1623",
  cycC: "rc-cyc-c-1623",
  billing: "rc-billing-1623",
  gateway: "rc-partner-gateway-1623",
  partnerCore: "rc-partner-core-1623",
  legacy: "rc-legacy-sync-1623",
  ledger: "rc-ledger-1623",
  idle: "rc-idle-1623",
  fulfil: "rc-fulfil-1668",
  whApi: "rc-wh-api-1668",
  whUi: "rc-wh-ui-1668",
  alerts: "rc-alerts-1668",
  writerA: "rc-writer-a-1668",
  writerB: "rc-writer-b-1668",
  dedupD: "rc-dedup-d-1668",
  dedupX: "rc-dedup-x-1668",
  dedupY: "rc-dedup-y-1668",
  dedupHidden: "rc-dedup-hidden-1668",
} as const;

export const CONTRACT_V1 = "cdoc-orders-v1-1623";
export const CONTRACT_V2 = "cdoc-orders-v2-1623";
export const ORDERS_TABLE = "res-orders-table-1623";
export const CONTRACT_REPORTING = "cdoc-reporting-v1-1623";

/** A breaking and an additive change to the Orders contract (`ContractDiff` JSON). */
export const BREAKING_DIFF = JSON.stringify({
  added: [],
  removed: [],
  changed: [
    {
      id: "graphql type Order",
      format: "graphql",
      kind: "type",
      before: "kind=type|fields=[id:ID, total:Float]",
      after: "kind=type|fields=[id:ID]",
    },
  ],
  hasChanges: true,
});
export const ADDITIVE_DIFF = JSON.stringify({
  added: [],
  removed: [],
  changed: [
    {
      id: "graphql type Order",
      format: "graphql",
      kind: "type",
      before: "kind=type|fields=[id:ID, total:Float]",
      after: "kind=type|fields=[currency:String, id:ID, total:Float]",
    },
  ],
  hasChanges: true,
});

const PRODUCTS: Array<{ id: string; name: string; workspaceId: string; repos: string[] }> = [
  { id: P.orders, name: "Orders", workspaceId: WS_A, repos: [R.ordersApi] },
  { id: P.storefront, name: "Storefront", workspaceId: WS_A, repos: [R.storefront, R.ordersApi] },
  {
    id: P.reporting,
    name: "Reporting",
    workspaceId: WS_A,
    repos: [R.reporting, R.ordersApi, R.notifier],
  },
  {
    id: P.notifications,
    name: "Notifications",
    workspaceId: WS_A,
    repos: [R.notifier],
  },
  { id: P.cycA, name: "Cycle A", workspaceId: WS_A, repos: [R.cycA] },
  { id: P.cycB, name: "Cycle B", workspaceId: WS_A, repos: [R.cycB, R.cycA] },
  { id: P.cycC, name: "Cycle C", workspaceId: WS_A, repos: [R.cycC, R.cycB] },
  { id: P.partner, name: "Partner", workspaceId: WS_B, repos: [R.partnerCore, R.gateway] },
  { id: P.billing, name: "Billing", workspaceId: WS_A, repos: [R.billing, R.gateway, R.legacy] },
  { id: P.ledger, name: "Ledger", workspaceId: WS_A, repos: [R.ledger, R.partnerCore] },
  { id: P.idle, name: "Idle", workspaceId: WS_A, repos: [R.idle] },
  { id: P.fulfil, name: "Fulfilment", workspaceId: WS_A, repos: [R.fulfil] },
  { id: P.warehouse, name: "Warehouse", workspaceId: WS_A, repos: [R.whApi, R.whUi] },
  { id: P.alerts, name: "Alerts", workspaceId: WS_A, repos: [R.alerts] },
  { id: P.writerA, name: "Writer A", workspaceId: WS_A, repos: [R.writerA] },
  { id: P.writerB, name: "Writer B", workspaceId: WS_A, repos: [R.writerB] },
  { id: P.dedupD, name: "Dedup D", workspaceId: WS_A, repos: [R.dedupD] },
  { id: P.dedupX, name: "Dedup X", workspaceId: WS_A, repos: [R.dedupX] },
  { id: P.dedupY, name: "Dedup Y", workspaceId: WS_A, repos: [R.dedupY] },
];

const REPOS: Array<{ id: string; projectId: string; name: string }> = [
  { id: R.ordersApi, projectId: PROJ_A, name: "orders-api" },
  { id: R.storefront, projectId: PROJ_A, name: "storefront" },
  { id: R.reporting, projectId: PROJ_A2, name: "reporting" },
  { id: R.notifier, projectId: PROJ_A, name: "notifier" },
  { id: R.cycA, projectId: PROJ_A, name: "cyc-a" },
  { id: R.cycB, projectId: PROJ_A, name: "cyc-b" },
  { id: R.cycC, projectId: PROJ_A, name: "cyc-c" },
  { id: R.billing, projectId: PROJ_A, name: "billing" },
  { id: R.gateway, projectId: PROJ_A, name: "partner-gateway" },
  { id: R.partnerCore, projectId: PROJ_B, name: "partner-core" },
  { id: R.legacy, projectId: PROJ_B, name: "legacy-sync" },
  { id: R.ledger, projectId: PROJ_A, name: "ledger" },
  { id: R.idle, projectId: PROJ_A, name: "idle" },
  { id: R.fulfil, projectId: PROJ_A, name: "fulfil" },
  { id: R.whApi, projectId: PROJ_A, name: "wh-api" },
  { id: R.whUi, projectId: PROJ_A, name: "wh-ui" },
  { id: R.alerts, projectId: PROJ_A, name: "alerts" },
  { id: R.writerA, projectId: PROJ_A, name: "writer-a" },
  { id: R.writerB, projectId: PROJ_A, name: "writer-b" },
  { id: R.dedupD, projectId: PROJ_A, name: "dedup-d" },
  { id: R.dedupX, projectId: PROJ_A, name: "dedup-x" },
  { id: R.dedupY, projectId: PROJ_A, name: "dedup-y" },
  { id: R.dedupHidden, projectId: PROJ_B, name: "dedup-hidden" },
];

interface EdgeSeed {
  id: string;
  productId: string;
  sourceRepoId: string;
  targetRepoId: string | null;
  integrationKind: string;
  strength: string;
  direction: string;
  confidence?: number;
  resourceId?: string;
  contractDocId?: string;
  sourceFile?: string;
  targetFile?: string;
  evidence?: unknown[];
}

const API = { integrationKind: "api", strength: "contract", direction: "consumes" } as const;

export const EDGES: EdgeSeed[] = [
  {
    id: "e-storefront-orders-1623",
    productId: P.storefront,
    sourceRepoId: R.storefront,
    targetRepoId: R.ordersApi,
    ...API,
    confidence: 0.9,
    contractDocId: CONTRACT_V1,
    sourceFile: "src/checkout/order-client.ts",
    targetFile: "schema.graphql",
    evidence: [
      { filePath: "src/checkout/order-client.ts", lineNumber: 42, pattern: "gql", matchType: "x" },
      { filePath: "schema.graphql", lineNumber: 3, pattern: "gql", matchType: "x" },
    ],
  },
  {
    id: "e-orders-reporting-1623",
    productId: P.reporting,
    sourceRepoId: R.ordersApi,
    targetRepoId: R.reporting,
    integrationKind: "database",
    strength: "intrusive",
    direction: "writes",
    confidence: 0.8,
    resourceId: ORDERS_TABLE,
    sourceFile: "src/orders/store.ts",
    targetFile: "sql/daily-report.sql",
    evidence: [{ filePath: "sql/daily-report.sql", lineNumber: 7, pattern: "sql", matchType: "x" }],
  },
  {
    id: "e-notifier-reporting-1623",
    productId: P.reporting,
    sourceRepoId: R.notifier,
    targetRepoId: R.reporting,
    integrationKind: "event",
    strength: "contract",
    direction: "consumes",
    confidence: 0.9,
    // Reporting's own event contract changed in a breaking way too: two hops out
    // it is cited, never counted (only the first hop's provider is the change).
    contractDocId: CONTRACT_REPORTING,
  },
  // The cycle: B consumes A; C consumes B and B consumes C; A consumes B.
  {
    id: "e-cyc-b-a-1623",
    productId: P.cycB,
    sourceRepoId: R.cycB,
    targetRepoId: R.cycA,
    ...API,
  },
  {
    id: "e-cyc-a-b-1623",
    productId: P.cycB,
    sourceRepoId: R.cycA,
    targetRepoId: R.cycB,
    ...API,
  },
  {
    id: "e-cyc-c-b-1623",
    productId: P.cycC,
    sourceRepoId: R.cycC,
    targetRepoId: R.cycB,
    ...API,
  },
  {
    id: "e-cyc-b-c-1623",
    productId: P.cycC,
    sourceRepoId: R.cycB,
    targetRepoId: R.cycC,
    ...API,
  },
  // Two workspaces.
  {
    id: "e-gateway-billing-1623",
    productId: P.billing,
    sourceRepoId: R.gateway,
    targetRepoId: R.billing,
    ...API,
    confidence: 0.9,
  },
  {
    id: "e-legacy-billing-1623",
    productId: P.billing,
    sourceRepoId: R.legacy,
    targetRepoId: R.billing,
    ...API,
    confidence: 0.9,
  },
  {
    id: "e-core-gateway-1623",
    productId: P.partner,
    sourceRepoId: R.partnerCore,
    targetRepoId: R.gateway,
    ...API,
    confidence: 0.9,
  },
  // #1668 — inside a product: Warehouse's UI calls its own API, which calls Fulfilment.
  {
    id: "e-whapi-fulfil-1668",
    productId: P.warehouse,
    sourceRepoId: R.whApi,
    targetRepoId: R.fulfil,
    ...API,
  },
  {
    id: "e-whui-whapi-1668",
    productId: P.warehouse,
    sourceRepoId: R.whUi,
    targetRepoId: R.whApi,
    ...API,
  },
  {
    id: "e-alerts-whui-1668",
    productId: P.alerts,
    sourceRepoId: R.alerts,
    targetRepoId: R.whUi,
    ...API,
  },
  // #1668 — two writers of `stock`: one edge, from the lower id, as detection records it.
  {
    id: "e-writers-1668",
    productId: P.writerB,
    sourceRepoId: R.writerA,
    targetRepoId: R.writerB,
    integrationKind: "database",
    strength: "intrusive",
    direction: "writes",
    confidence: 0.8,
    sourceFile: "sql/a.sql",
    targetFile: "sql/b.sql",
    evidence: [
      {
        filePath: "sql/a.sql",
        lineNumber: 1,
        pattern: "sql_table_write",
        matchType: "shared_table",
      },
      {
        filePath: "sql/b.sql",
        lineNumber: 2,
        pattern: "sql_table_write",
        matchType: "shared_table",
      },
    ],
  },
  // #1668 — Dedup X is reached by a loose edge, then by a stronger path through Dedup Y.
  {
    id: "e-dedup-x-d-1668",
    productId: P.dedupX,
    sourceRepoId: R.dedupX,
    targetRepoId: R.dedupD,
    ...API,
  },
  {
    id: "e-dedup-y-d-1668",
    productId: P.dedupY,
    sourceRepoId: R.dedupY,
    targetRepoId: R.dedupD,
    ...API,
    strength: "functional",
  },
  {
    id: "e-dedup-x-y-1668",
    productId: P.dedupX,
    sourceRepoId: R.dedupX,
    targetRepoId: R.dedupY,
    ...API,
    strength: "functional",
  },
  {
    id: "e-dedup-hidden-x-1668",
    productId: P.dedupX,
    sourceRepoId: R.dedupHidden,
    targetRepoId: R.dedupX,
    ...API,
  },
];

/** Users: Mia is in both workspaces, Ana only in ws-a. */
export async function seedImpactGraph(db: PrismaClient): Promise<void> {
  await db.role.create({ data: { id: "role-coordinator", key: "coordinator", name: "c" } });
  for (const ws of [WS_A, WS_B]) {
    await db.workspace.create({ data: { id: ws, name: ws, slug: ws } });
  }
  for (const [id, workspaces] of [
    ["mia", [WS_A, WS_B]],
    ["ana", [WS_A]],
  ] as const) {
    await db.user.create({
      data: { id, username: id, displayName: id, email: `${id}@example.test` },
    });
    await db.userRole.create({ data: { userId: id, roleId: "role-coordinator" } });
    for (const workspaceId of workspaces) {
      await db.workspaceMember.create({ data: { workspaceId, userId: id, role: "member" } });
    }
  }
  for (const [id, workspaceId] of [
    [PROJ_A, WS_A],
    [PROJ_A2, WS_A],
    [PROJ_B, WS_B],
  ]) {
    await db.project.create({
      data: { id, workspaceId, name: id, slug: id, createdById: "mia", status: "active" },
    });
  }
  for (const r of REPOS) {
    await db.repoConnection.create({
      data: {
        id: r.id,
        projectId: r.projectId,
        label: r.name,
        ownerOrOrg: "acme",
        repoName: r.name,
      },
    });
  }
  for (const p of PRODUCTS) {
    await db.product.create({
      data: { id: p.id, name: p.name, slug: p.id, workspaceId: p.workspaceId, createdById: "mia" },
    });
    for (const repoConnectionId of p.repos) {
      await db.productRepo.create({ data: { productId: p.id, repoConnectionId } });
    }
  }
  await db.productResource.create({
    data: { id: ORDERS_TABLE, productId: P.reporting, kind: "table", name: "orders" },
  });
  for (const [id, productId, repoId, version, diff] of [
    [CONTRACT_V1, P.storefront, R.ordersApi, 1, null],
    [CONTRACT_V2, P.storefront, R.ordersApi, 2, BREAKING_DIFF],
    [CONTRACT_REPORTING, P.reporting, R.reporting, 1, BREAKING_DIFF],
  ] as const) {
    await db.productContractDoc.create({
      data: { id, productId, repoId, version, contentHash: `h${id}`, title: "Contract", diff },
    });
  }
  for (const e of EDGES) {
    await db.productEdge.create({
      data: {
        id: e.id,
        productId: e.productId,
        sourceRepoId: e.sourceRepoId,
        targetRepoId: e.targetRepoId,
        edgeType: "calls",
        confidence: e.confidence ?? 0.9,
        evidence: JSON.stringify(e.evidence ?? []),
        sourceFile: e.sourceFile ?? null,
        targetFile: e.targetFile ?? null,
        integrationKind: e.integrationKind,
        strength: e.strength,
        direction: e.direction,
        resourceId: e.resourceId ?? null,
        contractDocId: e.contractDocId ?? null,
      },
    });
  }
  // The `orders` table, as the cross-project usage classifications see it.
  for (const [projectId, kind, columnName] of [
    [PROJ_A, "table", null],
    [PROJ_A, "column", "total"],
    [PROJ_A2, "table", null],
  ] as const) {
    await db.schemaUsageClassification.create({
      data: { projectId, kind, tableName: "orders", columnName, usageClass: "used" },
    });
  }
}
