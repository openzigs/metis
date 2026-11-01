/**
 * Epic #1608 (#1625) — a portfolio assessment as one reader may see it.
 *
 * An assessment is written once, with what its starter could read. Access
 * changes afterwards, and a second reader may see less. So nothing stored is
 * trusted at read time: every read re-filters against the reader's access now.
 *
 * - **Who may read it at all.** An admin; otherwise a reader who could start
 *   the same assessment: one who can read its source project (the requirement
 *   it came from lives there), and who started it or can read at least one of
 *   its products. Anyone else gets `null`, which the route answers 404.
 * - **A product the reader cannot read now** is `restricted`: its id, and
 *   nothing else (no summary, no detail, no repos, no citations).
 * - **A repo the reader cannot read now** (#1258) is dropped, with its
 *   citations, and its product's coverage is recomputed from the repos left,
 *   with the dropped ones counted hidden (so it cannot read `not-covered`).
 * - **When the reader sees less than the run did**, the portfolio verdict and
 *   summary are recomputed from what the reader sees; otherwise the stored ones
 *   stand.
 */
import { z } from "zod";
import {
  FINDING_VERDICTS,
  REQUIREMENT_VERDICTS,
  type AuthPayload,
  type CodeCitation,
  type PortfolioAssessment,
  type PortfolioAssessmentListItem,
  type PortfolioAssessmentView,
} from "@metis/shared";
import { prisma } from "../prisma.js";
import { buildProductAccessWhere, productRepoReadAccess } from "../products/product-access.js";
import { canAccessProjectDiscussions } from "../discussions/access.js";
import { getPortfolioAssessment } from "./assessment-store.js";
import { impactOverview, impactSentence } from "./report-overview.js";
import {
  portfolioSummary,
  toProductRecord,
  type PortfolioProductResult,
  type PortfolioRepoResult,
} from "./gap-engine.js";
import {
  portfolioVerdictFromStored,
  rollUpPortfolioVerdict,
  rollUpProductCoverage,
  storedPortfolioVerdict,
} from "./gap-rollup.js";

/** What one reader can read now, resolved once per request. */
export interface ReaderAccess {
  user: AuthPayload;
  admin: boolean;
  /**
   * Readable product id → name. Empty for an admin, who reads every product:
   * a view loads the names of its own products instead (#1657).
   */
  products: Map<string, string>;
  canReadRepo: (repo: { repoConnection: { projectId: string } }) => boolean;
  canReadProject: (projectId: string) => Promise<boolean>;
}

export async function resolveReaderAccess(user: AuthPayload): Promise<ReaderAccess> {
  const admin = user.role === "admin";
  const [rows, canReadRepo] = await Promise.all([
    // #1657 — an admin reads every product, so listing them all is only cost.
    admin
      ? Promise.resolve([])
      : prisma.product.findMany({
          // Binds the caller's workspace ids only, never a product or project list.
          where: await buildProductAccessWhere(user),
          select: { id: true, name: true },
        }),
    productRepoReadAccess(user),
  ]);
  const projects = new Map<string, Promise<boolean>>();
  return {
    user,
    admin,
    products: new Map(rows.map((r) => [r.id, r.name])),
    canReadRepo,
    canReadProject: (projectId) => {
      let hit = projects.get(projectId);
      if (!hit) {
        hit = canAccessProjectDiscussions({ id: user.userId, role: user.role }, projectId);
        projects.set(projectId, hit);
      }
      return hit;
    },
  };
}

/**
 * Whether the reader could start this assessment with the same scope.
 *
 * #1657 — only a product the run could read makes another reader one of its
 * readers. A `restricted` row (and the `productIds` entry behind it) is only an
 * id the starter supplied for a product they could not read: counting it let a
 * user in one workspace name another workspace's product and show that
 * workspace's readers their statement. So an assessment with no readable
 * product row yet (`pending`, `running`, `failed`) is its starter's alone.
 */
async function mayRead(access: ReaderAccess, a: PortfolioAssessment): Promise<boolean> {
  if (access.admin) return true;
  if (a.sourceProjectId && !(await access.canReadProject(a.sourceProjectId))) return false;
  if (a.createdById === access.user.userId) return true;
  // Only the products it was scoped to, and only rows its starter could read
  // (#1657): reading a product the impact walk reached downstream (#1623) is
  // not enough to have started it.
  const scoped = new Set(a.productIds);
  return a.products.some(
    (p) =>
      p.coverage !== "restricted" && scoped.has(p.productId) && access.products.has(p.productId),
  );
}

