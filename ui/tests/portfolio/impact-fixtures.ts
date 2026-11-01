/**
 * #1627 — an assessment with a cross-product impact, shaped as #1623 stores
 * it (`technicalDetail.impact`) and #1625 returns it to a reader.
 */
import type { PortfolioAssessmentView } from "@metis/shared";
import { product, repo, repoDetail, view } from "./fixtures";

type Hop = Record<string, unknown>;

export function hop(over: Partial<Hop> & { from: string; to: string }): Hop {
  const { from, to, ...rest } = over;
  return {
    edgeIds: [`e-${from}-${to}`],
    fromProductId: from,
    toProductId: to,
    provider: { repoConnectionId: `r-${from}`, label: `acme/${from}` },
    consumer: { repoConnectionId: `r-${to}`, label: `acme/${to}` },
    integrationKind: "api",
    strength: "contract",
    confidence: 0.9,
    resource: null,
    callSites: [],
    contract: null,
    sharedObjects: [],
    severity: { severity: "low", strength: "contract", base: "low", modifiers: [] },
    ...rest,
  };
}

export function impactDetail(severity: string | null, hops: Hop[], hiddenEdgeCount = 0) {
  return {
    impact: { maxDepth: 3, severity, severityRule: "weakest-hop", hiddenEdgeCount, hops },
  };
}

export function impactView(): PortfolioAssessmentView {
  const billingToLedger = hop({
    from: "p-billing",
    to: "p-ledger",
    callSites: [{ filePath: "src/client/billing.ts", line: 88 }],
    contract: {
      version: 4,
      breaking: true,
      items: [{ id: "POST /invoices", change: "field `iban` added as required", breaking: true }],
    },
    severity: {
      severity: "medium",
      strength: "contract",
      base: "low",
      modifiers: [{ kind: "breaking-contract", step: 1 }],
    },
  });
  const ledgerToWarehouse = hop({
    from: "p-ledger",
    to: "p-warehouse",
    integrationKind: "database",
    strength: "intrusive",
    confidence: 0.4,
    resource: { kind: "table", name: "payments" },
    sharedObjects: [
      {
        schemaName: "public",
        objectName: "ledger_entries",
        objectType: "table",
        usageClass: "used",
      },
    ],
    severity: {
      severity: "medium",
      strength: "intrusive",
      base: "high",
      modifiers: [{ kind: "low-confidence", step: -1, confidence: 0.4 }],
    },
  });
  const billingToEvents = hop({
    from: "p-billing",
    to: "p-events",
    integrationKind: "event",
    resource: { kind: "topic", name: "invoice.paid" },
  });
  return view({
    status: "completed",
    productIds: ["p-billing", "p-crm"],
    verdict: "partial",
    portfolioVerdict: "partial",
    summary:
      "Billing partly covers this.\n\nBilling must change; Ledger and Warehouse consume what changes.",
    productNames: {
      "p-billing": "Billing",
      "p-crm": "CRM",
      "p-ledger": "Ledger",
      "p-warehouse": "Warehouse",
      "p-events": "Events",
      "p-hr": "HR",
    },
    report: {
      source: "model",
      degraded: false,
      degradedReason: null,
      requirementsSource: "model",
      requirements: [],
      products: [
        {
          productId: "p-ledger",
          source: "model",
          functional: "Ledger must accept the new invoice field.",
          business: "Month-end close needs the new field reconciled.",
          stakeholder: "Finance operations.",
          mentions: [],
        },
      ],
      strippedSentences: 0,
      withheld: false,
    },
    products: [
      product(
        "p-billing",
        "partial",
        repoDetail([
          { id: "r-pay", label: "acme/payments", verdict: "partial", criteria: ["implemented"] },
        ]),
        {
          impactKind: "direct-change",
          baSummary: "Must change to deliver this requirement.",
          technicalDetail: {
            ...repoDetail([
              {
                id: "r-pay",
                label: "acme/payments",
                verdict: "partial",
                criteria: ["implemented"],
              },
            ]),
            ...impactDetail(null, []),
          },
        },
      ),
      product(
        "p-crm",
        "not-covered",
        repoDetail([{ id: "r-crm", label: "acme/crm", verdict: "gap-confirmed" }]),
      ),
      product(
        "p-ledger",
        "not-checked",
        {},
        {
          impactKind: "downstream-consumer",
          via: "api",
          severity: "medium",
          edgeIds: ["e-p-billing-p-ledger"],
          baSummary: "Downstream consumer via api (medium).",
          technicalDetail: { outOfScope: true, ...impactDetail("medium", [billingToLedger]) },
        },
      ),
      product(
        "p-warehouse",
        "not-checked",
        {},
        {
          impactKind: "downstream-consumer",
          via: "database",
          severity: "medium",
          baSummary: "Downstream consumer via database (medium).",
          technicalDetail: {
            outOfScope: true,
            ...impactDetail("medium", [billingToLedger, ledgerToWarehouse], 2),
          },
        },
      ),
      product(
        "p-events",
        "not-checked",
        {},
        {
          impactKind: "downstream-consumer",
          via: "event",
          severity: "low",
          baSummary: "Downstream consumer via event (low).",
          technicalDetail: { outOfScope: true, ...impactDetail("low", [billingToEvents]) },
        },
      ),
      product("p-secret", "restricted", {}, { impactKind: "downstream-consumer" }),
      product("p-hr", "not-checked", {}, { impactKind: "none" }),
    ],
    repos: [
      repo("p-billing", "r-pay", "partial", [{ filePath: "src/transfer.ts", startLine: 42 }]),
      repo("p-crm", "r-crm", "gap-confirmed"),
    ],
  });
}
