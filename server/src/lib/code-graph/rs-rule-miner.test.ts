/**
 * Issue #161 — Rust rule miner. Synthetic fixtures only.
 */
import { describe, expect, it } from "vitest";
import { BODY_LOOKAHEAD } from "./rule-miner-brace-shared.js";
import { mineRsRules, renderMinedRsRules, RS_RULE_KINDS } from "./rs-rule-miner.js";

const FILE = "src/orders/service.rs";

const SERVICE = `pub const MAX_ITEMS: usize = 50;
static SERVICE_FEE: f64 = 2.5;
const GREETING: &str = "hello";
const TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Validate)]
pub struct NewOrder {
    #[validate(range(min = 1, max = 100))]
    pub quantity: u32,
    #[validate(email)]
    pub email: String,
}

impl OrderService {
    pub fn place(&self, order: &Order) -> Result<Receipt, OrderError> {
        assert!(!order.items.is_empty(), "an order needs at least one item");
        ensure!(order.total > 0, OrderError::NonPositiveTotal);
        if order.items.len() > MAX_ITEMS {
            return Err(OrderError::TooManyItems);
        }
        if order.total > 10_000 {
            info!("large order");
        }
        let customer = self.customers.get(&order.customer_id).ok_or(OrderError::UnknownCustomer)?;
        let Some(address) = customer.address.as_ref() else {
            return Err(OrderError::NoAddress);
        };
        let fee = if order.total > FREE_SHIPPING { 0.0 } else { SERVICE_FEE };
        match order.status {
            Status::Open => self.approve(order),
            Status::Held | Status::Review => self.hold(order),
            _ => unreachable!("closed orders are never placed"),
        }
    }
}
`;

const byKind = (src: string, kind: string) =>
  mineRsRules(src, FILE, 1).filter((r) => r.kind === kind);

describe("mineRsRules — fixture", () => {
  it("mines const/static literals, not computed constants", () => {
    expect(byKind(SERVICE, "const").map((r) => r.summary)).toEqual([
      "Constant `MAX_ITEMS` = 50",
      "Constant `SERVICE_FEE` = 2.5",
      'Constant `GREETING` = "hello"',
    ]);
  });

  it("mines validator attributes", () => {
    expect(byKind(SERVICE, "annotation-validation").map((r) => [r.line, r.summary])).toEqual([
      [8, "Field validation (validate): range(min = 1, max = 100)"],
      [10, "Field validation (validate): email"],
    ]);
  });

  it("mines assert! and ensure! with their message or error", () => {
    expect(byKind(SERVICE, "precondition").map((r) => [r.line, r.summary])).toEqual([
      [16, "assert!(!order.items.is_empty()): an order needs at least one item"],
      [17, "ensure!(order.total > 0) else OrderError::NonPositiveTotal"],
    ]);
  });

  it("mines guards, ok_or and let-else, skipping a logging-only if", () => {
    expect(byKind(SERVICE, "guard").map((r) => [r.line, r.summary])).toEqual([
      [18, "Rejects/exits when order.items.len() > MAX_ITEMS"],
      [
        24,
        "Rejects when `self.customers.get(&order.customer_id)` is absent: OrderError::UnknownCustomer",
      ],
      [25, "Rejects unless `Some(address) = customer.address.as_ref()` matches"],
      [28, "Branches on threshold order.total > FREE_SHIPPING"],
    ]);
  });

  it("mines Err returns and panicking macros as failure modes", () => {
    expect(byKind(SERVICE, "throw").map((r) => [r.line, r.summary])).toEqual([
      [19, "Returns error OrderError::TooManyItems"],
      [26, "Returns error OrderError::NoAddress"],
      [32, "Fails (unreachable!): closed orders are never placed"],
    ]);
  });

  it("mines a match on enum variants as one dispatch rule", () => {
    expect(byKind(SERVICE, "match-branch").map((r) => [r.line, r.summary])).toEqual([
      [
        29,
        "State dispatch on `order.status` with 3 branches: Status::Open, Status::Held, Status::Review",
      ],
    ]);
  });
});