const storedDetailSchema = z.object({
  reason: z.enum(["no-repos", "repos-restricted", "could-not-verify"]).nullable(),
  criteria: z.array(z.object({ criterion: z.string(), coveredBy: z.array(z.string()) })),
  repos: z.array(
    z.object({
      repoConnectionId: z.string(),
      label: z.string(),
      verdict: z.enum(REQUIREMENT_VERDICTS),
      criteria: z.array(z.enum(FINDING_VERDICTS)),
      reason: z
        .enum(["no-evidence-retrieved", "retrieval-failed", "budget", "model-error"])
        .nullable(),
      costUsd: z.number(),
    }),
  ),
  inaccessibleRepoCount: z.number().int().min(0),
  costUsd: z.number(),
});

type StoredProduct = PortfolioAssessment["products"][number];

/**
 * A product the reader cannot read: its id, and (#1623) whether the change
 * reaches it — the one fact a restricted row exists to carry. Nothing else.
 */
function restrictedRecord(
  productId: string,
  impactKind: StoredProduct["impactKind"] = "none",
): StoredProduct {
  return {
    productId,
    coverage: "restricted",
    impactKind,
    via: null,
    edgeIds: [],
    severity: null,
    baSummary: "",
    technicalDetail: {},
  };
}

/** The repos and products a stored impact path (#1623) names. */
function impactReferences(stored: StoredProduct): { repos: string[]; products: string[] } {
  const impact = (stored.technicalDetail as { impact?: { hops?: unknown } }).impact;
  const hops = Array.isArray(impact?.hops) ? (impact.hops as Array<Record<string, unknown>>) : [];
  const repos: string[] = [];
  const products: string[] = [];
  const str = (v: unknown) => (typeof v === "string" ? [v] : []);
  for (const h of hops) {
    for (const end of [h.provider, h.consumer]) {
      repos.push(...str((end as { repoConnectionId?: unknown } | null)?.repoConnectionId));
    }
    repos.push(...str((h.contract as { repoConnectionId?: unknown } | null)?.repoConnectionId));
    products.push(...str(h.edgeProductId), ...str(h.fromProductId), ...str(h.toProductId));
  }
  return { repos, products };
}

/**
 * #1668 — how many restricted products the run's walk stopped at, as an earlier
 * run stored it on a readable row (`technicalDetail.impact.stoppedAtRestricted`).
 */
function stoppedAtRestricted(stored: StoredProduct): number {
  const impact = (
    stored.technicalDetail as {
      impact?: { stoppedAtRestricted?: unknown; restrictedRule?: unknown };
    }
  ).impact;
  // #1680 — a run that relabelled only the products next to a restricted one
  // says so; its `none` is the walk's answer and is not relabelled again.
  if (impact?.restrictedRule === "adjacent") return 0;
  const n = impact?.stoppedAtRestricted;
  return typeof n === "number" && n > 0 ? n : 0;
}

/**
 * #1623 — a product's impact as the reader may see it. A path through a repo or
 * a product the reader cannot read now is withheld whole (its edges, severity
 * and hops would describe what they cannot see), and (#1673) its impact reads
 * `restricted`: it is reached only through what this reader cannot see. Nothing
 * restates the path either (#1668): an out-of-scope row's summary is its impact
 * sentence, rebuilt here from the withheld fields.
 *
 * #1673 — a row an earlier run stored `none` after its walk stopped at a
 * restricted product reads `restricted` too. #1680 — a run now relabels only
 * the products next to the one it stopped at, and marks its rows so
 * (`restrictedRule: "adjacent"`); those are read as stored.
 */
function readableImpact(
  stored: StoredProduct,
  keepRepo: (repoConnectionId: string) => boolean,
  readableProduct: (productId: string) => boolean,
): StoredProduct {
  const refs = impactReferences(stored);
  if (refs.repos.every(keepRepo) && refs.products.every(readableProduct)) {
    return stored.impactKind === "none" && stoppedAtRestricted(stored) > 0
      ? { ...stored, impactKind: "restricted" }
      : stored;
  }
  const detail: Record<string, unknown> = { ...stored.technicalDetail };
  delete detail.impact;
  const withheld = {
    impactKind:
      stored.impactKind === "downstream-consumer" ? ("restricted" as const) : stored.impactKind,
    via: null,
    edgeIds: [],
    severity: null,
  };
  return {
    ...stored,
    ...withheld,
    ...(detail.outOfScope === true ? { baSummary: impactSentence(withheld) } : {}),
    technicalDetail: { ...detail, impactWithheld: true },
  };
}

