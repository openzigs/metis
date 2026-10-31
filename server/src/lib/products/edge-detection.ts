/**
 * #1619 — run the relationship detector over a product and store what it finds.
 *
 * - **Readable repos only.** The repos crawled are the product's live repos the
 *   caller can read (`productRepoReadAccess`, #1258), the same set every other
 *   product read uses; detection makes no other read across workspaces.
 * - **Idempotent.** A stored detected edge is matched to a new one by its ends,
 *   type and resource (`detectedEdgeKey`) and updated in place, so re-running on
 *   unchanged input changes nothing. A detected edge no longer found is deleted.
 * - **Declared edges are never touched.** Only rows detection owns are updated
 *   or deleted, and a detected edge with the key of a declared one is not
 *   written: the person's declaration stands for it. Detection owns `detected`
 *   rows and `overridden` ones (#1647): an overridden edge keeps the person's
 *   classification when found again, and is deleted like any detected edge
 *   once it is not.
 * - **Scoped to the repos crawled.** An edge with an end outside this run (a
 *   repo the caller cannot read, or one with no files to crawl) is left as it
 *   is, so a member's run never erases what an admin's run found.
 */
import { randomUUID } from "node:crypto";
import type { AuthPayload } from "@metis/shared";
import { prisma } from "../prisma.js";
import { DYNAMIC_PLACEHOLDER_PREFIX } from "../code-graph/schema-graph.js";
import { ProductError, LIVE_PRODUCT_REPOS } from "./product-service.js";
import { productRepoReadAccess } from "./product-access.js";
import { crawlFiles, type CrawlTableRef, type FileEntry } from "./repo-crawler.js";
import {
  detectRelationships,
  detectedEdgeKey,
  type DetectedEdge,
  type DetectedResource,
  type RepoCrawlData,
} from "./relationship-detector.js";

/** A repo detection may crawl, as the loader is handed it. */
export interface DetectionRepo {
  repoConnectionId: string;
  repoName: string;
  ownerOrOrg: string;
  defaultBranch: string;
}

/** Files of one repo, or null when they cannot be read (the repo is then not crawled). */
export type RepoFileLoader = (repo: DetectionRepo) => Promise<FileEntry[] | null>;

export interface EdgeSyncResult {
  created: number;
  updated: number;
  deleted: number;
  /** Detected edges not written because a declared edge holds their key. */
  keptDeclared: number;
}

export interface DetectionResult extends EdgeSyncResult {
  /** The repos this run crawled: the scope it wrote in. */
  scannedRepoIds: string[];
}

/** The origins of an edge or resource detection owns and may refresh or drop (#1647). */
const DETECTION_OWNED_ORIGINS = ["detected", "overridden"];

const SCHEMA_EDGE_ACCESS: Record<string, CrawlTableRef["access"]> = {
  reads: "read",
  writes: "write",
  "persists-to": "write",
};

/**
 * The tables each repo's code graph reads or writes: its `reads` / `writes` /
 * `persists-to` edges to a table symbol, keyed by the symbol's qualified name
 * (lower-cased `schema.table`, as the crawl's SQL scan writes it). This is the
 * shared-table identity the cross-project queries use, read per repo.
 */
export async function loadCodeGraphTables(
  repoIds: string[],
): Promise<Map<string, CrawlTableRef[]>> {
  const out = new Map<string, CrawlTableRef[]>();
  if (repoIds.length === 0) return out;
  const rows = await prisma.codeEdge.findMany({
    where: {
      kind: { in: Object.keys(SCHEMA_EDGE_ACCESS) },
      graph: { repoConnectionId: { in: repoIds } },
      toSymbol: { kind: "table" },
    },
    select: {
      kind: true,
      filePath: true,
      line: true,
      toSymbol: { select: { qualifiedName: true } },
      graph: { select: { repoConnectionId: true } },
    },
  });
  for (const row of rows) {
    const repoId = row.graph.repoConnectionId;
    const table = row.toSymbol?.qualifiedName.toLowerCase();
    // #1647 — a `?dynamic:` placeholder stands for a table the extractor could
    // not resolve; two repos that both build SQL dynamically share no table.
    if (!repoId || !table || table.startsWith(DYNAMIC_PLACEHOLDER_PREFIX)) continue;
    const list = out.get(repoId) ?? [];
    list.push({
      table,
      access: SCHEMA_EDGE_ACCESS[row.kind],
      filePath: row.filePath,
      lineNumber: row.line,
    });
    out.set(repoId, list);
  }
  return out;
}

