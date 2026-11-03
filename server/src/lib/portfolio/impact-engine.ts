/**
 * Epic #1608 (#1623) — cross-product impact propagation: from the products
 * whose code must change, walk the typed product edges (#1618/#1619/#1620) to
 * the products downstream of them, and say how each is reached and how badly.
 *
 *   direct-change products     (`partial` coverage, and the product chosen to host a gap)
 *     -> their readable repos   (the frontier)
 *     -> edges out of them      (readable products' edges between readable repos)
 *     -> consumer repos          (the other end, by the edge's direction)
 *     -> consumer products       (every product a consumer repo is attached to)
 *     -> repeat to `maxDepth`    (default 2 hops), from the consumer repos
 *
 * Who is downstream of whom is read from the edge's `direction` (source side):
 * `consumes` / `depends-on` — the source depends on the target; `provides` /
 * `writes` — the target depends on the source, except a `writes` edge between
 * two writers of a table, which carries it both ways (#1668); `reads` or
 * unclassified — both ways, since two readers of one table share its model.
 * An edge between two repos of one product moves the change inside that
 * product: the repo it reaches is walked from at the same depth, since no
 * product boundary was crossed (#1668). An edge to a resource
 * alone (no target repo) is paired with the other edges through the same
 * resource: a repo that writes or provides it reaches every other repo using it.
 * #1724 — two products homed in one workspace that each record a resource of the
 * same kind and name (a topic one provides and the other consumes) share it, so
 * their edges through it pair across the product boundary. An edge stored on
 * two products (detection records a cross-product edge on each product
 * analysed) is walked once.
 *
 * Invariants:
 *
 * - **Access never widens.** Only edges recorded on a product the caller can
 *   read, between repos the caller can read (#1258), are walked. An edge that
 *   touches a repo the caller cannot read is not walked; it is counted
 *   (`hiddenEdgeCount`) on the product it leaves, so nothing is silently
 *   omitted. A consumer product the caller cannot read is `restricted`: its id
 *   and the fact it is downstream, nothing else, and the walk never expands
 *   through it (the `workspace-rollup.ts` pattern). How many it stopped at is
 *   returned (`stoppedAtRestricted`), and a readable product nothing readable
 *   reaches is `restricted`, not `none`, when the same walk able to read every
 *   product and repo reaches it: it may be reached through what the caller
 *   cannot read, so it is never stated unaffected (#1668, #1673, #1689). Any
 *   other product stays `none`.
 * - **Cycle-safe and bounded.** A direct-change product is never downstream; a
 *   product is listed once, with its most severe path; a repo is expanded again
 *   only when reached by a more severe path, and never past `maxDepth`.
 * - **Nothing silently omitted.** Every product the caller asks to list is in
 *   the result, `none` when nothing reaches it (FR-3, #1609).
 * - **Read-only.** Reads the product graph, contracts and the cross-project
 *   usage classifications; writes nothing, runs no DDL, calls no connector.
 */