describe("mineRsRules — match arms", () => {
  it("mines guarded arms, ignores Some/None/Ok/Err, and drops payloads", () => {
    const src = [
      "match total {",
      "    t if t > 100 => 1,",
      "    _ => 0,",
      "}",
      "match lookup(id) {",
      "    Some(o) => o,",
      "    None => return,",
      "}",
      "match event {",
      "    Event::Paid { amount } => settle(amount),",
      "    Event::Refunded(r) => refund(r),",
      "    0..=9 => small(),",
      "}",
    ].join("\n");
    const rules = mineRsRules(src, FILE, 1);
    expect(rules.map((r) => [r.kind, r.line, r.summary])).toEqual([
      ["guard", 2, "Branches on threshold t > 100"],
      [
        "match-branch",
        9,
        "State dispatch on `event` with 3 branches: Event::Paid, Event::Refunded, 0..=9",
      ],
    ]);
  });

  it("reads an arm whose alternatives continue on the next line", () => {
    const src = [
      "match s {",
      "    Status::A |",
      "    Status::B => 1,",
      "    Status::C => 2,",
      "}",
    ].join("\n");
    expect(byKind(src, "match-branch").map((r) => r.summary)).toEqual([
      "State dispatch on `s` with 3 branches: Status::A, Status::B, Status::C",
    ]);
  });

  it("ignores braces inside strings and a nested match's arms", () => {
    const src = [
      "match a {",
      '    Kind::X => println!("{}", "}"),',
      "    Kind::Y => match b {",
      "        Mode::M => 1,",
      "    },",
      "    Kind::Z => 3,",
      "}",
    ].join("\n");
    expect(byKind(src, "match-branch").map((r) => r.summary)).toEqual([
      "State dispatch on `a` with 3 branches: Kind::X, Kind::Y, Kind::Z",
      "State dispatch on `b` with 1 branches: Mode::M",
    ]);
  });
});

describe("mineRsRules — multi-line and inline forms (#170 shapes)", () => {
  it("mines an if whose condition spans lines, anchored at its first line", () => {
    const src = [
      "if order.total > LIMIT",
      "    && order.express",
      "{",
      '    bail!("over the express limit");',
      "}",
    ].join("\n");
    const rules = mineRsRules(src, FILE, 3);
    expect(rules.map((r) => [r.kind, r.line, r.summary])).toEqual([
      ["guard", 3, "Rejects/exits when order.total > LIMIT && order.express"],
      ["throw", 6, "Fails (bail!): over the express limit"],
    ]);
  });

  it("mines an assert_eq! whose arguments span lines", () => {
    const src = [
      "assert_eq!(",
      "    order.currency,",
      "    Currency::Eur,",
      '    "only euro orders"',
      ");",
    ].join("\n");
    expect(byKind(src, "precondition").map((r) => r.summary)).toEqual([
      "assert_eq!(order.currency == Currency::Eur): only euro orders",
    ]);
  });

  it("mines inline guards and inline threshold branches", () => {
    const src = [
      "if qty == 0 { return Err(Error::Empty) }",
      "if qty > MAX_QTY { 1 } else { 0 }",
      'if debug { println!("x") }',
    ].join("\n");
    expect(byKind(src, "guard").map((r) => r.summary)).toEqual([
      "Rejects when qty == 0",
      "Branches on threshold qty > MAX_QTY",
    ]);
  });

  it("does not mine `if let` as a guard", () => {
    expect(byKind("if let Some(x) = y {\n    return x;\n}", "guard")).toEqual([]);
  });
});

describe("mineRsRules — bounds", () => {
  it("honours maxRules", () => {
    const src = Array.from({ length: 30 }, (_, k) => `const LIMIT_${k}: u32 = ${k};`).join("\n");
    expect(mineRsRules(src, FILE, 1)).toHaveLength(30);
    expect(mineRsRules(src, FILE, 1, null, 5)).toHaveLength(5);
  });

  it("stays linear on adversarial long lines (ReDoS)", () => {
    const n = 20_000;
    const inputs = [
      `const A${" ".repeat(n)}x`,
      `pub(${" ".repeat(n)}`,
      `assert!(${"(".repeat(n)}`,
      `if a${" ".repeat(n)}`,
      `match ${"(".repeat(n)}`,
      `let x = y${" ".repeat(n)} else`,
      `#[validate(${"(".repeat(n)}`,
      `x.ok_or(${"(".repeat(n)}`,
      `panic!(${'"'.repeat(n)}`,
      `if x == ${"'".repeat(n)} {`,
      `match a {\n${"A | ".repeat(n / 4)}`,
    ];
    const start = performance.now();
    for (const src of inputs) mineRsRules(src, FILE, 1);
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
      "match x {",
      "    Status::Early => 1,",
      ...filler,
      "    Status::Late => 1,",
      "}",
    ].join("\n");
    const labels = mineRsRules(early, FILE, 1).find((r) => r.kind === "match-branch")!.summary;
    expect(labels).toMatch(/Early|EARLY/);
    expect(labels).not.toMatch(/Late|LATE/);
  });
});

describe("renderMinedRsRules", () => {
  it("renders every kind the miner produces", () => {
    const rules = mineRsRules(SERVICE, FILE, 1);
    for (const kind of RS_RULE_KINDS) expect(rules.some((r) => r.kind === kind)).toBe(true);
    const out = renderMinedRsRules(rules, 100_000);
    expect(out.match(/^- L\d+:/gm)).toHaveLength(rules.length);
    expect(out).toContain("### Failure modes (Err / panic! / bail!) (3)");
    expect(renderMinedRsRules(rules, 50)).toContain("more Rust rules truncated");
  });
});
