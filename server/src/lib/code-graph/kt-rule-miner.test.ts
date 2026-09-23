/**
 * Unit tests for the Kotlin rule miner (#159).
 *
 * One fixture per rule kind, plus false-positive guards (a logging-only `if`
 * is not a rule; `logger.error(...)` is not Kotlin's `error()`).
 */
import { describe, expect, it } from "vitest";
import { mineKtRules, renderMinedKtRules, type MinedKtRule } from "./kt-rule-miner.js";

const FILE = "src/main/kotlin/com/acme/orders/OrderService.kt";

function byKind(rules: MinedKtRule[], k: MinedKtRule["kind"]): MinedKtRule[] {
  return rules.filter((r) => r.kind === k);
}

describe("mineKtRules — preconditions", () => {
  it("mines require/check with lazy messages, and the NotNull forms", () => {
    const src = [
      `fun place(order: Order) {`,
      `    require(order.total > 0) { "Order total must be positive" }`,
      `    check(inventory.isOpen())`,
      `    val customer = requireNotNull(order.customer) { "customer is required" }`,
      `    checkNotNull(session)`,
      `}`,
    ].join("\n");
    const p = byKind(mineKtRules(src, FILE, 20, "OrderService.place"), "precondition");
    expect(p.map((r) => r.summary)).toEqual([
      "require(order.total > 0): Order total must be positive",
      "check(inventory.isOpen())",
      "requireNotNull(order.customer): customer is required",
      "checkNotNull(session)",
    ]);
    expect(p[0].line).toBe(21);
    expect(p[0].context).toBe("OrderService.place");
  });

  it("does not read a member call named check as a precondition", () => {
    expect(byKind(mineKtRules(`validator.check(order)`, FILE, 1), "precondition")).toEqual([]);
  });

  it("mines error() as a failure mode but not logger.error()", () => {
    const src = [`else -> error("Unknown channel")`, `logger.error("failed to ship")`].join("\n");
    const t = byKind(mineKtRules(src, FILE, 1), "throw");
    expect(t.map((r) => r.summary)).toEqual(["Fails with IllegalStateException: Unknown channel"]);
  });
});

describe("mineKtRules — guards and throws", () => {
  it("mines a braced if whose body throws, and the throw itself", () => {
    const src = [
      `if (order.items.size > MAX_ITEMS) {`,
      `    throw IllegalArgumentException("Too many items")`,
      `}`,
    ].join("\n");
    const rules = mineKtRules(src, FILE, 1);
    expect(byKind(rules, "guard").map((r) => r.summary)).toEqual([
      "Rejects/exits when order.items.size > MAX_ITEMS",
    ]);
    expect(byKind(rules, "throw").map((r) => r.summary)).toEqual([
      "Throws IllegalArgumentException: Too many items",
    ]);
  });

  it("mines inline and next-line guards that return early", () => {
    const src = [
      `if (cart.isEmpty()) return Result.Empty`,
      `if (!user.isVerified)`,
      `    return`,
    ].join("\n");
    const g = byKind(mineKtRules(src, FILE, 1), "guard");
    expect(g.map((r) => r.summary)).toEqual([
      "Rejects when cart.isEmpty()",
      "Rejects/exits when !user.isVerified",
    ]);
  });

  it("mines elvis guards", () => {
    const src = [
      `val account = repo.find(id) ?: throw NotFoundException("No account $id")`,
      `val sku = item.sku ?: return`,
    ].join("\n");
    const rules = mineKtRules(src, FILE, 1);
    expect(byKind(rules, "guard").map((r) => r.summary)).toEqual([
      "Rejects when `repo.find(id)` is null",
      "Rejects when `item.sku` is null",
    ]);
    expect(byKind(rules, "throw").map((r) => r.summary)).toEqual([
      "Throws NotFoundException: No account $id",
    ]);
  });

  it("does not mine an ordinary non-exiting, non-threshold if", () => {
    const src = [`if (order.isGift) {`, `    order.wrap()`, `}`].join("\n");
    expect(mineKtRules(src, FILE, 1)).toEqual([]);
  });
});

