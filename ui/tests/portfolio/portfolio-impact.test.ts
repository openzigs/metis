/**
 * #1627 — the impact view's reading of a stored assessment: who is affected
 * and how, the stored severity derivation, the deep dive, and the products not
 * affected (never left out).
 */
import { describe, expect, it } from "vitest";
import { IMPACT_LABEL, impactGroups, storedImpact, viaLabel } from "@/lib/portfolio-impact";
import { product } from "./fixtures";
import { hop, impactDetail, impactView } from "./impact-fixtures";

describe("impactGroups", () => {
  it("puts must-change first, then downstream from most to least severe", () => {
    const { affected } = impactGroups(impactView());
    expect(affected.map((p) => [p.productId, p.impactKind, p.severity])).toEqual([
      ["p-billing", "direct-change", null],
      ["p-ledger", "downstream-consumer", "medium"],
      ["p-warehouse", "downstream-consumer", "medium"],
      ["p-events", "downstream-consumer", "low"],
      ["p-secret", "downstream-consumer", null],
    ]);
  });

  it("lists every product it does not reach, so none is left out", () => {
    const v = impactView();
    const { affected, notAffected } = impactGroups(v);
    expect(notAffected).toEqual([
      { productId: "p-crm", name: "CRM" },
      { productId: "p-hr", name: "HR" },
    ]);
    expect(affected.length + notAffected.length).toBe(v.products.length);
  });

  it("uses the report's paragraph, else the stored one-line summary", () => {
    const { affected } = impactGroups(impactView());
    const byId = new Map(affected.map((p) => [p.productId, p]));
    expect(byId.get("p-ledger")?.summary).toBe(
      "Ledger must accept the new invoice field. Month-end close needs the new field reconciled. Finance operations.",
    );
    expect(byId.get("p-warehouse")?.summary).toBe("Downstream consumer via database (medium).");
  });

  it("explains the severity from the stored derivation, hop by hop", () => {
    const warehouse = impactGroups(impactView()).affected[2];
    expect(warehouse.derivation).toEqual([
      {
        label: "Billing → Ledger",
        strength: "contract",
        base: "low",
        modifiers: [
          "+1 step because the provider's latest contract version made a breaking change",
        ],
        confidence: 0.9,
        severity: "medium",
      },
      {
        label: "Ledger → Warehouse",
        strength: "intrusive",
        base: "high",
        modifiers: ["−1 step for low confidence (0.4)"],
        confidence: 0.4,
        severity: "medium",
      },
    ]);
  });

  it("shows the stored severity even where a recomputation would differ", () => {
    const v = impactView();
    // Stored: a contract hop at "critical", with no modifier that would explain it.
    v.products[2] = {
      ...v.products[2],
      severity: "critical",
      technicalDetail: impactDetail("critical", [
        hop({
          from: "p-billing",
          to: "p-ledger",
          severity: { severity: "critical", strength: "contract", base: "low", modifiers: [] },
        }),
      ]),
    };
    const ledger = impactGroups(v).affected.find((p) => p.productId === "p-ledger")!;
    expect(ledger.severity).toBe("critical");
    expect(ledger.derivation[0].severity).toBe("critical");
  });

  it("reads the path and the deep dive from the last hop", () => {
    const warehouse = impactGroups(impactView()).affected[2];
    expect(warehouse.path.map((p) => p.name)).toEqual(["Billing", "Ledger", "Warehouse"]);
    expect(warehouse.pathEdges).toEqual(["api", "database"]);
    expect(warehouse.hiddenEdgeCount).toBe(2);
    expect(warehouse.deepDive).toEqual({
      repos: [{ label: "acme/p-warehouse", role: "consumer" }],
      files: [],
      contract: null,
      resources: [
        {
          heading: "Tables and columns",
          items: [
            { name: "payments", detail: null },
            { name: "public.ledger_entries", detail: "table, used" },
          ],
        },
      ],
    });

    const ledger = impactGroups(impactView()).affected[1];
    expect(ledger.deepDive.files).toEqual([
      { location: "src/client/billing.ts:88", repo: "acme/p-ledger", callSite: true },
    ]);
    expect(ledger.deepDive.contract).toEqual({
      version: 4,
      items: [{ id: "POST /invoices", change: "field `iban` added as required", breaking: true }],
    });

    const events = impactGroups(impactView()).affected[3];
    expect(events.deepDive.resources).toEqual([
      { heading: "Topics", items: [{ name: "invoice.paid", detail: null }] },
    ]);
  });

  it("lists a must-change product's own repos and cited files", () => {
    const billing = impactGroups(impactView()).affected[0];
    expect(billing.deepDive.repos).toEqual([{ label: "acme/payments", role: "partial" }]);
    expect(billing.deepDive.files).toEqual([
      { location: "src/transfer.ts:42", repo: "acme/payments", callSite: false },
    ]);
    expect(billing.derivation).toEqual([]);
    expect(billing.path).toEqual([]);
  });

  it("carries nothing for a restricted product but how it is reached", () => {
    const v = impactView();
    v.productNames["p-secret"] = "Secret";
    v.products[5] = {
      ...v.products[5],
      via: "api",
      severity: "high",
      baSummary: "should not show",
      technicalDetail: impactDetail("high", [hop({ from: "p-billing", to: "p-secret" })]),
    };
    const secret = impactGroups(v).affected.find((p) => p.productId === "p-secret")!;
    expect(secret).toMatchObject({
      name: null,
      restricted: true,
      impactKind: "downstream-consumer",
      via: null,
      severity: null,
      summary: "",
      derivation: [],
      path: [],
      deepDive: { repos: [], files: [], contract: null, resources: [] },
    });
  });

  it("says when the server withheld a path", () => {
    const v = impactView();
    v.products[2] = {
      ...v.products[2],
      technicalDetail: { outOfScope: true, impactWithheld: true },
    };
    const ledger = impactGroups(v).affected.find((p) => p.productId === "p-ledger")!;
    expect(ledger.impactWithheld).toBe(true);
    expect(ledger.derivation).toEqual([]);
  });

  it("#1673 — lists a product reached only through a restricted one as affected, last, never not affected", () => {
    const v = impactView();
    v.products[1] = { ...v.products[1], impactKind: "restricted" };
    const { affected, notAffected } = impactGroups(v);
    expect(notAffected.map((p) => p.productId)).not.toContain("p-crm");
    expect(affected.at(-1)).toMatchObject({
      productId: "p-crm",
      name: "CRM",
      restricted: false,
      impactKind: "restricted",
      severity: null,
      impactWithheld: false,
    });
    expect(IMPACT_LABEL.restricted).toBe("Restricted");
  });

  it("names an unreadable hop end plainly", () => {
    const v = impactView();
    delete v.productNames["p-ledger"];
    const warehouse = impactGroups(v).affected.find((p) => p.productId === "p-warehouse")!;
    expect(warehouse.derivation.map((d) => d.label)).toEqual([
      "Billing → a product",
      "A product → Warehouse",
    ]);
  });
});

