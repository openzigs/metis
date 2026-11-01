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
import { mdBlock, mdInline } from "../analysis/analysis-export.js";
import { escapeMarkdownCell } from "../analysis/traceability-matrix.js";
import { getPortfolioAssessment } from "./assessment-store.js";
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
  /** Readable product id → name. */
  products: Map<string, string>;
  canReadRepo: (repo: { repoConnection: { projectId: string } }) => boolean;
  canReadProject: (projectId: string) => Promise<boolean>;
}

export async function resolveReaderAccess(user: AuthPayload): Promise<ReaderAccess> {
  const [rows, canReadRepo] = await Promise.all([
    prisma.product.findMany({
      // Binds the caller's workspace ids only, never a product or project list.
      where: await buildProductAccessWhere(user),
      select: { id: true, name: true },
    }),
    productRepoReadAccess(user),
  ]);
  const projects = new Map<string, Promise<boolean>>();
  return {
    user,
    admin: user.role === "admin",
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

/** Whether the reader could start this assessment with the same scope. */
async function mayRead(access: ReaderAccess, a: PortfolioAssessment): Promise<boolean> {
  if (access.admin) return true;
  if (a.sourceProjectId && !(await access.canReadProject(a.sourceProjectId))) return false;
  if (a.createdById === access.user.userId) return true;
  // Only the products it was scoped to: reading a product the impact walk reached
  // downstream (#1623) is not enough to have started it.
  const scoped = new Set(a.productIds);
  return [
    ...a.productIds,
    ...a.products.map((p) => p.productId).filter((id) => scoped.has(id)),
  ].some((id) => access.products.has(id));
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
 * #1623 — a product's impact as the reader may see it. A path through a repo or
 * a product the reader cannot read now is withheld whole (its edges, severity
 * and hops would describe what they cannot see); the impact kind stays.
 */
function readableImpact(
  stored: StoredProduct,
  keepRepo: (repoConnectionId: string) => boolean,
  readableProduct: (productId: string) => boolean,
): StoredProduct {
  const refs = impactReferences(stored);
  if (refs.repos.every(keepRepo) && refs.products.every(readableProduct)) return stored;
  const detail: Record<string, unknown> = { ...stored.technicalDetail };
  delete detail.impact;
  return {
    ...stored,
    via: null,
    edgeIds: [],
    severity: null,
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

  const citations = new Map<string, CodeCitation[]>();
  for (const r of a.repos) citations.set(r.repoConnectionId, r.citations as CodeCitation[]);

  // Whether this reader sees less than the run did.
  let changed = false;
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
    const name = access.products.get(pid) ?? null;
    const dropsRepo = a.repos.some((r) => r.productId === pid && !keepRepo(r.repoConnectionId));
    const view = asResult(stored, name, citations, keepRepo);
    if (!dropsRepo) {
      products.push(stored);
      result(view?.result ?? bareResult(pid, name, stored.coverage, null));
      continue;
    }
    changed = true;
    const impact = (stored.technicalDetail as { impact?: unknown }).impact;
    if (view) {
      const record = toProductRecord(view.result, view.criteria);
      products.push({
        ...stored,
        ...record,
        technicalDetail: { ...record.technicalDetail, ...(impact ? { impact } : {}) },
      });
      result(view.result);
    } else {
      // A detail this reader cannot be shown in part: nothing of it is shown.
      products.push({ ...restrictedRecord(pid, stored.impactKind), coverage: "not-checked" });
      result(bareResult(pid, name, "not-checked", "repos-restricted"));
    }
  }

  const stored = portfolioVerdictFromStored(a.portfolioVerdict);
  const verdict =
    changed && a.status === "completed"
      ? rollUpPortfolioVerdict(results.map((p) => p.coverage))
      : stored;
  return {
    ...a,
    products,
    repos: a.repos.filter((r) => readableProduct(r.productId) && keepRepo(r.repoConnectionId)),
    verdict,
    portfolioVerdict: verdict === null ? null : storedPortfolioVerdict(verdict),
    summary: changed && verdict !== null ? portfolioSummary(verdict, results) : a.summary,
    productNames: Object.fromEntries(
      a.products.flatMap((p) => {
        const n = readableProduct(p.productId) ? access.products.get(p.productId) : undefined;
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
    productCount: v.products.length || v.productIds.length,
    createdById: v.createdById,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  };
}

const COVERAGE_LABEL: Record<StoredProduct["coverage"], string> = {
  covers: "Covers it",
  partial: "Covers part of it",
  "not-covered": "Does not cover it",
  "not-checked": "Not checked",
  restricted: "Restricted",
};

const VERDICT_LABEL: Record<NonNullable<PortfolioAssessmentView["verdict"]>, string> = {
  implemented: "Implemented",
  partial: "Partly covered",
  "gap-confirmed": "Nothing in the portfolio covers this",
  "could-not-verify": "Could not verify",
};

const cell = (value: string) => escapeMarkdownCell(mdInline(value));

/** A reader's view as Markdown. Every stored or user-written string is escaped. */
export function renderPortfolioAssessmentMarkdown(v: PortfolioAssessmentView): string {
  const name = (productId: string) => v.productNames[productId] ?? productId;
  const lines = [
    "# Portfolio assessment",
    "",
    "## Requirement",
    "",
    mdBlock(v.statement),
    "",
    `**Status:** ${mdInline(v.status)}`,
    `**Verdict:** ${v.verdict ? VERDICT_LABEL[v.verdict] : "Not yet assessed"}`,
    "",
    mdBlock(v.summary),
    "",
    "## Products",
    "",
    "| Product | Coverage | Summary |",
    "| --- | --- | --- |",
    ...v.products.map(
      (p) =>
        `| ${cell(name(p.productId))} | ${COVERAGE_LABEL[p.coverage]} | ${cell(p.baSummary)} |`,
    ),
  ];
  const labels = new Map<string, string>();
  for (const p of v.products) {
    const repos = (p.technicalDetail as { repos?: unknown }).repos;
    if (!Array.isArray(repos)) continue;
    for (const r of repos as Array<{ repoConnectionId?: unknown; label?: unknown }>) {
      if (typeof r.repoConnectionId === "string" && typeof r.label === "string") {
        labels.set(r.repoConnectionId, r.label);
      }
    }
  }
  const cited = v.repos.filter((r) => r.citations.length > 0);
  if (cited.length > 0) {
    lines.push("", "## Evidence", "");
    for (const r of cited) {
      lines.push(
        `### ${mdInline(name(r.productId))}: ${mdInline(labels.get(r.repoConnectionId) ?? r.repoConnectionId)} (${r.verdict})`,
        "",
      );
      for (const c of r.citations as CodeCitation[]) {
        lines.push(`- \`${mdInline(c.filePath).replace(/`/g, "'")}\``);
      }
      lines.push("");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