import {
  PRODUCT_COUPLING_STRENGTHS,
  PRODUCT_EDGE_DIRECTIONS,
  PRODUCT_EDGE_ORIGINS,
  PRODUCT_INTEGRATION_KINDS,
  type AuthPayload,
  type ChangeSeverity,
  type CrossProjectImpactResult,
  type PortfolioAssessmentInput,
  type PortfolioImpactKind,
  type ProductCouplingStrength,
  type ProductEdgeDirection,
  type ProductEdgeOrigin,
  type ProductIntegrationKind,
} from "@metis/shared";
import type { ProductEdge as ProductEdgeRow } from "@prisma/client";
import { prisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import { buildProductAccessWhere, productRepoReadAccess } from "../products/product-access.js";
import {
  isBreakingChange,
  isBreakingDiff,
  type ChangedItem,
  type ContractDiff,
  type ContractItem,
} from "../products/contract-diff.js";
import { crossProjectImpact } from "../cross-project/cross-project-impact.js";
import type { SchedulerActor } from "../scheduler/project-access.js";
import { deriveHopSeverity, moreSevere, weaker, type HopSeverity } from "./impact-severity.js";
import type { PortfolioGapResult } from "./gap-engine.js";
import { impactSentence } from "./report-overview.js";

const log = createChildLogger("portfolio-impact");

export const DEFAULT_IMPACT_DEPTH = 2;
export const MAX_IMPACT_DEPTH = 4;
/** Evidence one hop keeps, at most, of each kind. */
const MAX_CALL_SITES = 10;
const MAX_CONTRACT_ITEMS = 20;
const MAX_SHARED_OBJECTS = 20;

// ─── Result ─────────────────────────────────────────────────────────────────

export interface ImpactRepoRef {
  repoConnectionId: string;
  label: string;
}

/** A contract item the provider's latest contract version changed. */
export interface ImpactContractItem {
  id: string;
  change: "added" | "removed" | "changed";
  breaking: boolean;
}

/** The provider's contract a hop crosses, as its latest version changed it. */
export interface ImpactContractEvidence {
  contractDocId: string;
  repoConnectionId: string | null;
  version: number;
  breaking: boolean;
  items: ImpactContractItem[];
}

/** A table or column both ends' projects use (`crossProjectImpact`, #309). */
export interface ImpactSharedObject {
  schemaName: string | null;
  objectName: string;
  objectType: string;
  usageClass: string;
}

/** One hop of an impact path: what crossed from a provider repo to a consumer repo. */
export interface ImpactHop {
  /** One repo-to-repo edge, or the two edges that meet at a shared resource. */
  edgeIds: string[];
  /** The product the edges are recorded on. */
  edgeProductId: string;
  fromProductId: string;
  toProductId: string;
  provider: ImpactRepoRef;
  consumer: ImpactRepoRef;
  integrationKind: ProductIntegrationKind | null;
  strength: ProductCouplingStrength | null;
  direction: ProductEdgeDirection | null;
  confidence: number;
  origin: ProductEdgeOrigin;
  resource: { kind: string; name: string } | null;
  /** Where the consumer uses what changes, as detection recorded it. */
  callSites: Array<{ filePath: string; line: number | null }>;
  contract: ImpactContractEvidence | null;
  sharedObjects: ImpactSharedObject[];
  severity: HopSeverity;
}

export interface ProductImpact {
  productId: string;
  /** Null for a `restricted` product. */
  name: string | null;
  /** The caller cannot read this product: nothing but its id and impact kind is given. */
  restricted: boolean;
  impactKind: PortfolioImpactKind;
  /** The integration kind of the hop that reaches it. */
  via: ProductIntegrationKind | null;
  /** The path's severity: its weakest hop. Null for a direct change or no impact. */
  severity: ChangeSeverity | null;
  /** Every edge on the path, in hop order. */
  edgeIds: string[];
  /** The path from a direct-change product, hop by hop. */
  hops: ImpactHop[];
  /** Edges out of this product the caller cannot read, so not walked. */
  hiddenEdgeCount: number;
}

export interface PortfolioImpactResult {
  maxDepth: number;
  /**
   * #1668 — restricted products the walk reached and so did not walk through.
   * When non-zero, a product listed `none` may still be reached through one.
   */
  stoppedAtRestricted: number;
  /** Sorted by product id. */
  products: ProductImpact[];
}

export interface PortfolioImpactInput {
  /** Products whose code must change. */
  directChangeProductIds: readonly string[];
  /** Products the result lists whether or not anything reaches them. */
  listedProductIds?: readonly string[];
  /**
   * Product boundaries crossed from a direct-change product, at most
   * (1..MAX_IMPACT_DEPTH). A hop between two repos of one product costs none.
   */
  maxDepth?: number;
}

export interface PortfolioImpactDeps {
  /** The shared tables and columns of a project (defaults to `crossProjectImpact`). */
  sharedObjects?: (actor: SchedulerActor, projectId: string) => Promise<CrossProjectImpactResult>;
}

// ─── Direct-change products ─────────────────────────────────────────────────

/**
 * The products whose code must change for a requirement: each one that covers
 * it in part (the rest must be built there), and the product chosen to host it.
 * A product that already covers it needs no change for it.
 */
export function directChangeProductIds(
  gap: Pick<PortfolioGapResult, "products">,
  hostProductId: string | null = null,
): string[] {
  const ids = gap.products
    .filter((p) => p.coverage === "partial" || p.productId === hostProductId)
    .map((p) => p.productId);
  if (hostProductId && !ids.includes(hostProductId)) ids.push(hostProductId);
  return [...new Set(ids)].sort();
}

// ─── Edge semantics ─────────────────────────────────────────────────────────

function oneOf<T extends string>(allowed: readonly T[], value: string | null): T | null {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

type EdgeRow = Pick<
  ProductEdgeRow,
  | "id"
  | "productId"
  | "edgeType"
  | "sourceRepoId"
  | "targetRepoId"
  | "resourceId"
  | "contractDocId"
  | "integrationKind"
  | "strength"
  | "direction"
  | "confidence"
  | "origin"
  | "evidence"
  | "sourceFile"
  | "targetFile"
>;

const EDGE_SELECT = {
  id: true,
  productId: true,
  edgeType: true,
  sourceRepoId: true,
  targetRepoId: true,
  resourceId: true,
  contractDocId: true,
  integrationKind: true,
  strength: true,
  direction: true,
  confidence: true,
  origin: true,
  evidence: true,
  sourceFile: true,
  targetFile: true,
} as const;

/**
 * #1668 — whether both ends of an edge write its table. `detectSharedTables`
 * records one edge between two writers, from the lower id, with one
 * `sql_table_write` evidence entry per end.
 */
function bothEndsWrite(evidence: string | null | undefined): boolean {
  if (!evidence) return false;
  return parseEvidence(evidence).filter((e) => e.pattern === "sql_table_write").length >= 2;
}

/** The provider -> consumer pairs a repo-to-repo edge carries impact along. */
export function edgeFlows(edge: {
  sourceRepoId: string;
  targetRepoId: string | null;
  direction: string | null;
  evidence?: string | null;
}): Array<{ provider: string; consumer: string }> {
  const target = edge.targetRepoId;
  if (target === null) return [];
  const sourceDepends = { provider: target, consumer: edge.sourceRepoId };
  const targetDepends = { provider: edge.sourceRepoId, consumer: target };
  switch (oneOf(PRODUCT_EDGE_DIRECTIONS, edge.direction)) {
    case "consumes":
    case "depends-on":
      return [sourceDepends];
    case "provides":
      return [targetDepends];
    case "writes":
      // Two writers of one table: either one's change reaches the other.
      return bothEndsWrite(edge.evidence) ? [targetDepends, sourceDepends] : [targetDepends];
    default:
      // `reads` (two readers share a table's model) or unclassified: both ways.
      return [targetDepends, sourceDepends];
  }
}

/** Whether a repo's edge to a resource alone makes it a provider of that resource. */
function providesResource(direction: string | null): boolean {
  const d = oneOf(PRODUCT_EDGE_DIRECTIONS, direction);
  return d === null || d === "writes" || d === "provides";
}

function strongerStrength(
  a: ProductCouplingStrength | null,
  b: ProductCouplingStrength | null,
): ProductCouplingStrength | null {
  if (a === null) return b;
  if (b === null) return a;
  return PRODUCT_COUPLING_STRENGTHS.indexOf(a) <= PRODUCT_COUPLING_STRENGTHS.indexOf(b) ? a : b;
}

interface Evidence {
  filePath?: unknown;
  lineNumber?: unknown;
  pattern?: unknown;
}

function parseEvidence(raw: string): Evidence[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Evidence[]) : [];
  } catch {
    return [];
  }
}