/** A stored product as a result, keeping only the repos `keep` admits. */
function asResult(
  stored: StoredProduct,
  name: string | null,
  citations: ReadonlyMap<string, CodeCitation[]>,
  keep: (repoConnectionId: string) => boolean,
): { result: PortfolioProductResult; criteria: string[] } | null {
  if (stored.coverage === "restricted") {
    return {
      result: {
        productId: stored.productId,
        name: null,
        coverage: "restricted",
        reason: null,
        repos: [],
        criteriaCoveredBy: [],
        inaccessibleRepoCount: 0,
        costUsd: 0,
      },
      criteria: [],
    };
  }
  const parsed = storedDetailSchema.safeParse(stored.technicalDetail);
  if (!parsed.success) return null;
  const d = parsed.data;
  const repos: PortfolioRepoResult[] = d.repos
    .filter((r) => keep(r.repoConnectionId))
    .map((r) => ({
      productId: stored.productId,
      repoConnectionId: r.repoConnectionId,
      label: r.label,
      verdict: r.verdict,
      criteria: r.criteria,
      citations: citations.get(r.repoConnectionId) ?? [],
      reason: r.reason,
      costUsd: r.costUsd,
    }));
  const dropped = d.repos.length - repos.length;
  const criteria = d.criteria.map((c) => c.criterion);
  const hidden = d.inaccessibleRepoCount + dropped;
  const recomputed = dropped > 0 ? rollUpProductCoverage(repos, criteria.length, hidden) : null;
  return {
    result: {
      productId: stored.productId,
      name,
      coverage: recomputed?.coverage ?? stored.coverage,
      reason: recomputed ? recomputed.reason : d.reason,
      repos,
      criteriaCoveredBy: d.criteria.map((c) => c.coveredBy.filter(keep)),
      inaccessibleRepoCount: hidden,
      costUsd: repos.reduce((sum, r) => sum + r.costUsd, 0),
    },
    criteria,
  };
}

/** A product result carrying nothing but its id and a coverage. */
function bareResult(
  productId: string,
  name: string | null,
  coverage: PortfolioProductResult["coverage"],
  reason: PortfolioProductResult["reason"],
): PortfolioProductResult {
  return {
    productId,
    name,
    coverage,
    reason,
    repos: [],
    criteriaCoveredBy: [],
    inaccessibleRepoCount: 0,
    costUsd: 0,
  };
}

/**
 * The assessment `id` as `access`'s reader may see it, or null when they may
 * not read it (or it does not exist).
 */
