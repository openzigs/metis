import { describe, expect, it } from "vitest";
import type { AIProvider } from "../ai/types.js";
import {
  recoverAffectedTables,
  RECOVERY_CONFIDENCE,
  type CatalogTable,
} from "./table-relevance-judge-recovery.js";

const CATALOG: CatalogTable[] = [
  { tableName: "account", columns: ["addr1", "city", "state", "zip", "country", "phone"] },
  { tableName: "orders", columns: ["orderid", "billaddr1", "shipaddr1", "totalprice"] },
  { tableName: "profile", columns: ["langpref", "favcategory"] },
];

/** Mock provider returning the given contents in sequence (one per judge sample). */
function mockProvider(replies: string[], opts: { offline?: boolean } = {}): AIProvider {
  let i = 0;
  return {
    offline: opts.offline ?? false,
    chat: async () => ({ content: replies[Math.min(i++, replies.length - 1)] }),
  } as unknown as AIProvider;
}

const REQ = "loyalty points shown alongside the shopper's saved billing and delivery details";

describe("recoverAffectedTables (#1029)", () => {
  it("recovers a table voted by >=3 of 5 samples as a possible-tier llm-recovery row", async () => {
    // candidates (surfaced empty) = [account(0), orders(1), profile(2)] in catalog order.
    // account in 3 samples, orders in 1 -> only account clears the 3-of-5 threshold.
    const p = mockProvider([
      '{"tables":[{"index":0}]}',
      '{"tables":[{"index":0},{"index":1}]}',
      '{"tables":[{"index":0}]}',
      '{"tables":[]}',
      '{"tables":[]}',
    ]);
    const rows = await recoverAffectedTables({
      requirementText: REQ,
      surfacedTableNames: [],
      catalog: CATALOG,
      provider: p,
      options: { enabled: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tableName: "account",
      objectKind: "table",
      relevanceTier: "possible",
      source: "llm-recovery",
      changeKind: "reference",
      columnName: null,
      confidence: RECOVERY_CONFIDENCE,
    });
    expect(rows[0].relevanceRationale).toBeTruthy();
  });

  it("excludes already-surfaced tables from candidates (qualifier/case-insensitive)", async () => {
    // account is surfaced as a schema-qualified, upper-cased name; index 0 is now orders.
    const five = Array(5).fill('{"tables":[{"index":0}]}');
    const rows = await recoverAffectedTables({
      requirementText: REQ,
      surfacedTableNames: ["public.ACCOUNT"],
      catalog: CATALOG,
      provider: mockProvider(five),
      options: { enabled: true },
    });
    expect(rows.map((r) => r.tableName)).toEqual(["orders"]);
  });

  it("returns [] when every catalog table is already surfaced", async () => {
    const rows = await recoverAffectedTables({
      requirementText: REQ,
      surfacedTableNames: ["account", "orders", "profile"],
      catalog: CATALOG,
      provider: mockProvider(['{"tables":[{"index":0}]}']),
      options: { enabled: true },
    });
    expect(rows).toEqual([]);
  });

  it("passes through when disabled and never throws when the provider throws", async () => {
    const disabled = await recoverAffectedTables({
      requirementText: REQ,
      surfacedTableNames: [],
      catalog: CATALOG,
      provider: mockProvider(['{"tables":[{"index":0}]}']),
      options: { enabled: false },
    });
    expect(disabled).toEqual([]);
    const throwing = {
      offline: false,
      chat: async () => {
        throw new Error("boom");
      },
    } as unknown as AIProvider;
    const errored = await recoverAffectedTables({
      requirementText: REQ,
      surfacedTableNames: [],
      catalog: CATALOG,
      provider: throwing,
      options: { enabled: true },
    });
    expect(errored).toEqual([]);
  });
});
