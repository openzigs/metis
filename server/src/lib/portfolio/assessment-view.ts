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
  RESTRICTED_SOURCE_TITLE,
  portfolioOtherLinkKinds,
  portfolioRestrictedRule,
  type AuthPayload,
  type CodeCitation,
  type PortfolioAssessment,
  type PortfolioAssessmentListItem,
  type PortfolioAssessmentView,
} from "@metis/shared";
import { prisma } from "../prisma.js";
import { buildProductAccessWhere, productRepoReadAccess } from "../products/product-access.js";
import { canAccessProjectDiscussions } from "../discussions/access.js";
import { getPortfolioAssessmentRecord, type StoredSourceRows } from "./assessment-store.js";
import { restrictedIds, userSourceReader } from "../analysis/source-redaction.js";
import { impactOverview, impactSentence } from "./report-overview.js";
import {
  portfolioSummary,
  toProductRecord,
  type PortfolioProductResult,
  type PortfolioRepoResult,
} from "./gap-engine.js";
import {
  portfolioVerdictFromStored,
  rollUpPortfolio,
  rollUpProductCoverage,
  scopeOfChange,
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
/**
 * #2447 — what of an assessment's source the reader cannot see. `all`: every
 * word of it (a single requirement resting on a source they cannot see).
 * Otherwise `hides(text)` says whether one stored text (a criterion, a
 * not-checked entry) may have been drawn from a change-request row they cannot
 * see, and `any` whether any stored text was, which withholds the model's
 * restatement and its prose.
 *
 * #2491 — fail closed. The check read its rows when it ran; a row may since
 * have been rejected, deferred, soft-deleted or renamed, so what a row is
 * *now* never clears a stored text. A text is shown only when it is the opening of
 * what a row the reader can see says now (`title: body`, how the check wrote
 * its criteria): then it tells the reader nothing they cannot read. A row
 * left out at the start (its starter could not see it) wrote no text, so a
 * check that read only visible rows withholds nothing; a visible row edited
 * since only over-blocks.
 *
 * #2498 — a row hard-deleted since (a withheld replacement, a re-synthesis)
 * leaves no row to be hidden by, so the check records the rows it read, with
 * their sources as they were then (`sourceRows`). Each recorded row is decided
 * on those sources against the access lists as they are now, alongside the
 * rows that exist now: a recorded row hidden from the reader hides as a row
 * that exists would. A single-requirement check whose row is gone (its link is
 * set null) is still one: every word of it goes. A record that does not parse
 * hides everything. A check from before the column whose rows were deleted
 * before the migration could record them keeps the rule above.
 */
async function hiddenSource(
  access: ReaderAccess,
  a: PortfolioAssessment,
  sourceRows: StoredSourceRows,
): Promise<{ all: boolean; any: boolean; hides: (text: string) => boolean }> {
  const none = { all: false, any: false, hides: () => false };
  const all = { all: true, any: true, hides: () => true };
  if (access.admin) return none;
  if (sourceRows === "unreadable") return all;
  const where = a.sourceRequirementId
    ? { id: a.sourceRequirementId }
    : a.sourceAnalysisId
      ? { analysisId: a.sourceAnalysisId }
      : null;
  const recorded = sourceRows ?? [];
  if (!where && recorded.length === 0) return none;
  const rows = where
    ? await prisma.requirement.findMany({
        where,
        select: { id: true, analysisId: true, sourceIds: true, title: true, body: true },
      })
    : [];
  // A recorded row is decided on its own key: one that still exists is decided
  // as it is now, too.
  const hidden = await restrictedIds(userSourceReader(access.user.userId), [
    ...rows,
    ...recorded.map((r) => ({ ...r, id: `recorded:${r.id}` })),
  ]);
  if (hidden.size === 0) return none;
  if (a.sourceRequirementId || (sourceRows !== null && !a.sourceAnalysisId)) return all;
  const visible = rows
    .filter((r) => !hidden.has(r.id))
    .map((r) => normalized(`${r.title}: ${r.body}`));
  const hides = (text: string) => {
    const t = normalized(text).replace(/…$/u, "").trimEnd();
    return t.length === 0 || !visible.some((v) => v.startsWith(t));
  };
  // With no stored criterion to tell by (a check that never got that far),
  // every hidden row counts.
  const criteria = storedCriteria(a);
  const any =
    criteria.length === 0 ||
    [...criteria, ...a.notChecked.filter(carriesText).map((n) => n.text)].some(hides);
  return { all: false, any, hides };
}

/** Whitespace collapsed, as a not-checked entry's opening is written (`oneLine`). */
function normalized(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Whether a not-checked entry may quote a requirement. Only a count entry
 * (its starter could not see N rows; N more past the limit) is known not to:
 * any other reason is treated as text, so a new one fails closed.
 */
function carriesText(n: PortfolioAssessment["notChecked"][number]): boolean {
  if (n.reason === "restricted-source") return false;
  return !(n.reason === "over-limit" && n.count !== null);
}

/** The criteria a check stored on its products, trimmed. */
function storedCriteria(a: PortfolioAssessment): string[] {
  return a.products.flatMap((p) => {
    const list = (p.technicalDetail as { criteria?: unknown } | null)?.criteria;
    return Array.isArray(list)
      ? list.flatMap((c: unknown) => {
          const criterion = (c as { criterion?: unknown } | null)?.criterion;
          return typeof criterion === "string" ? [criterion.trim()] : [];
        })
      : [];
  });
}

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

/** #1963 — one stored link (`technicalDetail.impact.links`) as the view reads it. */
interface StoredLink {
  providerRepoId?: unknown;
  consumerRepoId?: unknown;
  fromProductId?: unknown;
  edgeProductIds?: unknown;
}

function storedLinks(stored: StoredProduct): StoredLink[] | null {
  const links = (stored.technicalDetail as { impact?: { links?: unknown } }).impact?.links;
  return Array.isArray(links) ? (links as StoredLink[]) : null;
}

/**
 * #1963 — a stored boolean of the run's impact detail (`impact.edgesDetected`,
 * `impact.connectedToChange`), or undefined when the row does not carry it. A
 * row stored before #1963 carries neither, and nothing is inferred from that:
 * it is neither left out of the verdict nor named never analysed.
 */
function storedImpactFlag(
  technicalDetail: unknown,
  key: "edgesDetected" | "connectedToChange",
): boolean | undefined {
  const value = (technicalDetail as { impact?: Record<string, unknown> } | null)?.impact?.[key];
  return typeof value === "boolean" ? value : undefined;
}

/** #1963 — the repos and products one stored link names. */
function linkReferences(link: StoredLink): { repos: string[]; products: string[] } {
  const str = (v: unknown) => (typeof v === "string" ? [v] : []);
  return {
    repos: [...str(link?.providerRepoId), ...str(link?.consumerRepoId)],
    products: [
      ...str(link?.fromProductId),
      ...(Array.isArray(link?.edgeProductIds) ? link.edgeProductIds.flatMap(str) : []),
    ],
  };
}

/**
 * #1963 — a row with only the links its reader can read now: a link through a
 * repo or product they cannot read would tell them an edge kind reaches it
 * there. A link naming nothing (an unreadable shape) is dropped too. The row is
 * returned as it was when nothing is dropped, so a reader who sees every link
 * sees the stored summary.
 */
function withReadableLinks(
  stored: StoredProduct,
  keepRepo: (repoConnectionId: string) => boolean,
  readableProduct: (productId: string) => boolean,
): StoredProduct {
  const links = storedLinks(stored);
  if (!links) return stored;
  const kept = links.filter((l) => {
    const refs = linkReferences(l);
    return (
      refs.repos.length === 2 &&
      refs.products.length >= 2 &&
      refs.repos.every(keepRepo) &&
      refs.products.every(readableProduct)
    );
  });
  if (kept.length === links.length) return stored;
  const impact = (stored.technicalDetail as { impact: Record<string, unknown> }).impact;
  const technicalDetail: Record<string, unknown> = {
    ...stored.technicalDetail,
    impact: { ...impact, links: kept },
  };
  return {
    ...stored,
    // An out-of-scope row's summary named every kind: rebuilt from the kept ones.
    ...(technicalDetail.outOfScope === true
      ? { baSummary: impactSentence(stored, portfolioOtherLinkKinds(technicalDetail, stored.via)) }
      : {}),
    technicalDetail,
  };
}

/**
 * #1668 — how many restricted products the run's walk stopped at, as an earlier
 * run stored it on a readable row (`technicalDetail.impact.stoppedAtRestricted`).
 */
function stoppedAtRestricted(stored: StoredProduct): number {
  // #1680 — a run that relabelled only some products records its rule
  // (#1689: `walk`, or the older `adjacent`); its `none` is the walk's answer
  // and is not relabelled again. Code from before #1689 knows only `adjacent`:
  // reverted past it, a stopped run's `walk` rows would all read `restricted`
  // (docs/ARCHITECTURE.md, "Rollback").
  if (portfolioRestrictedRule(stored.technicalDetail) !== null) return 0;
  const n = (stored.technicalDetail as { impact?: { stoppedAtRestricted?: unknown } }).impact
    ?.stoppedAtRestricted;
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
 * some products, and marks its rows with the rule it used (#1689: `walk`, the
 * products a walk able to read everything reaches; `adjacent`, the older
 * connection rule); those are read as stored.
 */
function readableImpact(
  stored: StoredProduct,
  keepRepo: (repoConnectionId: string) => boolean,
  readableProduct: (productId: string) => boolean,
): StoredProduct {
  const refs = impactReferences(stored);
  if (refs.repos.every(keepRepo) && refs.products.every(readableProduct)) {
    const linked = withReadableLinks(stored, keepRepo, readableProduct);
    return linked.impactKind === "none" && stoppedAtRestricted(linked) > 0
      ? { ...linked, impactKind: "restricted" }
      : linked;
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
  const record = await getPortfolioAssessmentRecord(id);
  const a = record?.assessment;
  if (!record || !a || !(await mayRead(access, a))) return null;
  // #2447 — a source requirement the reader cannot see: its text goes.
  const hidden = await hiddenSource(access, a, record.sourceRows);
  const sourceHidden = hidden.all || hidden.any;
  const fromHidden = (text: string) => hidden.all || (sourceHidden && hidden.hides(text));

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
                // #1963 — and the repos of every other link that reaches it.
                ...a.products.flatMap(
                  (p) => storedLinks(p)?.flatMap((l) => linkReferences(l).repos) ?? [],
                ),
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
            where: {
              id: {
                in: [
                  ...new Set([
                    ...a.products.map((p) => p.productId),
                    ...(a.hostProductId ? [a.hostProductId] : []),
                  ]),
                ],
              },
            },
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
  // #1963 — as the run did (`scopedToChange`): a product not checked that the
  // run found not connected to any product the change touches, and whose edges
  // were detected, is not in scope; a row without those signals (stored before
  // #1963) is neither. Any product that changes counts; of the rest, only a row the walk
  // itself listed under the current rule is known (a restricted row carries no
  // impact detail, so it is never one).
  const scope = scopeOfChange(
    results,
    products
      .filter(
        (p) =>
          p.impactKind === "direct-change" || portfolioRestrictedRule(p.technicalDetail) === "walk",
      )
      .map((p) => ({
        productId: p.productId,
        impactKind: p.impactKind,
        edgesDetected: storedImpactFlag(p.technicalDetail, "edgesDetected"),
        connectedToChange: storedImpactFlag(p.technicalDetail, "connectedToChange"),
      })),
  );
  const scopedVerdict = rollUpPortfolio(results, scope.notInScope);
  const verdict = changed && a.status === "completed" ? scopedVerdict : stored;
  // A verdict stored before #1963 was rolled up over every product: its summary
  // leaves none out, so it never names a product as not in scope.
  const summaryScope =
    verdict === scopedVerdict
      ? scope
      : { notInScope: new Set<string>(), neverAnalysed: new Set<string>() };
  // #1624 — the model's prose was written about what the run saw. A reader who sees
  // less gets the deterministic summary instead, and no impact paragraphs: either
  // could describe a product, repo or path withheld from them.
  const seesLess = changed || withheldImpact || sourceHidden;
  const nameOf = (productId: string) =>
    readableProduct(productId) ? (names.get(productId) ?? null) : null;
  const report = a.report && {
    ...a.report,
    // A model requirement may name a product this reader cannot read.
    // #2447 — the model's restatement of a requirement the reader cannot see.
    requirements: sourceHidden
      ? []
      : a.report.requirements.filter((r) => r.mentions.every(readableProduct)),
    products: seesLess
      ? []
      : a.report.products.filter(
          (p) => readableProduct(p.productId) && p.mentions.every(readableProduct),
        ),
    withheld: seesLess && (a.report.products.length > 0 || a.report.source === "model"),
  };
  // #1725 — the host is named only to a reader who can read it now.
  const hostProductId =
    a.hostProductId !== null && readableProduct(a.hostProductId) ? a.hostProductId : null;
  return {
    ...a,
    statement: hidden.all ? RESTRICTED_SOURCE_TITLE : a.statement,
    notChecked: a.notChecked.map((n) =>
      hidden.all || (carriesText(n) && fromHidden(n.text))
        ? { ...n, text: RESTRICTED_SOURCE_TITLE }
        : n,
    ),
    hostProductId,
    products: sourceHidden ? products.map((p) => withoutHiddenCriteria(p, fromHidden)) : products,
    repos: a.repos.filter((r) => readableProduct(r.productId) && keepRepo(r.repoConnectionId)),
    verdict,
    portfolioVerdict: verdict === null ? null : storedPortfolioVerdict(verdict),
    summary:
      sourceHidden && verdict === null
        ? ""
        : seesLess && verdict !== null
          ? [
              portfolioSummary(verdict, results, summaryScope),
              impactOverview(
                products.map((p) => ({
                  ...p,
                  otherVia: portfolioOtherLinkKinds(p.technicalDetail, p.via),
                })),
                nameOf,
              ),
            ]
              .filter(Boolean)
              .join("\n\n")
          : a.summary,
    report,
    // #1963 — so the page's headline can say which unchecked products were left out.
    notInScope: [...summaryScope.notInScope].sort(),
    // #1963 — and which were kept in because they were never analysed.
    neverAnalysed: [...summaryScope.neverAnalysed].sort(),
    // #1657 — the stored total includes the calls on what this reader cannot
    // see, which tells them it was assessed: recomputed from what they see.
    // #1668 — from the products' repo calls only, so the run-wide calls that
    // belong to no product (the criteria decomposition, the BA report) drop
    // out too: the total is below the run's spend by more than the hidden repos.
    costUsd: changed ? results.reduce((sum, p) => sum + p.costUsd, 0) : a.costUsd,
    productNames: Object.fromEntries(
      [...a.products.map((p) => p.productId), ...(hostProductId ? [hostProductId] : [])].flatMap(
        (pid) => {
          const n = readableProduct(pid) ? names.get(pid) : undefined;
          return n === undefined ? [] : [[pid, n]];
        },
      ),
    ),
  };
}

/** #2447 — a product row with each criterion drawn from a hidden requirement as the placeholder. */
function withoutHiddenCriteria<P extends { technicalDetail: Record<string, unknown> }>(
  p: P,
  fromHidden: (text: string) => boolean,
): P {
  const criteria = (p.technicalDetail as { criteria?: unknown }).criteria;
  if (!Array.isArray(criteria)) return p;
  return {
    ...p,
    technicalDetail: {
      ...p.technicalDetail,
      criteria: criteria.map((c: unknown) => {
        const criterion = (c as { criterion?: unknown } | null)?.criterion;
        return typeof criterion === "string" && fromHidden(criterion)
          ? { ...(c as object), criterion: RESTRICTED_SOURCE_TITLE }
          : c;
      }),
    },
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
    // #1749 — the view already dropped a host this reader cannot read.
    hostProductId: v.hostProductId,
    hostProductName: v.hostProductId ? (v.productNames[v.hostProductId] ?? null) : null,
    // #2345 — where it was started from, and the pre-approval label wherever it is cited.
    sourceAnalysisId: v.sourceAnalysisId,
    preApproval: v.preApproval,
    createdById: v.createdById,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  };
}

export { renderPortfolioAssessmentMarkdown } from "./assessment-markdown.js";
