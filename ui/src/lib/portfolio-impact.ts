/**
 * Epic #1608 (#1627) — the cross-product impact of a portfolio assessment, as
 * pure functions of the reader's view (`GET /portfolio-assessments/:id`).
 *
 * Nothing is recomputed here. The severity, and the derivation that explains
 * it, are what #1623 stored on each hop (`technicalDetail.impact`); the server
 * already withheld from this reader any path through a repo or product they
 * cannot read (#1625). This reads those fields and puts them into words.
 */
import {
  CHANGE_SEVERITIES,
  portfolioModifierText,
  portfolioResourceLists,
  type CodeCitation,
  type PortfolioAssessmentView,
  type PortfolioResourceList,
} from "@metis/shared";
import { storedRepos } from "@/lib/portfolio-coverage";

type Product = PortfolioAssessmentView["products"][number];

export const IMPACT_LABEL: Record<Product["impactKind"], string> = {
  "direct-change": "Must change",
  "downstream-consumer": "Downstream consumer",
  restricted: "Restricted",
  none: "Not affected",
};

/** What crosses the boundary (#1618 `PRODUCT_INTEGRATION_KINDS`). */
const VIA_LABEL: Record<string, string> = {
  api: "an API",
  event: "an event",
  database: "a shared database",
  "shared-library": "a shared library",
  identity: "shared identity",
};

export function viaLabel(via: string | null): string | null {
  return via ? (VIA_LABEL[via] ?? via) : null;
}

/** One hop of a stored impact path (#1623 `ImpactHop`), as far as this view reads it. */
export interface ImpactHop {
  edgeIds: string[];
  fromProductId: string;
  toProductId: string;
  consumer: { repoConnectionId: string; label: string };
  integrationKind: string | null;
  confidence: number;
  resource: { kind: string; name: string } | null;
  callSites: Array<{ filePath: string; line: number | null }>;
  contract: {
    version: number;
    items: Array<{ id: string; change: string; breaking: boolean }>;
  } | null;
  sharedObjects: Array<{
    schemaName: string | null;
    objectName: string;
    objectType: string;
    usageClass: string;
  }>;
  severity: {
    severity: string;
    strength: string | null;
    base: string;
    modifiers: Array<{ kind: string; confidence?: number }>;
  };
}