export async function viewPortfolioAssessment(
  access: ReaderAccess,
  id: string,
): Promise<PortfolioAssessmentView | null> {
  const a = await getPortfolioAssessment(id);
  if (!a || !(await mayRead(access, a))) return null;

  const connections = access.admin
    ? null
    : await prisma.repoConnection.findMany({
        // No `orderBy`/`take`: Prisma splits a long `IN` list itself (#1346).
        where: {
          id: {
            in: [
              ...new Set([
                ...a.repos.map((r) => r.repoConnectionId),
                ...a.products.flatMap((p) => impactReferences(p).repos),
              ]),
            ],
          },
          deletedAt: null,
        },
        select: { id: true, projectId: true },
      });
  const readableRepos = connections
    ? new Set(connections.filter((c) => access.canReadRepo({ repoConnection: c })).map((c) => c.id))
    : null;
  const keepRepo = (repoConnectionId: string) =>
    readableRepos === null || readableRepos.has(repoConnectionId);
  const readableProduct = (productId: string) => access.admin || access.products.has(productId);
  const names = access.admin
    ? new Map(
        (
          await prisma.product.findMany({
            // No `orderBy`/`take`: Prisma splits a long `IN` list itself (#1346).
            where: { id: { in: a.products.map((p) => p.productId) } },
            select: { id: true, name: true },
          })
        ).map((p) => [p.id, p.name]),
      )
    : access.products;

  const citations = new Map<string, CodeCitation[]>();
  for (const r of a.repos) citations.set(r.repoConnectionId, r.citations as CodeCitation[]);

  // Whether this reader sees less than the run did.
  let changed = false;
  // Whether an impact path was withheld from this reader (#1623).
  let withheldImpact = false;
  const products: StoredProduct[] = [];
  // Only the products the assessment was scoped to make the portfolio verdict: a
  // product the impact walk reached outside the scope (#1623) does not.
  const scoped = new Set(a.productIds);
  const results: PortfolioProductResult[] = [];
  const result = (r: PortfolioProductResult) => {
    if (scoped.has(r.productId)) results.push(r);
  };
  for (const raw of a.products) {
    const pid = raw.productId;
    if (!readableProduct(pid)) {
      if (raw.coverage !== "restricted") changed = true;
      products.push(restrictedRecord(pid, raw.impactKind));
      result(bareResult(pid, null, "restricted", null));
      continue;
    }
    const stored = readableImpact(raw, keepRepo, readableProduct);
    // A row only relabelled `restricted` (#1673) hides nothing the run saw.
    if (stored.technicalDetail !== raw.technicalDetail) withheldImpact = true;
    const name = names.get(pid) ?? null;
    const dropsRepo = a.repos.some((r) => r.productId === pid && !keepRepo(r.repoConnectionId));
    const view = asResult(stored, name, citations, keepRepo);
    if (!dropsRepo) {
      products.push(stored);
      result(view?.result ?? bareResult(pid, name, stored.coverage, null));
      continue;
    }
    changed = true;
    const { impact, impactWithheld } = stored.technicalDetail as {
      impact?: unknown;
      impactWithheld?: unknown;
    };
    if (view) {
      const record = toProductRecord(view.result, view.criteria);
      products.push({
        ...stored,
        ...record,
        technicalDetail: {
          ...record.technicalDetail,
          ...(impact ? { impact } : {}),
          // #1668 — so a withheld path still reads withheld, not as no impact detail.
          ...(impactWithheld === true ? { impactWithheld: true } : {}),
        },
      });
      result(view.result);
    } else {
      // A detail this reader cannot be shown in part: nothing of it is shown but
      // why it reads not checked (#1673), the reason the verdict roll-up uses.
      products.push({
        ...restrictedRecord(pid, stored.impactKind),
        coverage: "not-checked",
        technicalDetail: { reason: "repos-restricted" },
      });
      result(bareResult(pid, name, "not-checked", "repos-restricted"));
    }
  }

  const stored = portfolioVerdictFromStored(a.portfolioVerdict);
  const verdict =
    changed && a.status === "completed"
      ? rollUpPortfolioVerdict(results.map((p) => p.coverage))
      : stored;
  // #1624 — the model's prose was written about what the run saw. A reader who sees
  // less gets the deterministic summary instead, and no impact paragraphs: either
  // could describe a product, repo or path withheld from them.
  const seesLess = changed || withheldImpact;
  const nameOf = (productId: string) =>
    readableProduct(productId) ? (names.get(productId) ?? null) : null;
  const report = a.report && {
    ...a.report,
    // A model requirement may name a product this reader cannot read.
    requirements: a.report.requirements.filter((r) => r.mentions.every(readableProduct)),
    products: seesLess
      ? []
      : a.report.products.filter(
          (p) => readableProduct(p.productId) && p.mentions.every(readableProduct),
        ),
    withheld: seesLess && (a.report.products.length > 0 || a.report.source === "model"),
  };
  return {
    ...a,
    products,
    repos: a.repos.filter((r) => readableProduct(r.productId) && keepRepo(r.repoConnectionId)),
    verdict,
    portfolioVerdict: verdict === null ? null : storedPortfolioVerdict(verdict),
    summary:
      seesLess && verdict !== null
        ? [portfolioSummary(verdict, results), impactOverview(products, nameOf)]
            .filter(Boolean)
            .join("\n\n")
        : a.summary,
    report,
    // #1657 — the stored total includes the calls on what this reader cannot
    // see, which tells them it was assessed: recomputed from what they see.
    // #1668 — from the products' repo calls only, so the run-wide calls that
    // belong to no product (the criteria decomposition, the BA report) drop
    // out too: the total is below the run's spend by more than the hidden repos.
    costUsd: changed ? results.reduce((sum, p) => sum + p.costUsd, 0) : a.costUsd,
    productNames: Object.fromEntries(
      a.products.flatMap((p) => {
        const n = readableProduct(p.productId) ? names.get(p.productId) : undefined;
        return n === undefined ? [] : [[p.productId, n]];
      }),
    ),
  };
}

/** One list row of a view. */
export function toListItem(v: PortfolioAssessmentView): PortfolioAssessmentListItem {
  return {
    id: v.id,
    statement: v.statement,
    scope: v.scope,
    status: v.status,
    verdict: v.verdict,
    // #1668 — the products it was scoped to: a product the impact walk reached
    // outside the scope (#1623) has a row of its own, but is not counted.
    productCount: v.productIds.length,
    createdById: v.createdById,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  };
}

export { renderPortfolioAssessmentMarkdown } from "./assessment-markdown.js";
