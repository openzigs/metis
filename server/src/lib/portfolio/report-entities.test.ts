/**
 * #1624 — the entity post-check on report prose, and its sanitiser.
 */
import { describe, expect, it } from "vitest";
import {
  EntityIndex,
  checkProse,
  entityCandidates,
  isEntityShaped,
  sanitizeProse,
  sentences,
} from "./report-entities.js";

const index = new EntityIndex({
  products: new Map([
    ["p1", "Orders"],
    ["p2", "Storefront"],
    ["p3", "Customer Portal"],
  ]),
  texts: ["Refunds must post to the ledger_entries table within 2 seconds"],
});

describe("sentences", () => {
  it("ends a sentence at . ! or ? before whitespace, not inside a file name", () => {
    expect(sentences("Orders changes. Does Storefront? Yes! See index.ts now")).toEqual([
      "Orders changes.",
      "Does Storefront?",
      "Yes!",
      "See index.ts now",
    ]);
    expect(sentences("  ")).toEqual([]);
  });
});

describe("isEntityShaped", () => {
  it.each([
    ["acme/payments-gateway", true],
    ["src/billing/refund.ts", true],
    ["a/b/c", true],
    ["refund.ts", true],
    ["schema.graphql", true],
    ["payments-gateway", true],
    ["ledger-core", true],
    ["service-2", true],
    ["order_items", true],
    ["PaymentsGateway", true],
    ["ordersApi", true],
    ["x".repeat(201), true],
    ["read/write", false],
    ["and/or", false],
    ["real-time", false],
    ["end-to-end", false],
    ["e.g", false],
    ["Orders", false],
    ["API", false],
    ["a", false],
  ])("%s -> %s", (token, shaped) => {
    expect(isEntityShaped(token)).toBe(shaped);
  });
});

describe("entityCandidates", () => {
  it("finds backticked spans, shaped tokens and names before a component noun", () => {
    expect(entityCandidates("The `billing-svc` change touches acme/pay-gw.")).toEqual(
      expect.arrayContaining(["billing-svc", "acme/pay-gw"]),
    );
    expect(entityCandidates("The Payments product and the Orders service change.")).toEqual([
      "Payments",
      "Orders",
    ]);
    expect(entityCandidates("Then the ledger-core repo breaks.")).toEqual([
      "ledger-core",
      "ledger-core",
    ]);
    // A leading stopword is not part of the name.
    expect(entityCandidates("Affected Storefront app users see it.")).toEqual(["Storefront"]);
    // A lowercase word before the noun names nothing.
    expect(entityCandidates("Every downstream product is affected.")).toEqual([]);
    // A name never runs back across the end of a clause.
    expect(entityCandidates("It ships today, Orders service first.")).toEqual(["Orders"]);
  });
});

describe("checkProse", () => {
  it("keeps sentences that name only what the assessment contains, and records the products named", () => {
    const out = checkProse(
      "Orders must change. Storefront consumes the Orders API, so the Storefront app needs a release. Customer Portal is not affected.",
      index,
    );
    expect(out).toEqual({
      text: "Orders must change. Storefront consumes the Orders API, so the Storefront app needs a release. Customer Portal is not affected.",
      stripped: 0,
      mentions: ["p1", "p2", "p3"],
    });
  });

  it.each([
    ["an owner/repo", "The change also touches acme/payments-gateway."],
    ["a bare repo name", "The payments-gateway repo must be redeployed."],
    ["a backticked repo", "Deploy `payments-gateway` after Orders."],
    ["a CamelCase service", "PaymentsGateway service consumes it."],
    ["a file", "Edit src/pay/refund.ts first."],
    ["an unknown product", "The Payments product must change too."],
  ])("drops a sentence naming a hallucinated entity: %s", (_label, hallucinated) => {
    const out = checkProse(`Orders must change. ${hallucinated} Storefront follows.`, index);
    expect(out.text).toBe("Orders must change. Storefront follows.");
    expect(out.stripped).toBe(1);
    expect(out.mentions).toEqual(["p1", "p2"]);
  });

  it("allows what the requirement statement itself names", () => {
    expect(checkProse("Write to ledger_entries on each refund.", index).stripped).toBe(0);
    // A word of the statement may name a component in the prose ("the Refunds service").
    expect(checkProse("The Refunds service posts it.", index).stripped).toBe(0);
    expect(checkProse("The Rebates service posts it.", index).stripped).toBe(1);
  });

  it("treats anything in backticks as code, however it is spelt", () => {
    expect(checkProse("Run `refunder` nightly.", index).stripped).toBe(1);
    expect(checkProse("Run `Orders` nightly.", index).stripped).toBe(0);
  });

  it("matches product names as whole words, case-insensitively", () => {
    expect(checkProse("the reorders queue grows.", index).mentions).toEqual([]);
    expect(checkProse("ORDERS changes.", index).mentions).toEqual(["p1"]);
  });

  it("stays linear on hostile prose", () => {
    const hostile = `${"a.b-c/".repeat(20_000)} ${"Word ".repeat(20_000)}product. ${"x. ".repeat(20_000)}`;
    const start = performance.now();
    checkProse(hostile, index);
    expect(performance.now() - start).toBeLessThan(2_000);
  });
});

describe("sanitizeProse", () => {
  it("strips code, HTML and link brackets, collapses whitespace and caps the length", () => {
    expect(sanitizeProse("A `x` <script>y</script> [link](http://e)\n\n# heading", 200)).toBe(
      "A x script y /script link (http://e) # heading",
    );
    expect(sanitizeProse("abcdef", 3)).toBe("abc");
  });
});