/** The consumer's side of an edge: its file, and the evidence lines in it. */
function callSitesOf(edge: EdgeRow, consumerIsSource: boolean): ImpactHop["callSites"] {
  const file = consumerIsSource ? edge.sourceFile : edge.targetFile;
  if (!file) return [];
  const lines = parseEvidence(edge.evidence)
    .filter((e) => e.filePath === file)
    .map((e) => ({
      filePath: file,
      line: typeof e.lineNumber === "number" ? e.lineNumber : null,
    }));
  return (lines.length > 0 ? lines : [{ filePath: file, line: null }]).slice(0, MAX_CALL_SITES);
}

// ─── Loading ────────────────────────────────────────────────────────────────

interface RepoInfo {
  projectId: string;
  label: string;
}

/**
 * #1692 — what a walk loads that does not depend on who reads it: a repo's
 * project and label, the products a repo is attached to, a resource. A second
 * walk over the same graph (`readingEverything`) shares it.
 */
interface GraphCache {
  repos: Map<string, RepoInfo | null>;
  productsOfRepo: Map<string, string[]>;
  resources: Map<string, { kind: string; name: string } | null>;
  /** #1724 — the product each resource belongs to. */
  resourceProduct: Map<string, string>;
  /** #1724 — each product's home workspace (`Product.workspaceId`), null for none. */
  workspaceOf: Map<string, string | null>;
}

function repoLabel(rc: { label: string; ownerOrOrg: string | null; repoName: string | null }) {
  if (rc.ownerOrOrg && rc.repoName) return `${rc.ownerOrOrg}/${rc.repoName}`;
  return rc.repoName ?? rc.label;
}

interface Candidate {
  edges: EdgeRow[];
  /** The edge whose strength, confidence and call site describe the consumer's side. */
  consumerEdge: EdgeRow;
  consumerIsSource: boolean;
  provider: string;
  consumer: string;
  strength: ProductCouplingStrength | null;
  confidence: number;
  resourceId: string | null;
}

/** Where a repo stands in the walk: the product it is affected as, and how badly. */
interface RepoState {
  productId: string;
  /** Null for a repo of a direct-change product. */
  severity: ChangeSeverity | null;
  hops: ImpactHop[];
}

