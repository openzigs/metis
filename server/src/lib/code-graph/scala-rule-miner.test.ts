/**
 * Issue #161 — Scala rule miner. Synthetic fixtures only.
 */
import { describe, expect, it } from "vitest";
import { BODY_LOOKAHEAD } from "./rule-miner-brace-shared.js";
import { mineScalaRules, renderMinedScalaRules, SCALA_RULE_KINDS } from "./scala-rule-miner.js";

const FILE = "src/main/scala/example/OrderService.scala";

const SERVICE = `object OrderService {
  val MaxItems = 50
  final val MIN_TOTAL: BigDecimal = 0.01
  private val FreeShippingLimit = 100
  val greeting = "hello"

  def place(order: Order): Order = {
    require(order.items.nonEmpty, "an order needs at least one item")
    assert(order.total >= MIN_TOTAL)
    if (order.items.size > MaxItems) {
      throw new IllegalArgumentException("too many items")
    }
    if (order.customer == null) return order
    if (order.total > 1000) {
      logger.info("large order")
    }
    val fee = if (order.total > FreeShippingLimit) 0 else 5
    order.status match {
      case OrderStatus.Open => approve(order)
      case OrderStatus.Held | OrderStatus.Review => hold(order)
      case _ => order
    }
  }

  def pay(amount: BigDecimal): Either[String, BigDecimal] =
    if (amount <= 0) Left("amount must be positive") else Right(amount)

  def total(xs: List[Int]): Int = xs.sum.ensuring(_ >= 0)

  def fail(): Nothing = sys.error("unreachable state")
}
`;

const byKind = (src: string, kind: string) =>
  mineScalaRules(src, FILE, 1).filter((r) => r.kind === kind);

describe("mineScalaRules — fixture", () => {
  const rules = mineScalaRules(SERVICE, FILE, 1, "OrderService");

  it("mines capitalised literal vals as constants, not other vals", () => {
    expect(byKind(SERVICE, "const").map((r) => r.summary)).toEqual([
      "Constant `MaxItems` = 50",
      "Constant `MIN_TOTAL` = 0.01",
      "Constant `FreeShippingLimit` = 100",
    ]);
  });

  it("mines require / assert / ensuring with their messages", () => {
    expect(byKind(SERVICE, "precondition").map((r) => [r.line, r.summary])).toEqual([
      [8, "require(order.items.nonEmpty): an order needs at least one item"],
      [9, "assert(order.total >= MIN_TOTAL)"],
      [28, "Postcondition ensuring(_ >= 0)"],
    ]);
  });

  it("mines guards that exit, thresholds, and skips a logging-only if", () => {
    expect(byKind(SERVICE, "guard").map((r) => [r.line, r.summary])).toEqual([
      [10, "Rejects/exits when order.items.size > MaxItems"],
      [13, "Rejects when order.customer == null"],
      [17, "Branches on threshold order.total > FreeShippingLimit"],
      [26, "Rejects when amount <= 0"],
    ]);
  });

  it("mines throws and sys.error", () => {
    expect(byKind(SERVICE, "throw").map((r) => [r.line, r.summary])).toEqual([
      [11, "Throws IllegalArgumentException: too many items"],
      [30, "Fails with RuntimeException: unreachable state"],
    ]);
  });

  it("mines a match on enum values as one dispatch rule, without the wildcard", () => {
    expect(byKind(SERVICE, "match-branch")).toEqual([
      expect.objectContaining({
        line: 18,
        summary:
          "State dispatch on `order.status` with 3 branches: OrderStatus.Open, OrderStatus.Held, OrderStatus.Review",
      }),
    ]);
  });

  it("records file, context and 1-based lines offset by baseLine", () => {
    expect(rules.every((r) => r.filePath === FILE && r.context === "OrderService")).toBe(true);
    const shifted = mineScalaRules(SERVICE, FILE, 101);
    expect(shifted[0].line).toBe(rules[0].line + 100);
  });
});

describe("mineScalaRules — match arms", () => {
  it("mines a guarded arm as a threshold branch and ignores destructuring", () => {
    const src = [
      "def band(total: Int, o: Option[Int]) = {",
      "  total match {",
      "    case t if t > 100 => 1",
      "    case _ => 0",
      "  }",
      "  o match {",
      "    case Some(x) => x",
      "    case None => 0",
      "  }",
      "}",
    ].join("\n");
    const rules = mineScalaRules(src, FILE, 1);
    expect(rules.map((r) => [r.kind, r.line, r.summary])).toEqual([
      ["guard", 3, "Branches on threshold t > 100"],
    ]);
  });

  it("drops a case class payload from the label and ignores type patterns", () => {
    const src = [
      "event match {",
      "  case Paid(amount) => settle(amount)",
      '  case "cancelled" => cancel()',
      "  case e: Refund => refund(e)",
      "}",
    ].join("\n");
    expect(byKind(src, "match-branch").map((r) => r.summary)).toEqual([
      'State dispatch on `event` with 2 branches: Paid, "cancelled"',
    ]);
  });

  it("does not read a nested match's arms as the outer match's", () => {
    const src = [
      "a match {",
      "  case Status.A =>",
      "    b match {",
      "      case Kind.X => 1",
      "    }",
      "  case Status.B => 2",
      "}",
    ].join("\n");
    const summaries = byKind(src, "match-branch").map((r) => r.summary);
    expect(summaries).toEqual([
      "State dispatch on `a` with 2 branches: Status.A, Status.B",
      "State dispatch on `b` with 1 branches: Kind.X",
    ]);
  });
});