/**
 * Store a detection run's edges for `productId`, inside the repos `scopeRepoIds`
 * (see the module comment for the rules). Detected resources are upserted by
 * `(productId, kind, name)`, keeping a declared one's origin; an API edge is
 * linked to its target repo's latest contract document.
 */
export async function syncDetectedProductEdges(
  productId: string,
  scopeRepoIds: string[],
  detected: DetectedEdge[],
): Promise<EdgeSyncResult> {
  const scope = new Set(scopeRepoIds);
  const inScope = (source: string, target: string | null) =>
    scope.has(source) && (target === null || scope.has(target));
  const wanted = detected.filter((e) => inScope(e.sourceRepoId, e.targetRepoId));

  // Resources first: the edges need their ids. A resource the product already
  // has keeps its row (and a declared one its origin); a new one gets its id
  // here, so it is created in the same batch transaction as the edges that go
  // through it (#1647) and a failed run leaves no orphaned detected resource.
  const resourceIds = new Map<string, string>();
  const resourceKey = (r: { kind: string; name: string }) => `${r.kind}/${r.name}`;
  const wantedResources = new Map(
    wanted.flatMap((e) => (e.resource ? [[resourceKey(e.resource), e.resource] as const] : [])),
  );
  if (wantedResources.size > 0) {
    // All of the product's resources, not an `in` list: a run can find more
    // shared tables than SQLite binds in one statement (#1346).
    const known = await prisma.productResource.findMany({
      where: { productId },
      select: { id: true, kind: true, name: true },
    });
    for (const r of known) resourceIds.set(resourceKey(r), r.id);
  }
  const resourceCreates = [...wantedResources.entries()]
    .filter(([key]) => !resourceIds.has(key))
    .map(([key, r]) => {
      const id = randomUUID();
      resourceIds.set(key, id);
      return prisma.productResource.create({
        data: { id, productId, kind: r.kind, name: r.name, origin: "detected" },
      });
    });

  // The latest contract version of each API edge's target repo.
  const apiTargets = [
    ...new Set(wanted.filter((e) => e.integrationKind === "api").map((e) => e.targetRepoId)),
  ];
  const contractOf = new Map<string, string>();
  if (apiTargets.length > 0) {
    const docs = await prisma.productContractDoc.findMany({
      where: { productId, repoId: { in: apiTargets } },
      orderBy: { version: "desc" },
      select: { id: true, repoId: true },
    });
    for (const d of docs) if (d.repoId && !contractOf.has(d.repoId)) contractOf.set(d.repoId, d.id);
  }

  const existing = (
    await prisma.productEdge.findMany({
      where: { productId, sourceRepoId: { in: [...scope] } },
      include: { resource: { select: { kind: true, name: true } } },
    })
  ).filter((e) => inScope(e.sourceRepoId, e.targetRepoId));
  const keyOf = (e: (typeof existing)[number]) =>
    detectedEdgeKey({
      sourceRepoId: e.sourceRepoId,
      targetRepoId: e.targetRepoId,
      edgeType: e.edgeType,
      resource: e.resource as DetectedResource | null,
    });
  // A declared edge is the person's; one detection owns (`detected`, or
  // `overridden` by a person, #1647) is matched, refreshed and, once no longer
  // found, deleted.
  const declaredKeys = new Set(existing.filter((e) => e.origin === "declared").map(keyOf));
  const stored = new Map(existing.filter((e) => e.origin !== "declared").map((e) => [keyOf(e), e]));

  const result: EdgeSyncResult = { created: 0, updated: 0, deleted: 0, keptDeclared: 0 };
  const writes = [];
  const kept = new Set<string>();
  for (const edge of wanted) {
    const key = detectedEdgeKey(edge);
    if (declaredKeys.has(key)) {
      result.keptDeclared++;
      continue;
    }
    const facts = {
      confidence: edge.confidence,
      evidence: JSON.stringify(edge.evidence),
      sourceFile: edge.sourceFile ?? null,
      targetFile: edge.targetFile ?? null,
      contractDocId:
        edge.integrationKind === "api" ? (contractOf.get(edge.targetRepoId) ?? null) : null,
    };
    const classification = {
      integrationKind: edge.integrationKind,
      strength: edge.strength,
      direction: edge.direction,
    };
    const data = { ...facts, ...classification };
    const prior = stored.get(key);
    if (prior) {
      kept.add(key);
      // An overridden edge keeps the person's classification; only what
      // detection found (evidence, confidence, files, contract) is refreshed.
      const update = prior.origin === "overridden" ? facts : data;
      writes.push(prisma.productEdge.update({ where: { id: prior.id }, data: update }));
      result.updated++;
    } else {
      writes.push(
        prisma.productEdge.create({
          data: {
            ...data,
            productId,
            sourceRepoId: edge.sourceRepoId,
            targetRepoId: edge.targetRepoId,
            edgeType: edge.edgeType,
            resourceId: edge.resource
              ? (resourceIds.get(resourceKey(edge.resource)) ?? null)
              : null,
            origin: "detected",
          },
        }),
      );
      result.created++;
    }
  }
  const stale = [...stored.entries()].filter(([key]) => !kept.has(key)).map(([, e]) => e.id);
  if (stale.length > 0) {
    writes.push(
      prisma.productEdge.deleteMany({
        where: { id: { in: stale }, origin: { in: DETECTION_OWNED_ORIGINS } },
      }),
    );
    result.deleted = stale.length;
  }
  // One batch: the new resources, the edge writes and the orphan cleanup land
  // together, so a failure leaves the stored edges and resources as they were.
  // A resource detection owns that no edge goes through any more is dropped; a
  // declared one stays.
  await prisma.$transaction([
    ...resourceCreates,
    ...writes,
    prisma.productResource.deleteMany({
      where: { productId, origin: { in: DETECTION_OWNED_ORIGINS }, edges: { none: {} } },
    }),
  ]);
  return result;
}