function sortById<T extends { id: string }>(rows: T[]): T[] {
  return rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

class ImpactWalk {
  private readonly repos: GraphCache["repos"];
  private readonly productsOfRepo: GraphCache["productsOfRepo"];
  private readonly resources: GraphCache["resources"];
  private readonly resourceProduct: GraphCache["resourceProduct"];
  private readonly workspaceOf: GraphCache["workspaceOf"];
  // Contracts and shared tables depend on what the caller can read: never shared,
  // but a walk that reads everything reuses the contracts this one resolved (#1698).
  private readonly contracts = new Map<string, ImpactContractEvidence | null>();
  private readonly shared = new Map<string, CrossProjectImpactResult | null>();
  private readonly actor: SchedulerActor;

  constructor(
    private readonly user: AuthPayload,
    private readonly readableProducts: { has(productId: string): boolean },
    private readonly canReadRepo: (repo: { repoConnection: { projectId: string } }) => boolean,
    private readonly deps: Required<PortfolioImpactDeps>,
    private readonly graph: GraphCache = {
      repos: new Map(),
      productsOfRepo: new Map(),
      resources: new Map(),
      resourceProduct: new Map(),
      workspaceOf: new Map(),
    },
  ) {
    this.actor = { id: user.userId, role: user.role };
    this.repos = graph.repos;
    this.productsOfRepo = graph.productsOfRepo;
    this.resources = graph.resources;
    this.resourceProduct = graph.resourceProduct;
    this.workspaceOf = graph.workspaceOf;
  }

  /**
   * #1689 — the same graph as a caller able to read every product and repo
   * walks it. Every edge's product exists (a foreign key), so every product is
   * "readable". #1692 — it reuses what this walk loaded of the graph.
   */
  readingEverything(): ImpactWalk {
    const walk = new ImpactWalk(this.user, { has: () => true }, () => true, this.deps, this.graph);
    // #1698 — a contract this walk resolved is one whose repo it can read (or that
    // has none), so a walk that reads everything resolves it the same: reuse it. A
    // null may be one it could not read, so that one is loaded again.
    for (const [id, evidence] of this.contracts) {
      if (evidence !== null) walk.contracts.set(id, evidence);
    }
    return walk;
  }

  /** Load (once) the live connections of `ids`; a deleted or unknown one is null. */
  async loadRepos(ids: Iterable<string>): Promise<void> {
    const missing = [...new Set(ids)].filter((id) => !this.repos.has(id));
    if (missing.length === 0) return;
    // No `orderBy`/`take`: Prisma splits a plain `IN` list itself (#1346).
    const rows = await prisma.repoConnection.findMany({
      where: { id: { in: missing }, deletedAt: null },
      select: { id: true, projectId: true, label: true, ownerOrOrg: true, repoName: true },
    });
    for (const id of missing) this.repos.set(id, null);
    for (const r of rows) {
      this.repos.set(r.id, { projectId: r.projectId, label: repoLabel(r) });
    }
  }

  repo(id: string): RepoInfo | null {
    return this.repos.get(id) ?? null;
  }

  readableRepo(id: string): boolean {
    const repo = this.repo(id);
    return repo !== null && this.canReadRepo({ repoConnection: { projectId: repo.projectId } });
  }

  ref(id: string): ImpactRepoRef {
    return { repoConnectionId: id, label: this.repo(id)?.label ?? id };
  }

  /** Every product each repo is attached to (readable or not). */
  async loadProductsOf(repoIds: Iterable<string>): Promise<void> {
    const missing = [...new Set(repoIds)].filter((id) => !this.productsOfRepo.has(id));
    if (missing.length === 0) return;
    const rows = await prisma.productRepo.findMany({
      where: { repoConnectionId: { in: missing } },
      select: { productId: true, repoConnectionId: true },
    });
    for (const id of missing) this.productsOfRepo.set(id, []);
    for (const r of rows) this.productsOfRepo.get(r.repoConnectionId)!.push(r.productId);
    for (const id of missing) this.productsOfRepo.get(id)!.sort();
  }

  productsOf(repoId: string): string[] {
    return this.productsOfRepo.get(repoId) ?? [];
  }

  /**
   * Edges on readable products touching `repoIds` from either end, and resource
   * partners, with how many edges on products the caller cannot read were left out.
   * A partner is an edge to a resource alone through the same resource, or
   * (#1724) through a resource of the same kind and name on another product
   * homed in the same workspace. #1724 — an edge recorded on two products (a
   * cross-product edge, found by analysing either) is walked once.
   */
  async edgesTouching(repoIds: string[]): Promise<{ edges: EdgeRow[]; withheld: number }> {
    const [bySource, byTarget] = await Promise.all([
      prisma.productEdge.findMany({
        where: { sourceRepoId: { in: repoIds } },
        select: EDGE_SELECT,
      }),
      prisma.productEdge.findMany({
        where: { targetRepoId: { in: repoIds } },
        select: EDGE_SELECT,
      }),
    ]);
    const seen = new Map<string, EdgeRow>();
    const withheld = new Set<string>();
    for (const e of [...bySource, ...byTarget]) {
      if (this.readableProducts.has(e.productId)) seen.set(e.id, e);
      else withheld.add(e.id);
    }
    await this.loadResources(
      [...seen.values()].flatMap((e) => (e.resourceId ? [e.resourceId] : [])),
    );
    const resourceIds = [
      ...new Set(
        [...seen.values()].filter((e) => e.resourceId && !e.targetRepoId).map((e) => e.resourceId!),
      ),
    ];
    if (resourceIds.length > 0) {
      const partners = await prisma.productEdge.findMany({
        where: {
          resourceId: { in: [...resourceIds, ...(await this.twinResources(resourceIds))] },
          targetRepoId: null,
        },
        select: EDGE_SELECT,
      });
      // A partner pairs only with an edge it meets (`meetKey`). One on a product
      // the caller cannot read is never walked; #1724 — it is counted as left out,
      // since a resource it shares may reach what the caller cannot see.
      for (const e of partners) {
        if (this.readableProducts.has(e.productId)) seen.set(e.id, e);
        else withheld.add(e.id);
      }
    }
    const edges = [...seen.values()];
    await this.loadWorkspaces(edges.map((e) => e.productId));
    return { edges: this.oncePerCoupling(edges), withheld: withheld.size };
  }

  /**
   * #1724 — an edge recorded on two products (detection stores a cross-product
   * edge on whichever product it analyses) is one coupling: keep one per ends,
   * type and resource, preferring a person's classification, then one that
   * links a contract, then the lowest id. The rest are not walked.
   */
  private oncePerCoupling(edges: EdgeRow[]): EdgeRow[] {
    const rank = (e: EdgeRow) => (e.origin === "detected" ? 2 : 0) + (e.contractDocId ? 0 : 1);
    const kept = new Map<string, EdgeRow>();
    for (const e of sortById(edges)) {
      const key = [e.sourceRepoId, e.targetRepoId ?? "", e.edgeType, this.meetKey(e) ?? ""].join(
        "\u0000",
      );
      const prior = kept.get(key);
      if (!prior || rank(e) < rank(prior)) kept.set(key, e);
    }
    return sortById([...kept.values()]);
  }

  /**
   * #1724 — where an edge through a resource meets other edges: the resource's
   * kind and name in its product's home workspace, so two products of one
   * workspace that each record the same topic or table meet there. A resource of
   * a product with no home, or one not of the edge's own product, meets only
   * edges of that product through that very resource (the rule before #1724).
   */
  meetKey(e: Pick<EdgeRow, "productId" | "resourceId">): string | null {
    if (!e.resourceId) return null;
    const resource = this.resource(e.resourceId);
    const workspace = this.workspaceOf.get(e.productId) ?? null;
    if (resource && workspace && this.resourceProduct.get(e.resourceId) === e.productId) {
      return `workspace:${workspace}\u0000${resource.kind}\u0000${resource.name}`;
    }
    return `product:${e.productId}\u0000${e.resourceId}`;
  }

  /**
   * #1724 — the resources of the same kind and name as `resourceIds` on the
   * other products homed in the same workspace as each one's product.
   */
  private async twinResources(resourceIds: string[]): Promise<string[]> {
    await this.loadWorkspaces(resourceIds.flatMap((id) => this.resourceProduct.get(id) ?? []));
    const wanted = new Set<string>();
    for (const id of resourceIds) {
      const resource = this.resource(id);
      const workspace = this.workspaceOf.get(this.resourceProduct.get(id) ?? "") ?? null;
      if (resource && workspace) wanted.add(twinKey(workspace, resource.kind, resource.name));
    }
    if (wanted.size === 0) return [];
    const parts = [...wanted].map((k) => k.split("\u0000"));
    // `IN` lists, not an `OR` of triples: Prisma splits a long `IN` itself (#1346).
    const rows = await prisma.productResource.findMany({
      where: {
        id: { notIn: resourceIds },
        kind: { in: [...new Set(parts.map((p) => p[1]))] },
        name: { in: [...new Set(parts.map((p) => p[2]))] },
        product: { workspaceId: { in: [...new Set(parts.map((p) => p[0]))] } },
      },
      select: {
        id: true,
        productId: true,
        kind: true,
        name: true,
        product: { select: { workspaceId: true } },
      },
    });
    const twins: string[] = [];
    for (const r of rows) {
      if (!r.product.workspaceId) continue;
      if (!wanted.has(twinKey(r.product.workspaceId, r.kind, r.name))) continue;
      this.resources.set(r.id, { kind: r.kind, name: r.name });
      this.resourceProduct.set(r.id, r.productId);
      this.workspaceOf.set(r.productId, r.product.workspaceId);
      twins.push(r.id);
    }
    return twins;
  }

  /** Load (once) the home workspace of each product. */
  private async loadWorkspaces(productIds: Iterable<string>): Promise<void> {
    const missing = [...new Set(productIds)].filter((id) => !this.workspaceOf.has(id));
    if (missing.length === 0) return;
    const rows = await prisma.product.findMany({
      where: { id: { in: missing } },
      select: { id: true, workspaceId: true },
    });
    for (const id of missing) this.workspaceOf.set(id, null);
    for (const p of rows) this.workspaceOf.set(p.id, p.workspaceId);
  }

  async loadResources(ids: Iterable<string>): Promise<void> {
    const missing = [...new Set(ids)].filter((id) => !this.resources.has(id));
    if (missing.length === 0) return;
    const rows = await prisma.productResource.findMany({
      where: { id: { in: missing } },
      select: { id: true, kind: true, name: true, productId: true },
    });
    for (const id of missing) this.resources.set(id, null);
    for (const r of rows) {
      this.resources.set(r.id, { kind: r.kind, name: r.name });
      this.resourceProduct.set(r.id, r.productId);
    }
  }

  resource(id: string | null): { kind: string; name: string } | null {
    return id ? (this.resources.get(id) ?? null) : null;
  }

  /**
   * The provider's contract an edge crosses, as its latest version changed it.
   * The contract must be the edge's own product's, of a repo the caller can read.
   */
  async contract(edge: EdgeRow): Promise<ImpactContractEvidence | null> {
    const id = edge.contractDocId;
    if (!id) return null;
    if (this.contracts.has(id)) return this.contracts.get(id)!;
    let evidence: ImpactContractEvidence | null = null;
    const doc = await prisma.productContractDoc.findFirst({
      where: { id, productId: edge.productId },
      select: { productId: true, repoId: true },
    });
    // #1668 — the contract's repo need not be an end of the edge: load it to check it.
    if (doc?.repoId) await this.loadRepos([doc.repoId]);
    if (doc && (doc.repoId === null || this.readableRepo(doc.repoId))) {
      const latest = await prisma.productContractDoc.findFirst({
        where: { productId: doc.productId, repoId: doc.repoId },
        orderBy: { version: "desc" },
        select: { id: true, version: true, diff: true },
      });
      if (latest) evidence = contractEvidence(latest, doc.repoId);
    }
    this.contracts.set(id, evidence);
    return evidence;
  }

  /** The tables and columns both projects use, from the provider project's cross-project impact. */
  async sharedObjects(
    providerProjectId: string,
    consumerProjectId: string,
    resource: { kind: string; name: string } | null,
  ): Promise<ImpactSharedObject[]> {
    if (providerProjectId === consumerProjectId) return [];
    if (!this.shared.has(providerProjectId)) {
      let result: CrossProjectImpactResult | null = null;
      try {
        result = await this.deps.sharedObjects(this.actor, providerProjectId);
      } catch (err) {
        log.warn("Cross-project usage unavailable for an impact hop", {
          projectId: providerProjectId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this.shared.set(providerProjectId, result);
    }
    const result = this.shared.get(providerProjectId);
    if (!result) return [];
    const table = resource?.kind === "table" ? resource.name.toLowerCase() : null;
    const seen = new Set<string>();
    return result.affectedObjects
      .flatMap((o) => {
        // A table and its columns arrive as one object each; one of each kind is enough.
        const key = `${o.schemaName ?? ""}.${o.objectName}:${o.objectType}`;
        if (seen.has(key)) return [];
        seen.add(key);
        const usage = o.alsoUsedByProjects.find((u) => u.projectId === consumerProjectId);
        if (!usage) return [];
        const qualified = (
          o.schemaName ? `${o.schemaName}.${o.objectName}` : o.objectName
        ).toLowerCase();
        if (table && qualified !== table && o.objectName.toLowerCase() !== table) return [];
        return [
          {
            schemaName: o.schemaName,
            objectName: o.objectName,
            objectType: o.objectType,
            usageClass: usage.usageClass,
          },
        ];
      })
      .slice(0, MAX_SHARED_OBJECTS);
  }
}

function contractEvidence(
  latest: { id: string; version: number; diff: string | null },
  repoConnectionId: string | null,
): ImpactContractEvidence {
  let diff: Pick<ContractDiff, "added" | "removed" | "changed"> = {
    added: [],
    removed: [],
    changed: [],
  };
  try {
    const parsed = latest.diff ? (JSON.parse(latest.diff) as Partial<ContractDiff>) : null;
    if (parsed) {
      diff = {
        added: Array.isArray(parsed.added) ? (parsed.added as ContractItem[]) : [],
        removed: Array.isArray(parsed.removed) ? (parsed.removed as ContractItem[]) : [],
        changed: Array.isArray(parsed.changed) ? (parsed.changed as ChangedItem[]) : [],
      };
    }
  } catch {
    // An unreadable diff says nothing changed, so it never raises a severity.
  }
  const items: ImpactContractItem[] = [
    ...diff.removed.map((i) => ({ id: i.id, change: "removed" as const, breaking: true })),
    ...diff.changed.map((i) => ({
      id: i.id,
      change: "changed" as const,
      breaking: isBreakingChange(i),
    })),
    ...diff.added.map((i) => ({ id: i.id, change: "added" as const, breaking: false })),
  ];
  return {
    contractDocId: latest.id,
    repoConnectionId,
    version: latest.version,
    breaking: isBreakingDiff(diff),
    items: items.slice(0, MAX_CONTRACT_ITEMS),
  };
}

function twinKey(workspaceId: string, kind: string, name: string): string {
  return `${workspaceId}\u0000${kind}\u0000${name}`;
}

/**
 * The provider -> consumer hops the edges carry from repos in `frontier`.
 * `meetKey` says where an edge through a resource meets the others (#1724).
 */
function candidatesFrom(
  edges: EdgeRow[],
  frontier: ReadonlyMap<string, RepoState>,
  meetKey: (e: EdgeRow) => string | null,
): Candidate[] {
  const out: Candidate[] = [];
  const strength = (e: EdgeRow) => oneOf(PRODUCT_COUPLING_STRENGTHS, e.strength);
  for (const e of edges) {
    for (const flow of edgeFlows(e)) {
      if (!frontier.has(flow.provider)) continue;
      out.push({
        edges: [e],
        consumerEdge: e,
        consumerIsSource: flow.consumer === e.sourceRepoId,
        provider: flow.provider,
        consumer: flow.consumer,
        strength: strength(e),
        confidence: e.confidence,
        resourceId: e.resourceId,
      });
    }
  }
  // Two edges meeting at a resource: a provider of it reaches every other user.
  // #1724 — the resource of one product, or one of the same kind and name on
  // two products homed in one workspace (`meetKey`).
  const atResource = edges.filter((e) => e.resourceId && e.targetRepoId === null);
  for (const a of atResource) {
    if (!frontier.has(a.sourceRepoId) || !providesResource(a.direction)) continue;
    for (const b of atResource) {
      if (b.id === a.id || meetKey(b) !== meetKey(a)) continue;
      if (b.sourceRepoId === a.sourceRepoId) continue;
      out.push({
        edges: [a, b],
        consumerEdge: b,
        consumerIsSource: true,
        provider: a.sourceRepoId,
        consumer: b.sourceRepoId,
        strength: strongerStrength(strength(a), strength(b)),
        confidence: Math.min(a.confidence, b.confidence),
        resourceId: a.resourceId,
      });
    }
  }
  return out;
}

// ─── Engine ─────────────────────────────────────────────────────────────────

function emptyImpact(productId: string, name: string | null, restricted: boolean): ProductImpact {
  return {
    productId,
    name: restricted ? null : name,
    restricted,
    impactKind: "none",
    via: null,
    severity: null,
    edgeIds: [],
    hops: [],
    hiddenEdgeCount: 0,
  };
}

interface WalkOptions {
  /**
   * Whether hops carry the shared tables and columns, and the contract of a hop
   * past the first. Neither changes the severity, so the reachability-only walk
   * (`reachedReadingEverything`) loads neither (#1692). A first hop's contract
   * is always loaded (#1695): it can raise that hop's severity, and severity can
   * change reach, since the more severe state of a repo decides which product
   * it is walked as, and so which moves from it are free.
   */
  withEvidence: boolean;
  /** Stop as soon as this holds, checked before each step (#1692). */
  done?: () => boolean;
}

interface WalkOutcome {
  /** The restricted products the walk stopped at (`entry(id).restricted`). */
  stoppedAt: Set<string>;
  /**
   * #1692 — whether the walk left anything out that a walk able to read
   * everything would follow: a restricted product it stopped at, a repo of a
   * direct-change product it cannot read, or an edge it cannot walk (to a live
   * repo it cannot read, or recorded on a product it cannot read). When nothing
   * was, that walk takes exactly the same steps, and reaches nothing more. An
   * edge to a deleted repo is no such edge: neither walk follows it (#1695).
   */
  leftOut: boolean;
}

/**
 * Walk the product graph from the readable repos of the `direct` products to
 * `maxDepth`, recording on `entry` every product reached.
 */
async function walkFrom(
  walk: ImpactWalk,
  direct: readonly string[],
  maxDepth: number,
  entry: (productId: string) => ProductImpact,
  { withEvidence, done = () => false }: WalkOptions,
): Promise<WalkOutcome> {
  const directSet = new Set(direct);
  let leftOut = false;
  let frontier = new Map<string, RepoState>();
  if (direct.length > 0) {
    const rows = await prisma.productRepo.findMany({
      where: { productId: { in: [...direct] }, repoConnection: { deletedAt: null } },
      select: { productId: true, repoConnectionId: true },
    });
    await walk.loadRepos(rows.map((r) => r.repoConnectionId));
    for (const r of rows.sort((a, b) =>
      a.productId === b.productId
        ? a.repoConnectionId.localeCompare(b.repoConnectionId)
        : a.productId.localeCompare(b.productId),
    )) {
      if (!walk.readableRepo(r.repoConnectionId)) {
        leftOut = true;
        continue;
      }
      if (frontier.has(r.repoConnectionId)) continue;
      frontier.set(r.repoConnectionId, { productId: r.productId, severity: null, hops: [] });
    }
  }

  /** The most severe state each repo has been expanded with. */
  const expanded = new Map<string, ChangeSeverity | null>(
    [...frontier.keys()].map((id) => [id, null]),
  );
  const hiddenCounted = new Set<string>();
  /** #1668 — the restricted products the walk reached, and so did not walk through. */
  const stoppedAt = new Set<string>();
  /** Queue `repoId` in `queue` only when `state` is more severe than any state before it. */
  const offer = (queue: Map<string, RepoState>, repoId: string, state: RepoState) => {
    const better = (s: ChangeSeverity | null | undefined) =>
      s === undefined || (s !== null && state.severity !== null && moreSevere(state.severity, s));
    if (better(expanded.get(repoId)) && better(queue.get(repoId)?.severity)) {
      queue.set(repoId, state);
    }
  };

  for (let depth = 1; depth <= maxDepth && frontier.size > 0 && !done(); depth += 1) {
    const next = new Map<string, RepoState>();
    // #1668 — an edge between two repos of one product moves the change inside
    // it and crosses no product boundary, so it costs no depth: the repos it
    // reaches are walked from at this depth too, until none is left.
    for (let level = frontier; level.size > 0 && !done();) {
      const within = new Map<string, RepoState>();
      const { edges, withheld } = await walk.edgesTouching([...level.keys()]);
      if (withheld > 0) leftOut = true;
      await walk.loadRepos(
        edges.flatMap((e) => [e.sourceRepoId, e.targetRepoId ?? e.sourceRepoId]),
      );
      const readable: EdgeRow[] = [];
      for (const e of edges) {
        const ends = [e.sourceRepoId, ...(e.targetRepoId ? [e.targetRepoId] : [])];
        if (ends.every((id) => walk.readableRepo(id))) {
          readable.push(e);
          continue;
        }
        // #1695 — a walk able to read everything still cannot follow it to a deleted
        // repo, so it leaves nothing out; #1698 — nor is it a link to a repo the caller
        // cannot read, so it is not counted either.
        if (!ends.every((id) => walk.repo(id) !== null)) continue;
        leftOut = true;
        // Not walked; counted once on the product it leaves, if it leaves the frontier.
        const from = ends.find((id) => level.has(id));
        if (from && !hiddenCounted.has(e.id)) {
          hiddenCounted.add(e.id);
          entry(level.get(from)!.productId).hiddenEdgeCount += 1;
        }
      }
      const candidates = candidatesFrom(readable, level, (e) => walk.meetKey(e));
      await Promise.all([
        walk.loadProductsOf(candidates.map((c) => c.consumer)),
        walk.loadResources(candidates.flatMap((c) => (c.resourceId ? [c.resourceId] : []))),
      ]);

      for (const c of candidates) {
        const from = level.get(c.provider)!;
        // `from.hops.length === 0`: the hop leaves a direct-change product's repo
        // (see `breakingContract` below), the one hop a contract can raise (#1695).
        const contract =
          withEvidence || from.hops.length === 0 ? await walk.contract(c.consumerEdge) : null;
        const hopSeverity = deriveHopSeverity({
          strength: c.strength,
          // Only from a direct-change product's repo is the provider's contract
          // the one changing; further out it is cited, not counted. And only the
          // provider's own contract (#1668): an edge may name the consumer's.
          // `from.hops.length === 0` is the same test as `depth === 1`: a
          // direct-change product's repos are never re-entered, so every repo
          // walked from at a later depth carries at least one hop.
          breakingContract:
            from.hops.length === 0 &&
            contract?.breaking === true &&
            contract.repoConnectionId === c.provider,
          confidence: c.confidence,
        });
        const severity =
          from.severity === null
            ? hopSeverity.severity
            : weaker(from.severity, hopSeverity.severity);
        const resource = walk.resource(c.resourceId);
        const integrationKind = oneOf(PRODUCT_INTEGRATION_KINDS, c.consumerEdge.integrationKind);
        const providerRepo = walk.repo(c.provider)!;
        const consumerRepo = walk.repo(c.consumer)!;
        const sharedObjects =
          withEvidence && integrationKind === "database"
            ? await walk.sharedObjects(providerRepo.projectId, consumerRepo.projectId, resource)
            : [];
        const hopTo = (toProductId: string): ImpactHop => ({
          edgeIds: c.edges.map((e) => e.id),
          edgeProductId: c.consumerEdge.productId,
          fromProductId: from.productId,
          toProductId,
          provider: walk.ref(c.provider),
          consumer: walk.ref(c.consumer),
          integrationKind,
          strength: c.strength,
          direction: oneOf(PRODUCT_EDGE_DIRECTIONS, c.consumerEdge.direction),
          confidence: c.confidence,
          origin: oneOf(PRODUCT_EDGE_ORIGINS, c.consumerEdge.origin) ?? "detected",
          resource,
          callSites: callSitesOf(c.consumerEdge, c.consumerIsSource),
          contract,
          sharedObjects,
          severity: hopSeverity,
        });
        for (const productId of walk.productsOf(c.consumer)) {
          // Every readable repo of a direct-change product is walked from already.
          if (directSet.has(productId)) continue;
          if (productId === from.productId) {
            // #1668 — inside the product the change came from: not listed again,
            // but the walk goes on from this repo.
            offer(within, c.consumer, {
              productId,
              severity,
              hops: [...from.hops, hopTo(productId)],
            });
            continue;
          }
          const target = entry(productId);
          if (target.restricted) {
            // Downstream, and nothing more: no path, no severity, never walked through.
            target.impactKind = "downstream-consumer";
            stoppedAt.add(productId);
            continue;
          }
          const hops = [...from.hops, hopTo(productId)];
          if (
            target.impactKind !== "downstream-consumer" ||
            target.severity === null ||
            moreSevere(severity, target.severity)
          ) {
            Object.assign(target, {
              impactKind: "downstream-consumer",
              via: integrationKind,
              severity,
              edgeIds: hops.flatMap((h) => h.edgeIds),
              hops,
            });
          }
          // Walk on from the consumer repo only when this path is more severe than any before.
          offer(next, c.consumer, { productId, severity, hops });
        }
      }
      for (const [id, state] of within) expanded.set(id, state.severity);
      level = within;
    }
    for (const [id, state] of next) expanded.set(id, state.severity);
    frontier = next;
  }
  return { stoppedAt, leftOut: leftOut || stoppedAt.size > 0 };
}

/**
 * #1689 — which of `wanted` a walk that can read every product and repo
 * reaches from `direct`, to the same `maxDepth`: the walk the reader's would be
 * had nothing been hidden from them, so it reaches exactly what theirs would
 * past everything left out, and nothing it would not. Only the set of product
 * ids leaves this function: nothing it reads is shown to the caller. #1692 — it
 * reuses what the reader's walk loaded of the graph, loads no shared tables and
 * no contract past a first hop (#1695), and stops once it has reached every
 * product in `wanted`.
 */
async function reachedReadingEverything(
  readerWalk: ImpactWalk,
  direct: readonly string[],
  maxDepth: number,
  wanted: readonly string[],
): Promise<Set<string>> {
  const walk = readerWalk.readingEverything();
  const out = new Map<string, ProductImpact>();
  const entry = (productId: string): ProductImpact => {
    let hit = out.get(productId);
    if (!hit) {
      hit = emptyImpact(productId, null, false);
      out.set(productId, hit);
    }
    return hit;
  };
  const reached = (id: string) => out.get(id)?.impactKind === "downstream-consumer";
  await walkFrom(walk, direct, maxDepth, entry, {
    withEvidence: false,
    done: () => wanted.every(reached),
  });
  const found = wanted.filter(reached);
  // #1695 — counts only, to measure how often the early stop fails to trigger
  // (`allReached: false` means the walk went on to `maxDepth`).
  log.info("Restricted relabel: comparison walk", {
    maxDepth,
    wanted: wanted.length,
    reached: found.length,
    allReached: found.length === wanted.length,
  });
  return new Set(found);
}

/**
 * Walk the product graph from the direct-change products and classify every
 * product reached, and every product listed, by how the change reaches it.
 */
export async function evaluatePortfolioImpact(
  user: AuthPayload,
  input: PortfolioImpactInput,
  deps: PortfolioImpactDeps = {},
): Promise<PortfolioImpactResult> {
  const maxDepth = Math.min(
    MAX_IMPACT_DEPTH,
    Math.max(1, Math.floor(input.maxDepth ?? DEFAULT_IMPACT_DEPTH)),
  );
  const [productRows, canReadRepo] = await Promise.all([
    prisma.product.findMany({
      where: await buildProductAccessWhere(user),
      select: { id: true, name: true },
    }),
    productRepoReadAccess(user),
  ]);
  const readableProducts = new Map(productRows.map((p) => [p.id, p.name]));
  const walkDeps: Required<PortfolioImpactDeps> = {
    sharedObjects:
      deps.sharedObjects ?? ((actor, projectId) => crossProjectImpact(actor, projectId)),
  };
  const walk = new ImpactWalk(user, readableProducts, canReadRepo, walkDeps);

  const out = new Map<string, ProductImpact>();
  const entry = (productId: string): ProductImpact => {
    let hit = out.get(productId);
    if (!hit) {
      const readable = readableProducts.has(productId);
      hit = emptyImpact(productId, readableProducts.get(productId) ?? null, !readable);
      out.set(productId, hit);
    }
    return hit;
  };
  for (const id of input.listedProductIds ?? []) entry(id);

  // A product the caller cannot read is not walked from: it stays as listed.
  const direct = [...new Set(input.directChangeProductIds)]
    .filter((id) => readableProducts.has(id))
    .sort();
  for (const id of direct) entry(id).impactKind = "direct-change";

  const { stoppedAt, leftOut } = await walkFrom(walk, direct, maxDepth, entry, {
    withEvidence: true,
  });

  // #1673 (owner decision on #1668 AC3) — past a restricted product the walk
  // was not followed, so a readable product it did not reach may be reached
  // through one: it reads `restricted`, never "not affected". #1689 — exactly
  // the products a walk that can read everything reaches (same start, same
  // `maxDepth`); every other one stays `none`. #1692 — a repo or an edge the
  // walk could not read counts as a restricted product does, so a path reads
  // the same whether or not the walk also stopped somewhere else.
  const unreached = [...out.values()].filter((p) => !p.restricted && p.impactKind === "none");
  if (leftOut && unreached.length > 0) {
    const reached = await reachedReadingEverything(
      walk,
      direct,
      maxDepth,
      unreached.map((p) => p.productId),
    );
    for (const p of unreached) if (reached.has(p.productId)) p.impactKind = "restricted";
  }

  return {
    maxDepth,
    stoppedAtRestricted: stoppedAt.size,
    products: [...out.values()].sort((a, b) => a.productId.localeCompare(b.productId)),
  };
}

// ─── Persisting ─────────────────────────────────────────────────────────────

/** The stored impact detail of a readable product (`technicalDetail.impact`). */
export function impactDetail(
  p: ProductImpact,
  impact: Pick<PortfolioImpactResult, "maxDepth" | "stoppedAtRestricted">,
): Record<string, unknown> {
  return {
    maxDepth: impact.maxDepth,
    severity: p.severity,
    // The path's severity is its weakest hop; each hop records its own derivation.
    severityRule: "weakest-hop",
    hiddenEdgeCount: p.hiddenEdgeCount,
    // #1668 — the walk stopped at this many restricted products.
    ...(impact.stoppedAtRestricted > 0 ? { stoppedAtRestricted: impact.stoppedAtRestricted } : {}),
    // #1689 — only a product a walk able to read everything reaches was
    // relabelled, so a `none` here is the walk's. #1692 — on every row: a run
    // that stopped nowhere relabels too. `adjacent` is the older rule (#1680, #1685).
    restrictedRule: "walk",
    hops: p.hops,
  };
}

/**
 * A gap assessment's record with the impact added: each product row in scope
 * gets its impact kind, path and severity, and each product reached outside the
 * scope gets a row of its own (`not-checked`, or `restricted`), which never
 * enters the portfolio verdict. A restricted product carries nothing but its
 * id, `restricted` and its impact kind.
 */
export function withImpact(
  input: PortfolioAssessmentInput,
  impact: PortfolioImpactResult,
): PortfolioAssessmentInput {
  const byProduct = new Map(impact.products.map((p) => [p.productId, p]));
  const fields = (p: ProductImpact) =>
    p.restricted
      ? { impactKind: p.impactKind, via: null, edgeIds: [], severity: null }
      : { impactKind: p.impactKind, via: p.via, edgeIds: p.edgeIds, severity: p.severity };
  const products = (input.products ?? []).map((row) => {
    const p = byProduct.get(row.productId);
    if (!p) return row;
    const restricted = p.restricted || row.coverage === "restricted";
    return {
      ...row,
      ...fields({ ...p, restricted }),
      ...(restricted
        ? {}
        : {
            technicalDetail: {
              ...(row.technicalDetail ?? {}),
              impact: impactDetail(p, impact),
            },
          }),
    };
  });
  const listed = new Set(products.map((r) => r.productId));
  for (const p of impact.products) {
    if (listed.has(p.productId) || p.impactKind !== "downstream-consumer") continue;
    products.push({
      productId: p.productId,
      coverage: p.restricted ? "restricted" : "not-checked",
      ...fields(p),
      baSummary: p.restricted ? "" : impactSentence(p),
      technicalDetail: p.restricted ? {} : { outOfScope: true, impact: impactDetail(p, impact) },
    });
  }
  return { ...input, products };
}