describe("storedImpact", () => {
  it("reads a well-formed path", () => {
    const p = product("p", "covers", impactDetail("low", [hop({ from: "a", to: "b" })]));
    expect(storedImpact(p)?.hops).toHaveLength(1);
  });

  it("refuses a malformed path whole, rather than showing part of it", () => {
    const bad = (over: Record<string, unknown>) =>
      product("p", "covers", impactDetail("low", [hop({ from: "a", to: "b", ...over })]));
    expect(storedImpact(bad({ confidence: "high" }))).toBeNull();
    expect(storedImpact(bad({ consumer: null }))).toBeNull();
    expect(storedImpact(bad({ resource: { kind: 1 } }))).toBeNull();
    expect(storedImpact(bad({ callSites: [{ filePath: "a", line: "1" }] }))).toBeNull();
    expect(storedImpact(bad({ contract: { version: 1, items: [{ id: "x" }] } }))).toBeNull();
    expect(storedImpact(bad({ sharedObjects: [{ objectName: "t" }] }))).toBeNull();
    expect(
      storedImpact(bad({ severity: { severity: "low", base: "low", modifiers: [{}] } })),
    ).toBeNull();
    expect(storedImpact(product("p", "covers", { impact: { severity: 3, hops: [] } }))).toBeNull();
    expect(storedImpact(product("p", "covers", {}))).toBeNull();
  });

  it("defaults the hidden edge count", () => {
    const p = product("p", "covers", { impact: { severity: null, hops: [] } });
    expect(storedImpact(p)).toEqual({ severity: null, hiddenEdgeCount: 0, hops: [] });
  });
});

describe("viaLabel", () => {
  it("names each integration kind in words, and passes an unknown one through", () => {
    expect(
      ["api", "event", "database", "shared-library", "identity", "grpc"].map(viaLabel),
    ).toEqual([
      "an API",
      "an event",
      "a shared database",
      "a shared library",
      "shared identity",
      "grpc",
    ]);
    expect(viaLabel(null)).toBeNull();
  });
});