describe("mineScalaRules — Scala 3 and multi-line forms (#170 shapes)", () => {
  it("mines `if cond then` guards", () => {
    const src = 'if qty <= 0 then throw IllegalStateException("qty") else qty';
    expect(byKind(src, "guard").map((r) => r.summary)).toEqual(["Rejects when qty <= 0"]);
    expect(byKind(src, "throw").map((r) => r.summary)).toEqual([
      "Throws IllegalStateException: qty",
    ]);
  });

  it("mines a require whose condition spans lines, anchored at its first line", () => {
    const src = [
      "require(",
      "  order.total > 0 &&",
      "    order.total < MaxTotal,",
      '  "total out of range"',
      ")",
    ].join("\n");
    expect(mineScalaRules(src, FILE, 7)).toEqual([
      expect.objectContaining({
        kind: "precondition",
        line: 7,
        summary: "require(order.total > 0 && order.total < MaxTotal): total out of range",
      }),
    ]);
  });

  it("mines an if whose condition spans lines and whose body is on the next line", () => {
    const src = [
      "if (order.total > Limit &&",
      "    order.express) {",
      '  throw new LimitException("limit")',
      "}",
    ].join("\n");
    expect(byKind(src, "guard")).toEqual([
      expect.objectContaining({
        line: 1,
        summary: "Rejects/exits when order.total > Limit && order.express",
      }),
    ]);
  });

  it("reads a throw's message from the following line", () => {
    const src = ["throw new ValidationException(", '  "missing customer"', ")"].join("\n");
    expect(byKind(src, "throw").map((r) => r.summary)).toEqual([
      "Throws ValidationException: missing customer",
    ]);
  });

  it("keeps a guard whose body logs before it exits", () => {
    const src = ["if (qty > MaxQty) {", '  log.warn("too many")', "  return None", "}"].join("\n");
    expect(byKind(src, "guard").map((r) => r.summary)).toEqual(["Rejects/exits when qty > MaxQty"]);
  });
});

describe("mineScalaRules — bounds", () => {
  it("honours maxRules", () => {
    const src = Array.from({ length: 50 }, (_, k) => `val Limit${k} = ${k}`).join("\n");
    expect(mineScalaRules(src, FILE, 1)).toHaveLength(50);
    expect(mineScalaRules(src, FILE, 1, null, 10)).toHaveLength(10);
  });

  it("stays linear on adversarial long lines (ReDoS)", () => {
    const n = 20_000;
    const inputs = [
      `val Max${" ".repeat(n)}x`,
      `val X: ${":".repeat(n)}`,
      `require(${"(".repeat(n)}`,
      `if (a) b${" ".repeat(n)}c`,
      `x match {\n${" ".repeat(n)}x`,
      `if a${" ".repeat(n)} then`,
      `throw new ${"A".repeat(n)}(`,
      `if (x == ${'"'.repeat(n)})`,
      `${"a".repeat(n)} match {`,
      `if (a) { ${"case X => ".repeat(n / 10)} }`,
    ];
    const start = performance.now();
    for (const src of inputs) mineScalaRules(src, FILE, 1);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  // Per physical line, the work is bounded by constants: the #170 joiner reads
  // at most MAX_CONTINUATION_LINES lines (proved in rule-miner-continuation.test.ts)
  // and every body / arm scan at most BODY_LOOKAHEAD lines (proved here), so a
  // file is mined in linear time. Counting, not timing, so it cannot flake
  // under load (#1379).
  it("reads a dispatch block's arms no further than BODY_LOOKAHEAD lines (linear bound)", () => {
    const filler = Array.from({ length: BODY_LOOKAHEAD + 20 }, () => "  work()");
    const early = [
      "x match {",
      "  case Status.Early =>",
      ...filler,
      "  case Status.Late =>",
      "}",
    ].join("\n");
    const labels = mineScalaRules(early, FILE, 1).find((r) => r.kind === "match-branch")!.summary;
    expect(labels).toMatch(/Early|EARLY/);
    expect(labels).not.toMatch(/Late|LATE/);
  });
});

describe("renderMinedScalaRules", () => {
  it("renders every kind the miner produces, grouped, with L<line> prefixes", () => {
    const out = renderMinedScalaRules(mineScalaRules(SERVICE, FILE, 1), 100_000);
    for (const kind of SCALA_RULE_KINDS) {
      expect(mineScalaRules(SERVICE, FILE, 1).some((r) => r.kind === kind)).toBe(true);
    }
    expect(out).toContain("### Preconditions (require / assert / ensuring) (3)");
    expect(out).toContain("### State machines (match) (1)");
    expect(out).toContain("- L8: require(order.items.nonEmpty): an order needs at least one item");
    expect(out.match(/^- L\d+:/gm)).toHaveLength(mineScalaRules(SERVICE, FILE, 1).length);
  });

  it("marks truncation when the budget runs out, and renders nothing for no rules", () => {
    expect(renderMinedScalaRules([], 100)).toBe("");
    expect(renderMinedScalaRules(mineScalaRules(SERVICE, FILE, 1), 60)).toContain(
      "more Scala rules truncated",
    );
  });
});