interface StoredImpact {
  severity: string | null;
  hiddenEdgeCount: number;
  hops: ImpactHop[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const strOrNull = (v: unknown): v is string | null => v === null || isStr(v);
const arrayOf = <T>(v: unknown, ok: (x: unknown) => x is T): v is T[] =>
  Array.isArray(v) && v.every(ok);

function isHop(v: unknown): v is ImpactHop {
  if (!isObj(v)) return false;
  const { consumer, resource, callSites, contract, sharedObjects, severity } = v;
  return (
    arrayOf(v.edgeIds, isStr) &&
    isStr(v.fromProductId) &&
    isStr(v.toProductId) &&
    isObj(consumer) &&
    isStr(consumer.repoConnectionId) &&
    isStr(consumer.label) &&
    strOrNull(v.integrationKind) &&
    isNum(v.confidence) &&
    (resource === null || (isObj(resource) && isStr(resource.kind) && isStr(resource.name))) &&
    arrayOf(
      callSites,
      (c): c is ImpactHop["callSites"][number] =>
        isObj(c) && isStr(c.filePath) && (c.line === null || isNum(c.line)),
    ) &&
    (contract === null ||
      (isObj(contract) &&
        isNum(contract.version) &&
        arrayOf(
          contract.items,
          (i): i is { id: string; change: string; breaking: boolean } =>
            isObj(i) && isStr(i.id) && isStr(i.change) && typeof i.breaking === "boolean",
        ))) &&
    arrayOf(
      sharedObjects,
      (o): o is ImpactHop["sharedObjects"][number] =>
        isObj(o) &&
        strOrNull(o.schemaName) &&
        isStr(o.objectName) &&
        isStr(o.objectType) &&
        isStr(o.usageClass),
    ) &&
    isObj(severity) &&
    isStr(severity.severity) &&
    strOrNull(severity.strength) &&
    isStr(severity.base) &&
    arrayOf(
      severity.modifiers,
      (m): m is { kind: string; confidence?: number } =>
        isObj(m) && isStr(m.kind) && (m.confidence === undefined || isNum(m.confidence)),
    )
  );
}

/**
 * The stored impact path, or null when there is none, or it does not read as
 * one: a malformed path is not shown at all rather than shown in part.
 */
export function storedImpact(product: Pick<Product, "technicalDetail">): StoredImpact | null {
  const impact = (product.technicalDetail as { impact?: unknown }).impact;
  if (!isObj(impact) || !strOrNull(impact.severity) || !arrayOf(impact.hops, isHop)) return null;
  return {
    severity: impact.severity,
    hiddenEdgeCount: isNum(impact.hiddenEdgeCount) ? impact.hiddenEdgeCount : 0,
    hops: impact.hops,
  };
}

/** One hop's severity, worked out in words from what was stored. */
export interface HopDerivation {
  label: string;
  strength: string;
  base: string;
  modifiers: string[];
  confidence: number;
  severity: string;
}

export interface DeepDive {
  repos: Array<{ label: string; role: string }>;
  files: Array<{ location: string; repo: string; callSite: boolean }>;
  contract: {
    version: number;
    items: Array<{ id: string; change: string; breaking: boolean }>;
  } | null;
  /**
   * #1673 — the shared resources the last hop crosses, one list per
   * `ProductResource.kind` (databases, tables and columns, topics, identity
   * providers, buckets), as the Markdown export lists them.
   */
  resources: PortfolioResourceList[];
}

export interface AffectedProduct {
  productId: string;
  /** Null for a product the reader cannot read. */
  name: string | null;
  restricted: boolean;
  impactKind: Exclude<Product["impactKind"], "none">;
  via: string | null;
  severity: string | null;
  /** The product's one-paragraph summary: the report's, else the stored sentence. */
  summary: string;
  /** Hop by hop, how the severity was reached; empty for a direct change. */
  derivation: HopDerivation[];
  /** The products the path runs through, in order (names, or null when unreadable). */
  path: Array<{ productId: string; name: string | null }>;
  /** Each hop's label on the diagram: the integration kind. */
  pathEdges: string[];
  hiddenEdgeCount: number;
  /** The server withheld the path: it runs through something the reader cannot read. */
  impactWithheld: boolean;
  deepDive: DeepDive;
}

export interface NotAffectedProduct {
  productId: string;
  name: string | null;
}

function paragraphFor(view: PortfolioAssessmentView, p: Product): string {
  const report = view.report?.products.find((r) => r.productId === p.productId);
  const prose = report
    ? [report.functional, report.business, report.stakeholder].filter(Boolean).join(" ")
    : "";
  return prose || p.baSummary;
}

function deepDiveFor(
  view: PortfolioAssessmentView,
  p: Product,
  impact: StoredImpact | null,
): DeepDive {
  const hops = impact?.hops ?? [];
  const last = hops.at(-1);
  const repos = storedRepos(p);
  const labels = new Map(repos.map((r) => [r.repoConnectionId, r.label]));
  const repoRows = new Map(
    repos.map((r) => [r.repoConnectionId, { label: r.label, role: r.verdict }]),
  );
  if (last && !repoRows.has(last.consumer.repoConnectionId)) {
    repoRows.set(last.consumer.repoConnectionId, { label: last.consumer.label, role: "consumer" });
  }
  const files = [
    ...view.repos
      .filter((r) => r.productId === p.productId)
      .flatMap((r) =>
        (r.citations as CodeCitation[]).map((c) => ({
          location: `${c.filePath}:${c.startLine}`,
          repo: labels.get(c.repoConnectionId ?? r.repoConnectionId) ?? "Unnamed repository",
          callSite: false,
        })),
      ),
    ...(last?.callSites ?? []).map((s) => ({
      location: s.line === null ? s.filePath : `${s.filePath}:${s.line}`,
      repo: last!.consumer.label,
      callSite: true,
    })),
  ];
  return {
    repos: [...repoRows.values()],
    files,
    contract:
      last?.contract && last.contract.items.length > 0
        ? { version: last.contract.version, items: last.contract.items }
        : null,
    resources: portfolioResourceLists(last?.resource ?? null, last?.sharedObjects ?? []),
  };
}

/** Must change first, then by severity (`CHANGE_SEVERITIES`, strongest first), restricted last. */
function rank(p: AffectedProduct): number {
  if (p.impactKind === "direct-change") return -1;
  if (p.impactKind === "restricted") return CHANGE_SEVERITIES.length + 1;
  const i = (CHANGE_SEVERITIES as readonly string[]).indexOf(p.severity ?? "");
  return i === -1 ? CHANGE_SEVERITIES.length : i;
}

/**
 * Every product the requirement reaches, and every one it does not. Products
 * that must change come first, then downstream consumers from most to least
 * severe, then (#1673) those it may reach only through a product the reader
 * cannot read: never listed not affected. Nothing in the view is left out: a
 * product is in one list or the other.
 */
export function impactGroups(view: PortfolioAssessmentView): {
  affected: AffectedProduct[];
  notAffected: NotAffectedProduct[];
} {
  const nameOf = (productId: string) => view.productNames[productId] ?? null;
  const affected: AffectedProduct[] = [];
  const notAffected: NotAffectedProduct[] = [];
  for (const p of view.products) {
    const restricted = p.coverage === "restricted";
    const name = restricted ? null : nameOf(p.productId);
    if (p.impactKind === "none") {
      notAffected.push({ productId: p.productId, name });
      continue;
    }
    const impact = restricted ? null : storedImpact(p);
    const hops = impact?.hops ?? [];
    affected.push({
      productId: p.productId,
      name,
      restricted,
      impactKind: p.impactKind,
      via: restricted ? null : p.via,
      severity: restricted ? null : p.severity,
      summary: restricted ? "" : paragraphFor(view, p),
      derivation: hops.map((h) => ({
        label: `${nameOf(h.fromProductId) ?? "A product"} → ${nameOf(h.toProductId) ?? "a product"}`,
        strength: h.severity.strength ?? "unclassified",
        base: h.severity.base,
        modifiers: h.severity.modifiers.map(portfolioModifierText),
        confidence: h.confidence,
        severity: h.severity.severity,
      })),
      path:
        hops.length > 0
          ? [hops[0].fromProductId, ...hops.map((h) => h.toProductId)].map((id) => ({
              productId: id,
              name: nameOf(id),
            }))
          : [],
      pathEdges: hops.map((h) => h.integrationKind ?? "unclassified"),
      hiddenEdgeCount: impact?.hiddenEdgeCount ?? 0,
      impactWithheld:
        !restricted && (p.technicalDetail as { impactWithheld?: unknown }).impactWithheld === true,
      deepDive: restricted
        ? { repos: [], files: [], contract: null, resources: [] }
        : deepDiveFor(view, p, impact),
    });
  }
  affected.sort((a, b) => rank(a) - rank(b) || (a.name ?? "~").localeCompare(b.name ?? "~"));
  return { affected, notAffected };
}