describe("mineKtRules — constants in comparisons", () => {
  it("mines braced, inline and expression ifs that compare against constants", () => {
    const src = [
      `if (order.total >= FREE_SHIPPING_THRESHOLD) {`,
      `    order.shippingFee = 0`,
      `}`,
      `if (points > 1000) upgrade(customer)`,
      `val fee = if (total > 50) 0 else 5`,
      `if (order.status == OrderStatus.CANCELLED) {`,
      `    refund(order)`,
      `}`,
      `if (age in 13..17) {`,
      `    applyTeenPolicy()`,
      `}`,
    ].join("\n");
    const g = byKind(mineKtRules(src, FILE, 1), "guard");
    expect(g.map((r) => r.summary)).toEqual([
      "Branches on threshold order.total >= FREE_SHIPPING_THRESHOLD",
      "Branches on threshold points > 1000",
      "Branches on threshold total > 50",
      "Branches on threshold order.status == OrderStatus.CANCELLED",
      "Branches on threshold age in 13..17",
    ]);
  });

  it("does not mine an if expression without a constant comparison", () => {
    expect(mineKtRules(`val label = if (isGift) "gift" else "std"`, FILE, 1)).toEqual([]);
  });

  it("mines const val and upper-case val declarations", () => {
    const src = [
      `const val MAX_ITEMS = 50`,
      `private const val VAT_RATE: Double = 0.2`,
      `val DEFAULT_CURRENCY = "EUR"`,
      `val total = 5`,
    ].join("\n");
    const c = byKind(mineKtRules(src, FILE, 1), "const");
    expect(c.map((r) => r.summary)).toEqual([
      "Constant `MAX_ITEMS` = 50",
      "Constant `VAT_RATE` = 0.2",
      'Constant `DEFAULT_CURRENCY` = "EUR"',
    ]);
  });
});

describe("mineKtRules — false-positive guards", () => {
  it("does not mine an if whose body only logs, even across a multi-line lambda", () => {
    const src = [
      `if (retries > 3) {`,
      `    logger.warn { "retried $retries times" }`,
      `}`,
      `if (elapsed > 1000) {`,
      `    log.debug(`,
      `        "slow path {}",`,
      `        elapsed,`,
      `    )`,
      `    println("slow")`,
      `}`,
      `if (count > 0) logger.info("processed $count")`,
    ].join("\n");
    expect(mineKtRules(src, FILE, 1)).toEqual([]);
  });

  it("still mines a threshold if whose body logs AND acts", () => {
    const src = [
      `if (retries > 3) {`,
      `    logger.warn { "giving up" }`,
      `    order.markFailed()`,
      `}`,
    ].join("\n");
    expect(byKind(mineKtRules(src, FILE, 1), "guard")).toHaveLength(1);
  });

  it("ignores comment lines", () => {
    expect(mineKtRules(`// require(x > 0)`, FILE, 1)).toEqual([]);
  });
});

describe("mineKtRules — when on status/enum", () => {
  it("mines a when with subject, splitting comma-joined arms and skipping else", () => {
    const src = [
      `when (order.status) {`,
      `    OrderStatus.PENDING -> confirm(order)`,
      `    OrderStatus.SHIPPED, OrderStatus.DELIVERED -> {`,
      `        items.forEach { item -> audit(item) }`,
      `    }`,
      `    else -> Unit`,
      `}`,
    ].join("\n");
    const w = byKind(mineKtRules(src, FILE, 1), "when-branch");
    expect(w.map((r) => r.summary)).toEqual([
      "State dispatch on `order.status` with 3 branches: OrderStatus.PENDING, OrderStatus.SHIPPED, OrderStatus.DELIVERED",
    ]);
  });

  it("mines a when bound with val and used as an expression", () => {
    const src = [
      `val discount = when (val tier = customer.tier) {`,
      `    Tier.GOLD -> 0.15`,
      `    Tier.SILVER -> 0.05`,
      `    else -> 0.0`,
      `}`,
    ].join("\n");
    const w = byKind(mineKtRules(src, FILE, 1), "when-branch");
    expect(w.map((r) => r.summary)).toEqual([
      "State dispatch on `customer.tier` with 2 branches: Tier.GOLD, Tier.SILVER",
    ]);
  });

  it("records constant-comparing arms of a subject-less when as threshold guards", () => {
    const src = [
      `val grade = when {`,
      `    score >= 90 -> "A"`,
      `    score >= PASS_MARK -> "B"`,
      `    isRetake -> "R"`,
      `    else -> "F"`,
      `}`,
    ].join("\n");
    const rules = mineKtRules(src, FILE, 1);
    expect(byKind(rules, "when-branch")).toEqual([]);
    const g = byKind(rules, "guard");
    expect(g.map((r) => r.summary)).toEqual([
      "Branches on threshold score >= 90",
      "Branches on threshold score >= PASS_MARK",
    ]);
    expect(g.map((r) => r.line)).toEqual([2, 3]);
  });
});