/**
 * Crawl the product's repos the caller can read, detect the edges between them,
 * and store them. The caller has already checked access to the product itself
 * (`assertProductAccessible`). `loadRepoFiles` supplies each repo's files; a
 * repo it returns null for is not crawled and its stored edges are left alone.
 */
export async function runProductEdgeDetection(opts: {
  user: AuthPayload;
  productId: string;
  loadRepoFiles: RepoFileLoader;
}): Promise<DetectionResult> {
  const product = await prisma.product.findUnique({
    where: { id: opts.productId },
    include: {
      repos: {
        where: LIVE_PRODUCT_REPOS,
        // #1647 — a stable order; `detectRelationships` sorts again, as it must
        // not let input order decide an edge's direction.
        orderBy: { repoConnectionId: "asc" },
        include: {
          repoConnection: {
            select: { projectId: true, repoName: true, ownerOrOrg: true, defaultBranch: true },
          },
        },
      },
    },
  });
  if (!product) {
    throw new ProductError(404, "PRODUCT_NOT_FOUND", `Product ${opts.productId} not found`);
  }
  const canRead = await productRepoReadAccess(opts.user);
  const crawled: RepoCrawlData[] = [];
  for (const repo of product.repos.filter(canRead)) {
    const info: DetectionRepo = {
      repoConnectionId: repo.repoConnectionId,
      repoName: repo.repoConnection.repoName ?? repo.repoConnectionId,
      ownerOrOrg: repo.repoConnection.ownerOrOrg ?? "",
      defaultBranch: repo.repoConnection.defaultBranch ?? "main",
    };
    const files = await opts.loadRepoFiles(info);
    if (!files) continue;
    crawled.push({
      repoConnectionId: info.repoConnectionId,
      repoName: info.repoName,
      ownerOrOrg: info.ownerOrOrg,
      crawlResult: crawlFiles(files, info.repoConnectionId),
    });
  }
  const scannedRepoIds = crawled.map((r) => r.repoConnectionId);
  const graphTables = await loadCodeGraphTables(scannedRepoIds);
  for (const repo of crawled) repo.codeGraphTables = graphTables.get(repo.repoConnectionId) ?? [];
  const synced = await syncDetectedProductEdges(
    opts.productId,
    scannedRepoIds,
    detectRelationships(crawled),
  );
  return { ...synced, scannedRepoIds };
}