describe("mineKtRules — validation annotations", () => {
  it("mines annotations with use-site targets on constructor parameters", () => {
    const src = [
      `data class OrderRequest(`,
      `    @field:NotBlank val customerId: String,`,
      `    @field:Min(1) @field:Max(100) val quantity: Int,`,
      `    @get:Pattern(regexp = "^[A-Z]{3}-\\\\d{4}$") val sku: String,`,
      `    @Valid val address: Address,`,
      `    @JsonProperty("note") val note: String?,`,
      `)`,
    ].join("\n");
    const a = byKind(mineKtRules(src, FILE, 1), "annotation-validation");
    expect(a.map((r) => r.summary)).toEqual([
      "Field must not be blank",
      "Numeric bound: Min 1",
      "Numeric bound: Max 100",
      'Regex constraint: regexp = "^[A-Z]{3}-\\\\d{4}$"',
      "Cascade validation to nested object",
    ]);
    expect(a.map((r) => r.line)).toEqual([2, 3, 3, 4, 5]);
  });

  it("summarises size and email annotations", () => {
    const a = byKind(
      mineKtRules(`@field:Size(min = 2, max = 50) @field:Email val email: String`, FILE, 1),
      "annotation-validation",
    );
    expect(a.map((r) => r.summary)).toEqual([
      "Length/size constraint: min = 2, max = 50",
      "Must be a valid email address",
    ]);
  });
});

describe("renderMinedKtRules", () => {
  it("returns an empty string for no rules", () => {
    expect(renderMinedKtRules([])).toBe("");
  });

  it("groups by kind in a fixed order", () => {
    const rules = mineKtRules(
      [`const val MAX = 5`, `@field:NotBlank val name: String`, `require(x > 0)`].join("\n"),
      FILE,
      1,
    );
    const out = renderMinedKtRules(rules);
    expect(out.indexOf("Validation annotations")).toBeLessThan(out.indexOf("Preconditions"));
    expect(out.indexOf("Preconditions")).toBeLessThan(out.indexOf("Constants"));
    expect(out).toContain("- L3: require(x > 0)");
  });

  it("truncates to the prompt budget", () => {
    const src = Array.from({ length: 50 }, (_, i) => `const val LIMIT_${i} = ${i}`).join("\n");
    const out = renderMinedKtRules(mineKtRules(src, FILE, 1), 200);
    expect(out).toContain("more Kotlin rules truncated");
  });
});

describe("mineKtRules — linear time on long lines (ReDoS)", () => {
  it("mines adversarial 5,000-character lines well inside a second", () => {
    // Each input defeated an earlier regex here — `require\((.*?)\)\s*(?:\{\s*(.*?)\s*\}\s*)?$`
    // and a `^\s*(.+?)\s*->` when-arm were cubic; an unanchored elvis receiver
    // was quadratic.
    const n = 5000;
    const inputs = [
      `require(x) {${" ".repeat(n)}x`,
      `when (a) {\n${" ".repeat(n)}x`,
      `x${" ?: ".repeat(n / 4)}`,
      `[${"Required(".repeat(n / 9)}`,
      `if (a) b${" ".repeat(n)}c`,
    ];
    const start = performance.now();
    for (const src of inputs) mineKtRules(src, FILE, 1);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("mines adversarial 80,000-character lines well inside a second (quadratic shapes)", () => {
    // An elvis receiver matched from every position (and its argument scan
    // running to end-of-line) was quadratic: seconds at this length.
    const n = 80_000;
    const inputs = [`${"a".repeat(n)} ?`, "a(".repeat(n / 2)];
    const start = performance.now();
    for (const src of inputs) mineKtRules(src, FILE, 1);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
